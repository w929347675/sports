import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export type DataPaths = {
  root: string;
  images: string;
  backups: string;
  database: string;
  secret: string;
};

function isInside(root: string, path: string) {
  const child = relative(root, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function assertDirectory(path: string, name: string, root?: string) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`${name} is unsafe`);
  const canonical = await realpath(path);
  if (root && !isInside(root, canonical)) throw new Error(`${name} is unsafe`);
  return canonical;
}

async function ensureDirectory(path: string, name: string, root: string) {
  try {
    await assertDirectory(path, name, root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(path);
  }
  return assertDirectory(path, name, root);
}

async function assertFilePath(path: string, root: string, name: string) {
  if (!isInside(root, path)) throw new Error(`${name} is outside the data directory`);
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${name} is unsafe`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function prepareDataPaths(dataDir: string): Promise<DataPaths> {
  const configuredRoot = resolve(dataDir);
  await mkdir(configuredRoot, { recursive: true });
  const root = await assertDirectory(configuredRoot, 'Data directory');
  const imagesPath = join(root, 'images');
  const backupsPath = join(root, 'backups');
  const images = await ensureDirectory(imagesPath, 'Images directory', root);
  const backups = await ensureDirectory(backupsPath, 'Backups directory', root);
  const database = join(root, 'fitness-coach.sqlite');
  const secret = join(root, 'model-api-key.secret');
  await assertFilePath(database, root, 'Database path');
  await assertFilePath(secret, root, 'Secret path');
  return { root, images, backups, database, secret };
}
