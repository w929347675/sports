import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { exportDatabase, getSchemaVersion, snapshotDatabase } from '@fitness-coach/db';
import type { ServiceContext } from './context.js';

const backupFormat = 'fitness-coach-backup';
const manifestFilename = 'manifest.json';
const schemaFilename = 'schema-version.json';
const databaseFilename = 'database/fitness-coach.sqlite';
const forbiddenNames = new Set(['model-api-key.secret', '.env', 'runtime-config.json']);

export type BackupManifest = {
  format: typeof backupFormat;
  version: 1;
  created_at: string;
  schema_version: number;
  includes_images: boolean;
  files: Array<{ path: string; size: number; sha256: string }>;
};

type ArchiveEntry = { path: string; bytes: Buffer };

function failUnsafe(message = 'Unsafe backup path') {
  throw new Error(message);
}

function safeRelativePath(path: string) {
  if (!path || path.startsWith('/') || path.includes('\0') || path.includes('\\')) failUnsafe();
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) failUnsafe();
  if (parts.includes('backups') || parts.some((part) => forbiddenNames.has(part) || part.endsWith('.secret') || part.startsWith('.env') || part.startsWith('runtime-config.'))) {
    failUnsafe('Forbidden backup path');
  }
  return parts;
}

function isInside(directory: string, path: string) {
  const child = relative(directory, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function safeDirectory(path: string, name: string, parent?: string) {
  const configured = resolve(path);
  const metadata = await lstat(configured);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) failUnsafe(`${name} is unsafe`);
  const canonical = await realpathSafe(configured);
  if (parent && !isInside(parent, canonical)) failUnsafe(`${name} is outside the data directory`);
  return canonical;
}

async function realpathSafe(path: string) {
  return realpath(path);
}

async function ensureBackupDirectory(dataDir: string) {
  const root = await safeDirectory(dataDir, 'data directory');
  const backups = join(root, 'backups');
  await mkdir(backups, { recursive: true });
  return { root, backups: await safeDirectory(backups, 'backups directory', root) };
}

async function collectRegularFiles(root: string, current = root): Promise<ArchiveEntry[]> {
  const metadata = await lstat(current);
  if (metadata.isSymbolicLink()) failUnsafe('Symlink in backup source');
  if (metadata.isFile()) {
    const path = relative(root, current).split(sep).join('/');
    safeRelativePath(path);
    return [{ path, bytes: await readFile(current) }];
  }
  if (!metadata.isDirectory()) failUnsafe('Unsupported backup source entry');
  const entries = await readdir(current);
  const files: ArchiveEntry[] = [];
  for (const entry of entries) files.push(...await collectRegularFiles(root, join(current, entry)));
  return files;
}

async function copyImages(source: string, destination: string) {
  await safeDirectory(source, 'images directory');
  const files = await collectRegularFiles(source);
  for (const file of files) {
    const target = join(destination, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.bytes, { mode: 0o600 });
  }
  return files;
}

function octal(value: number, size: number) {
  const text = value.toString(8).padStart(size - 1, '0');
  return Buffer.from(`${text}\0`);
}

function tarHeader(path: string, size: number) {
  const header = Buffer.alloc(512, 0);
  const name = Buffer.from(path);
  if (name.length > 100) failUnsafe('Backup path is too long');
  name.copy(header, 0);
  octal(0o600, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(size, 12).copy(header, 124);
  octal(Math.floor(Date.now() / 1000), 12).copy(header, 136);
  Buffer.alloc(8, 0x20).copy(header, 148);
  header[156] = 0x30;
  Buffer.from('ustar\0').copy(header, 257);
  Buffer.from('00').copy(header, 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  octal(checksum, 8).copy(header, 148);
  return header;
}

function createTar(entries: ArchiveEntry[]) {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    safeRelativePath(entry.path);
    chunks.push(tarHeader(entry.path, entry.bytes.length), entry.bytes);
    const padding = (512 - (entry.bytes.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function parseOctal(bytes: Buffer) {
  const text = bytes.toString('ascii').replace(/\0.*$/, '').trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function parseTar(bytes: Buffer): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const storedChecksum = parseOctal(header.subarray(148, 156));
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const checksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (storedChecksum !== checksum) throw new Error('Invalid archive checksum');
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const path = prefix ? `${prefix}/${name}` : name;
    safeRelativePath(path);
    if (header[156] !== 0 && header[156] !== 0x30) failUnsafe('Archive contains a non-file entry');
    const size = parseOctal(header.subarray(124, 136));
    const start = offset + 512;
    const end = start + size;
    if (end > bytes.length) throw new Error('Truncated archive');
    entries.push({ path, bytes: Buffer.from(bytes.subarray(start, end)) });
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (entries.length === 0) throw new Error('Archive is empty');
  return entries;
}

function hash(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

function manifestFor(entries: ArchiveEntry[], schemaVersion: number, includesImages: boolean): BackupManifest {
  return {
    format: backupFormat,
    version: 1,
    created_at: new Date().toISOString(),
    schema_version: schemaVersion,
    includes_images: includesImages,
    files: entries.map(({ path, bytes }) => ({ path, size: bytes.length, sha256: hash(bytes) })),
  };
}

function parseManifest(value: unknown): BackupManifest {
  if (!value || typeof value !== 'object') throw new Error('Invalid backup manifest');
  const manifest = value as Partial<BackupManifest>;
  if (manifest.format !== backupFormat || manifest.version !== 1 || typeof manifest.schema_version !== 'number' || typeof manifest.includes_images !== 'boolean' || !Array.isArray(manifest.files)) {
    throw new Error('Invalid backup manifest');
  }
  const files = manifest.files.map((file) => {
    if (!file || typeof file !== 'object') throw new Error('Invalid backup manifest file');
    const item = file as Partial<BackupManifest['files'][number]>;
    if (typeof item.path !== 'string' || typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0 || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) {
      throw new Error('Invalid backup manifest file');
    }
    safeRelativePath(item.path);
    return { path: item.path!, size: item.size, sha256: item.sha256 };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error('Duplicate backup manifest file');
  return { ...manifest, files } as BackupManifest;
}

async function validateArchive(path: string) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) failUnsafe('Backup archive is unsafe');
  let archive: Buffer;
  try {
    archive = gunzipSync(await readFile(path));
  } catch {
    throw new Error('Invalid backup archive');
  }
  const entries = parseTar(archive);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const manifestEntry = byPath.get(manifestFilename);
  if (!manifestEntry) throw new Error('Backup manifest is missing');
  const manifest = parseManifest(JSON.parse(manifestEntry.bytes.toString('utf8')));
  const listed = new Set(manifest.files.map((file) => file.path));
  if (entries.length !== new Set(entries.map((entry) => entry.path)).size) throw new Error('Archive contains duplicate files');
  if (listed.has(manifestFilename)) throw new Error('Manifest cannot list itself');
  if (entries.some((entry) => entry.path !== manifestFilename && !listed.has(entry.path))) throw new Error('Archive contains an unlisted file');
  for (const file of manifest.files) {
    const entry = byPath.get(file.path);
    if (!entry || entry.bytes.length !== file.size || hash(entry.bytes) !== file.sha256) throw new Error(`Backup file failed validation: ${file.path}`);
  }
  const schemaEntry = byPath.get(schemaFilename);
  if (!schemaEntry || !manifest.files.some((file) => file.path === schemaFilename)) throw new Error('Schema version is missing');
  const schema = JSON.parse(schemaEntry.bytes.toString('utf8')) as { schema_version?: number };
  if (schema.schema_version !== manifest.schema_version) throw new Error('Schema version does not match manifest');
  const databaseEntry = byPath.get(databaseFilename);
  if (!databaseEntry) throw new Error('Database snapshot is missing');
  const imageFiles = manifest.files.filter((file) => file.path.startsWith('images/'));
  if (!manifest.includes_images && imageFiles.length > 0) throw new Error('Image inclusion does not match manifest');
  const temp = await mkdtemp(join(dirname(path), '.backup-verify-'));
  const databasePath = join(temp, 'fitness-coach.sqlite');
  try {
    await writeFile(databasePath, databaseEntry.bytes, { mode: 0o600 });
    const database = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      if (getSchemaVersion(database) !== manifest.schema_version) throw new Error('Database schema version does not match manifest');
      const exported = exportDatabase(database);
      const imageRecords = exported.tables.meal_images as Array<Record<string, unknown>>;
      for (const image of imageRecords) {
        if (typeof image.relative_path !== 'string' || typeof image.file_size !== 'number' || !image.relative_path.startsWith('images/')) {
          throw new Error('Database contains an invalid image reference');
        }
        safeRelativePath(image.relative_path);
        const archivedImage = byPath.get(image.relative_path);
        if (!archivedImage || archivedImage.bytes.length !== image.file_size) {
          throw new Error(`Backup image failed validation: ${image.relative_path}`);
        }
      }
    } finally {
      database.close();
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  return {
    valid: true as const,
    schemaVersion: manifest.schema_version,
    includesImages: manifest.includes_images,
    files: manifest.files.map((file) => file.path),
    manifest,
  };
}

async function imageExport(dataDir: string) {
  await safeDirectory(dataDir, 'data directory');
  const root = await safeDirectory(join(dataDir, 'images'), 'images directory');
  return (await collectRegularFiles(root)).map(({ path, bytes }) => ({
    path: `images/${path}`,
    mime_type: `image/${path.split('.').at(-1) ?? 'unknown'}`,
    file_size: bytes.length,
    base64: bytes.toString('base64'),
  }));
}

function publicFilename(path: string) {
  return basename(path);
}

export function createBackupService({ repositories, dataDir, database }: ServiceContext & { database?: Database.Database }) {
  void repositories;
  if (!database) throw new Error('Database is required for backup service');

  return {
    async create() {
      const { root, backups } = await ensureBackupDirectory(dataDir);
      const images = await safeDirectory(join(root, 'images'), 'images directory');
      const stage = await mkdtemp(join(root, '.backup-stage-'));
      const temporaryArchive = join(backups, `.${randomBytes(12).toString('hex')}.tmp`);
      try {
        const databasePath = join(stage, databaseFilename);
        await mkdir(dirname(databasePath), { recursive: true });
        await snapshotDatabase(database, databasePath);
        const copiedImages = await copyImages(images, join(stage, 'images'));
        const schemaVersion = getSchemaVersion(database);
        const payload = [
          { path: databaseFilename, bytes: await readFile(databasePath) },
          { path: schemaFilename, bytes: Buffer.from(JSON.stringify({ schema_version: schemaVersion })) },
          ...copiedImages.map(({ path, bytes }) => ({ path: `images/${path}`, bytes })),
        ];
        const manifest = manifestFor(payload, schemaVersion, true);
        const archive = gzipSync(createTar([
          ...payload,
          { path: manifestFilename, bytes: Buffer.from(JSON.stringify(manifest)) },
        ]));
        await writeFile(temporaryArchive, archive, { mode: 0o600, flag: 'wx' });
        await chmod(temporaryArchive, 0o600);
        await validateArchive(temporaryArchive);
        const filename = `backup-${new Date().toISOString().replace(/[T:.]/g, '-').replace(/Z$/, '')}-${randomBytes(4).toString('hex')}.tar.gz`;
        const destination = join(backups, filename);
        await rename(temporaryArchive, destination);
        return { filename, path: destination, size: archive.length, manifest };
      } finally {
        await rm(temporaryArchive, { force: true });
        await rm(stage, { recursive: true, force: true });
      }
    },
    async list() {
      const { backups } = await ensureBackupDirectory(dataDir);
      const files = [];
      for (const filename of await readdir(backups)) {
        if (!filename.endsWith('.tar.gz')) continue;
        const path = join(backups, filename);
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
        files.push({ filename: publicFilename(filename), size: metadata.size, createdAt: metadata.mtime.toISOString() });
      }
      return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async verify(path: string) {
      return validateArchive(path);
    },
    async exportJson(includeImages = false) {
      const exported = exportDatabase(database);
      return {
        manifest: {
          format: 'fitness-coach-json-export',
          version: 1,
          created_at: new Date().toISOString(),
          schema_version: exported.schemaVersion,
          includes_images: includeImages,
        },
        data: exported.tables,
        ...(includeImages ? { images: await imageExport(dataDir) } : {}),
      };
    },
  };
}
