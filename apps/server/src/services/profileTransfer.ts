import { createHash, randomBytes } from 'node:crypto';
import { constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, closeSync } from 'node:fs';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { getSchemaVersion } from '@fitness-coach/db';
import type Database from 'better-sqlite3';
import {
  bodyFeedbackRecordSchema,
  dailyEntryRecordSchema,
  exerciseRecordSchema,
  foodItemRecordSchema,
  mealImageRecordSchema,
  mealRecordSchema,
  profileRecordSchema,
  recommendationRecordSchema,
  weightMeasurementRecordSchema,
  workoutRecordSchema,
} from '@fitness-coach/shared';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import type { ServiceContext } from './context.js';

type Row = Record<string, unknown>;
type ArchiveEntry = { path: string; bytes: Buffer };
type ExportImage = { profile_id: number; path: string; size: number; sha256: string };
type PendingImport = { archive: Buffer; expiresAt: number };
type ImportResolution = { profileId: number; strategy: 'new' | 'skip' | 'overwrite' | 'cancel'; newName?: string };
type ProfileImportPlan = {
  source: ProfileTransferData['profiles.json'][number];
  strategy: 'new' | 'skip' | 'overwrite' | 'import';
  name: string;
  existingProfileId?: number;
};
type ProfileSnapshot = {
  profile: Row;
  dailyEntries: Row[];
  weights: Row[];
  meals: Row[];
  mealImages: Row[];
  foodItems: Row[];
  workouts: Row[];
  exercises: Row[];
  bodyFeedback: Row[];
  recommendations: Row[];
};
type ImportJournal = {
  version: 1;
  phase: 'prepared' | 'database_committed' | 'files_installed';
  temporaryRoot: string;
  insertedProfileIds: number[];
  snapshots: ProfileSnapshot[];
  moves: Array<{ target: string; staged?: string; backup?: string; installed: boolean }>;
  cleanup_failures?: string[];
};

export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const MAX_IMPORT_TAR_BYTES = 200 * 1024 * 1024;
const IMPORT_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING_IMPORTS = 32;
const transferFormat = 'fitness-coach-profile-transfer';
const profileImportJournalKey = 'profile_import_journal';
let executeImportInProgress = false;

const profileFields = [
  'id', 'name', 'status', 'goal', 'goal_description', 'height_cm', 'age', 'sex',
  'training_experience', 'equipment', 'training_days_per_week', 'session_duration_minutes',
  'diet_preferences', 'allergies', 'health_restrictions', 'created_at', 'updated_at', 'archived_at',
] as const;
const dailyEntryFields = ['id', 'profile_id', 'entry_date', 'status', 'status_note', 'created_at', 'updated_at'] as const;
const weightFields = ['id', 'daily_entry_id', 'measured_at', 'weight_kg', 'note'] as const;
const mealFields = ['id', 'daily_entry_id', 'eaten_at', 'meal_type', 'notes', 'recognition_status', 'created_at', 'updated_at'] as const;
const mealImageFields = ['id', 'meal_id', 'relative_path', 'mime_type', 'file_size', 'created_at'] as const;
const foodItemFields = ['id', 'meal_id', 'name', 'amount', 'unit', 'cooking_method', 'confidence', 'needs_confirmation', 'is_user_confirmed', 'source', 'notes'] as const;
const workoutFields = ['id', 'daily_entry_id', 'started_at', 'workout_type', 'duration_minutes', 'perceived_difficulty', 'notes'] as const;
const exerciseFields = ['id', 'workout_id', 'name', 'weight', 'weight_unit', 'sets', 'repetitions', 'completed', 'notes'] as const;
const feedbackFields = ['id', 'daily_entry_id', 'recorded_at', 'category', 'body_part', 'severity', 'impact', 'description', 'created_at'] as const;
const recommendationFields = ['id', 'profile_id', 'job_id', 'range_start', 'range_end', 'model_name', 'generated_at', 'input_record_count', 'image_review_count', 'input_summary_json', 'report_markdown', 'structured_report_json', 'error_code', 'error_message', 'status'] as const;

const jsonFilenames = [
  'profiles.json',
  'daily-entries.json',
  'weights.json',
  'meals.json',
  'meal-images.json',
  'food-items.json',
  'workouts.json',
  'exercises.json',
  'body-feedback.json',
  'recommendations.json',
] as const;

const jsonFileDataKeys: Record<typeof jsonFilenames[number], keyof {
  profiles: unknown;
  dailyEntries: unknown;
  weights: unknown;
  meals: unknown;
  mealImages: unknown;
  foodItems: unknown;
  workouts: unknown;
  exercises: unknown;
  bodyFeedback: unknown;
  recommendations: unknown;
}> = {
  'profiles.json': 'profiles',
  'daily-entries.json': 'dailyEntries',
  'weights.json': 'weights',
  'meals.json': 'meals',
  'meal-images.json': 'mealImages',
  'food-items.json': 'foodItems',
  'workouts.json': 'workouts',
  'exercises.json': 'exercises',
  'body-feedback.json': 'bodyFeedback',
  'recommendations.json': 'recommendations',
};

const profileTransferSchemas = {
  'profiles.json': z.array(profileRecordSchema.extend({ updated_at: z.string().datetime({ offset: true }) }).strict()),
  'daily-entries.json': z.array(dailyEntryRecordSchema),
  'weights.json': z.array(weightMeasurementRecordSchema),
  'meals.json': z.array(mealRecordSchema),
  'meal-images.json': z.array(mealImageRecordSchema),
  'food-items.json': z.array(foodItemRecordSchema),
  'workouts.json': z.array(workoutRecordSchema),
  'exercises.json': z.array(exerciseRecordSchema),
  'body-feedback.json': z.array(bodyFeedbackRecordSchema),
  'recommendations.json': z.array(recommendationRecordSchema),
} as const;

type ProfileTransferData = {
  -readonly [K in keyof typeof profileTransferSchemas]: z.infer<(typeof profileTransferSchemas)[K]>;
};

type TransferManifest = {
  format: typeof transferFormat;
  version: 1;
  created_at: string;
  schema_version: number;
  profiles: Array<{ id: number; name: string; status: 'active' | 'archived' }>;
  counts: Record<string, number>;
  images: ExportImage[];
};

function validationError(message = 'Profile transfer package is invalid'): never {
  throw new ApiError('VALIDATION_ERROR', message);
}

function parseOctal(bytes: Buffer) {
  const text = bytes.toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]*$/.test(text)) validationError();
  const value = text === '' ? 0 : Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) validationError();
  return value;
}

function decodeTarField(bytes: Buffer) {
  const nul = bytes.indexOf(0);
  if (nul >= 0 && bytes.subarray(nul + 1).some((byte) => byte !== 0)) validationError();
  const field = nul < 0 ? bytes : bytes.subarray(0, nul);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(field);
  } catch {
    validationError();
  }
}

function assertSafeArchivePath(path: string) {
  if (!path || path.includes('\\') || path.includes('\0') || path.startsWith('/')) validationError();
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) validationError();
  return parts;
}

function parseTar(bytes: Buffer): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let ended = false;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      ended = true;
      if (bytes.subarray(offset).some((byte) => byte !== 0)) validationError();
      break;
    }
    const storedChecksum = parseOctal(header.subarray(148, 156));
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    if (storedChecksum !== checksumHeader.reduce((sum, byte) => sum + byte, 0)) validationError();
    const name = decodeTarField(header.subarray(0, 100));
    const prefix = decodeTarField(header.subarray(345, 500));
    const path = prefix ? `${prefix}/${name}` : name;
    assertSafeArchivePath(path);
    if (seen.has(path)) validationError();
    seen.add(path);
    if (header[156] !== 0 && header[156] !== 0x30) validationError();
    const size = parseOctal(header.subarray(124, 136));
    const start = offset + 512;
    const end = start + size;
    if (end < start || end > bytes.length) validationError();
    entries.push({ path, bytes: Buffer.from(bytes.subarray(start, end)) });
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (!ended || entries.length === 0) validationError();
  return entries;
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    validationError();
  }
}

function parseManifest(value: unknown): TransferManifest {
  const schema = z.object({
    format: z.literal(transferFormat),
    version: z.literal(1),
    created_at: z.string().datetime({ offset: true }),
    schema_version: z.number().int().positive(),
    profiles: z.array(z.object({
      id: z.number().int().positive(),
      name: z.string().trim().min(1),
      status: z.enum(['active', 'archived']),
    }).strict()).min(1),
    counts: z.record(z.string(), z.number().int().nonnegative()),
    images: z.array(z.object({
      profile_id: z.number().int().positive(),
      path: z.string().min(1),
      size: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict()),
  }).strict();
  const parsed = schema.safeParse(value);
  if (!parsed.success) validationError();
  if (new Set(parsed.data.profiles.map((profile) => profile.id)).size !== parsed.data.profiles.length) validationError();
  if (new Set(parsed.data.images.map((image) => image.path)).size !== parsed.data.images.length) validationError();
  for (const image of parsed.data.images) {
    const parts = assertSafeArchivePath(image.path);
    if (parts.length !== 3 || parts[0] !== 'images' || parts[1] !== String(image.profile_id) || !parts[2]) validationError();
  }
  return parsed.data;
}

function rowIds(rows: Array<{ id: number }>) {
  if (new Set(rows.map((row) => row.id)).size !== rows.length) validationError();
  return new Set(rows.map((row) => row.id));
}

function validateTransferData(data: ProfileTransferData, manifest: TransferManifest, schemaVersion: number) {
  if (manifest.schema_version !== schemaVersion) validationError('Profile transfer schema version is not compatible');
  const profileIds = rowIds(data['profiles.json']);
  rowIds(data['daily-entries.json']);
  rowIds(data['weights.json']);
  rowIds(data['meals.json']);
  rowIds(data['meal-images.json']);
  rowIds(data['food-items.json']);
  rowIds(data['workouts.json']);
  rowIds(data['exercises.json']);
  rowIds(data['body-feedback.json']);
  rowIds(data['recommendations.json']);
  const manifestProfileIds = new Set(manifest.profiles.map((profile) => profile.id));
  if (profileIds.size !== manifestProfileIds.size || [...profileIds].some((id) => !manifestProfileIds.has(id))) validationError();
  for (const profile of data['profiles.json']) {
    const listed = manifest.profiles.find((item) => item.id === profile.id);
    if (!listed || listed.name !== profile.name || listed.status !== profile.status) validationError();
  }

  const dailyEntryIds = rowIds(data['daily-entries.json']);
  const mealIds = rowIds(data['meals.json']);
  const workoutIds = rowIds(data['workouts.json']);
  for (const entry of data['daily-entries.json']) if (!profileIds.has(entry.profile_id)) validationError();
  for (const row of [...data['weights.json'], ...data['meals.json'], ...data['workouts.json'], ...data['body-feedback.json']]) {
    if (!dailyEntryIds.has(row.daily_entry_id)) validationError();
  }
  for (const row of [...data['meal-images.json'], ...data['food-items.json']]) {
    if (!mealIds.has(row.meal_id)) validationError();
  }
  for (const row of data['exercises.json']) if (!workoutIds.has(row.workout_id)) validationError();
  for (const row of data['recommendations.json']) if (!profileIds.has(row.profile_id)) validationError();

  const entryProfiles = new Map(data['daily-entries.json'].map((entry) => [entry.id, entry.profile_id]));
  const mealProfiles = new Map(data['meals.json'].map((meal) => [meal.id, entryProfiles.get(meal.daily_entry_id)]));
  const workoutProfiles = new Map(data['workouts.json'].map((workout) => [workout.id, entryProfiles.get(workout.daily_entry_id)]));
  for (const row of [...data['meal-images.json'], ...data['food-items.json']]) if (mealProfiles.get(row.meal_id) === undefined) validationError();
  for (const row of data['exercises.json']) if (workoutProfiles.get(row.workout_id) === undefined) validationError();

  const expectedCounts: Record<string, number> = {
    profiles: data['profiles.json'].length,
    daily_entries: data['daily-entries.json'].length,
    weight_measurements: data['weights.json'].length,
    meals: data['meals.json'].length,
    meal_images: data['meal-images.json'].length,
    food_items: data['food-items.json'].length,
    workouts: data['workouts.json'].length,
    exercises: data['exercises.json'].length,
    body_feedback: data['body-feedback.json'].length,
    recommendations: data['recommendations.json'].length,
  };
  if (Object.keys(manifest.counts).length !== Object.keys(expectedCounts).length
    || Object.entries(expectedCounts).some(([key, count]) => manifest.counts[key] !== count)) validationError();

  const imageRows = data['meal-images.json'];
  if (imageRows.length !== manifest.images.length) validationError();
  if (new Set(imageRows.map((image) => image.relative_path)).size !== imageRows.length) validationError();
  const manifestImages = new Map(manifest.images.map((image) => [image.path, image]));
  for (const image of imageRows) {
    const parts = assertSafeArchivePath(image.relative_path);
    if (parts.length !== 3 || parts[0] !== 'images') validationError();
    const mealProfileId = mealProfiles.get(image.meal_id);
    const listed = manifestImages.get(image.relative_path);
    if (!listed || listed.profile_id !== mealProfileId || image.file_size !== listed.size) validationError();
  }
  return { profileIds, entryProfiles, mealProfiles, workoutProfiles };
}

function validateSchemaVersion(value: unknown) {
  const parsed = z.object({ schema_version: z.number().int().positive() }).strict().safeParse(value);
  if (!parsed.success) validationError();
  return parsed.data.schema_version;
}

function parseTransferData(entries: Map<string, ArchiveEntry>) {
  const data = {} as ProfileTransferData;
  for (const filename of jsonFilenames) {
    const entry = entries.get(filename);
    if (!entry) validationError();
    const parsed = profileTransferSchemas[filename].safeParse(parseJson(entry.bytes));
    if (!parsed.success) validationError();
    data[filename] = parsed.data as never;
  }
  return data;
}

function profileNameKey(name: string) {
  return name.trim().replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function imageFileName(relativePath: string) {
  const parts = relativePath.split('/');
  const fileName = parts[2];
  if (parts.length !== 3 || parts[0] !== 'images' || !fileName || basename(fileName) !== fileName || fileName === '.' || fileName === '..') {
    validationError('Profile image path is invalid');
  }
  return fileName;
}

function findConflicts(database: Database.Database, profiles: ProfileTransferData['profiles.json']) {
  const local = database.prepare('SELECT id, name, status FROM profiles ORDER BY id').all() as Array<{ id: number; name: string; status: string }>;
  const localById = new Map(local.map((profile) => [profile.id, profile]));
  const localByName = new Map(local.map((profile) => [profileNameKey(profile.name), profile]));
  const conflicts: Array<{
    type: 'profile_id' | 'profile_name';
    profileId: number;
    existingProfileId: number;
    incomingName: string;
    existingName: string;
  }> = [];
  for (const profile of profiles) {
    const byId = localById.get(profile.id);
    if (byId) {
      conflicts.push({ type: 'profile_id', profileId: profile.id, existingProfileId: byId.id, incomingName: profile.name, existingName: byId.name });
    }
    const byName = localByName.get(profileNameKey(profile.name));
    if (byName && byName.id !== profile.id) {
      conflicts.push({ type: 'profile_name', profileId: profile.id, existingProfileId: byName.id, incomingName: profile.name, existingName: byName.name });
    }
  }
  return conflicts;
}

function profileStats(data: ProfileTransferData) {
  const entries = data['daily-entries.json'];
  const meals = data['meals.json'];
  const workouts = data['workouts.json'];
  const images = data['meal-images.json'];
  const foods = data['food-items.json'];
  const exercises = data['exercises.json'];
  const feedback = data['body-feedback.json'];
  const recommendations = data['recommendations.json'];
  const entryProfile = new Map(entries.map((entry) => [entry.id, entry.profile_id]));
  const mealProfile = new Map(meals.map((meal) => [meal.id, entryProfile.get(meal.daily_entry_id)]));
  const workoutProfile = new Map(workouts.map((workout) => [workout.id, entryProfile.get(workout.daily_entry_id)]));
  return data['profiles.json'].map((profile) => {
    const id = profile.id;
    const records = {
      daily_entries: entries.filter((entry) => entry.profile_id === id).length,
      weight_measurements: data['weights.json'].filter((row) => entryProfile.get(row.daily_entry_id) === id).length,
      meals: meals.filter((row) => entryProfile.get(row.daily_entry_id) === id).length,
      meal_images: images.filter((row) => mealProfile.get(row.meal_id) === id).length,
      food_items: foods.filter((row) => mealProfile.get(row.meal_id) === id).length,
      workouts: workouts.filter((row) => entryProfile.get(row.daily_entry_id) === id).length,
      exercises: exercises.filter((row) => workoutProfile.get(row.workout_id) === id).length,
      body_feedback: feedback.filter((row) => entryProfile.get(row.daily_entry_id) === id).length,
      recommendations: recommendations.filter((row) => row.profile_id === id).length,
    };
    const imageCount = records.meal_images;
    const reportCount = records.recommendations;
    return { id, name: profile.name, status: profile.status, records, images: imageCount, reports: reportCount };
  });
}

function parseAndValidateArchive(archive: Buffer, database: Database.Database) {
  if (archive.length === 0 || archive.length > MAX_IMPORT_BYTES) validationError('Profile transfer package is too large');
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: MAX_IMPORT_TAR_BYTES });
  } catch {
    validationError();
  }
  const entries = parseTar(tar);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const manifestEntry = byPath.get('manifest.json');
  const schemaEntry = byPath.get('schema-version.json');
  if (!manifestEntry || !schemaEntry) validationError();
  const manifest = parseManifest(parseJson(manifestEntry.bytes));
  const schemaVersion = validateSchemaVersion(parseJson(schemaEntry.bytes));
  if (manifest.schema_version !== schemaVersion || schemaVersion !== getSchemaVersion(database)) validationError('Profile transfer schema version is not compatible');

  const fixedPaths = new Set<string>(['manifest.json', 'schema-version.json', ...jsonFilenames]);
  const imagePaths = new Set(manifest.images.map((image) => image.path));
  for (const entry of entries) if (!fixedPaths.has(entry.path) && !imagePaths.has(entry.path)) validationError();
  for (const path of fixedPaths) if (!byPath.has(path)) validationError();
  for (const image of manifest.images) {
    const entry = byPath.get(image.path);
    if (!entry || entry.bytes.length !== image.size || hash(entry.bytes) !== image.sha256) validationError();
  }
  if (entries.length !== fixedPaths.size + imagePaths.size) validationError();

  const data = parseTransferData(byPath);
  const relationships = validateTransferData(data, manifest, schemaVersion);
  const imageEntries = new Set(manifest.images.map((image) => image.path));
  for (const image of data['meal-images.json']) if (!imageEntries.has(image.relative_path)) validationError();
  for (const image of data['meal-images.json']) {
    const entry = byPath.get(image.relative_path);
    if (!entry || entry.bytes.length !== image.file_size) validationError();
  }
  return {
    manifest,
    data,
    relationships,
    stats: profileStats(data),
    imageBytes: new Map(manifest.images.map((image) => [image.path, byPath.get(image.path)!.bytes])),
  };
}

function inList(values: number[]) {
  return values.map(() => '?').join(', ');
}

function selectRows<T extends readonly string[]>(database: Database.Database, table: string, fields: T, column: string, ids: number[]) {
  if (ids.length === 0) return [] as Array<Record<T[number], unknown>>;
  return database.prepare(`SELECT ${fields.join(', ')} FROM ${table} WHERE ${column} IN (${inList(ids)}) ORDER BY id`).all(...ids) as Array<Record<T[number], unknown>>;
}

function selectImageRows(database: Database.Database, mealIds: number[]) {
  if (mealIds.length === 0) return [] as Array<Record<typeof mealImageFields[number] | 'profile_id', unknown>>;
  return database.prepare(`
    SELECT ${mealImageFields.map((field) => `i.${field}`).join(', ')}, d.profile_id
    FROM meal_images i
    JOIN meals m ON m.id = i.meal_id
    JOIN daily_entries d ON d.id = m.daily_entry_id
    WHERE i.meal_id IN (${inList(mealIds)})
    ORDER BY i.id
  `).all(...mealIds) as Array<Record<typeof mealImageFields[number] | 'profile_id', unknown>>;
}

function asJsonRow(row: Row, fields: readonly string[]) {
  return Object.fromEntries(fields.map((field) => [field, row[field]]));
}

function booleanJsonRows(rows: Row[], fields: readonly string[], booleanFields: readonly string[]) {
  return rows.map((row) => {
    const result = asJsonRow(row, fields);
    for (const field of booleanFields) result[field] = Boolean(result[field]);
    return result;
  });
}

function octal(value: number, size: number) {
  return Buffer.from(`${value.toString(8).padStart(size - 1, '0')}\0`);
}

function tarHeader(path: string, size: number) {
  const header = Buffer.alloc(512, 0);
  const slash = path.lastIndexOf('/');
  const name = Buffer.from(slash < 0 ? path : path.slice(slash + 1));
  const prefix = Buffer.from(slash < 0 ? '' : path.slice(0, slash));
  if (name.length > 100 || prefix.length > 155) throw new ApiError('VALIDATION_ERROR', 'Export filename is too long');
  name.copy(header, 0);
  prefix.copy(header, 345);
  octal(0o600, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(size, 12).copy(header, 124);
  octal(Math.floor(Date.now() / 1000), 12).copy(header, 136);
  Buffer.alloc(8, 0x20).copy(header, 148);
  header[156] = 0x30;
  Buffer.from('ustar\0').copy(header, 257);
  Buffer.from('00').copy(header, 263);
  octal(header.reduce((sum, byte) => sum + byte, 0), 8).copy(header, 148);
  return header;
}

function createTar(entries: ArchiveEntry[]) {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(tarHeader(entry.path, entry.bytes.length), entry.bytes);
    const padding = (512 - (entry.bytes.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function jsonBytes(value: unknown) {
  return Buffer.from(JSON.stringify(value));
}

function hash(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

function pathIsWithin(parent: string, candidate: string) {
  const child = relative(parent, candidate);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function assertLocalPath(dataDir: string, path: string) {
  const dataRoot = realpathSync(dataDir);
  const candidate = resolve(path);
  if (!pathIsWithin(dataRoot, candidate)) throw new ApiError('VALIDATION_ERROR', 'Profile transfer path is unsafe');
  let current = candidate;
  while (current !== dataRoot) {
    try {
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink()) throw new ApiError('VALIDATION_ERROR', 'Profile transfer path is unsafe');
      const resolved = realpathSync(current);
      if (resolved !== dataRoot && !pathIsWithin(dataRoot, resolved)) throw new ApiError('VALIDATION_ERROR', 'Profile transfer path is unsafe');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      current = dirname(current);
    }
  }
}

function assertSafeImagesRoot(dataDir: string) {
  const root = join(dataDir, 'images');
  assertLocalPath(dataDir, root);
  const metadata = lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new ApiError('VALIDATION_ERROR', 'Profile images directory is unsafe');
  const resolved = realpathSync(root);
  if (!pathIsWithin(realpathSync(dataDir), resolved)) throw new ApiError('VALIDATION_ERROR', 'Profile images directory is unsafe');
  return { root, resolved };
}

function assertSafeProfileDirectory(dataDir: string, profileDirectory: string, expectedRoot: string) {
  assertSafeImagesRoot(dataDir);
  assertLocalPath(dataDir, profileDirectory);
  if (dirname(profileDirectory) !== expectedRoot) throw new ApiError('VALIDATION_ERROR', 'Profile image directory is unsafe');
  try {
    const metadata = lstatSync(profileDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new ApiError('VALIDATION_ERROR', 'Profile image directory is unsafe');
    const resolved = realpathSync(profileDirectory);
    if (!pathIsWithin(realpathSync(expectedRoot), resolved)) throw new ApiError('VALIDATION_ERROR', 'Profile image directory is unsafe');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function readProfileImage(dataDir: string, profileId: number, relativePath: string) {
  const expectedDirectory = `images/profile-${profileId}`;
  const parts = relativePath.split('/');
  const fileName = parts[2];
  if (
    parts.length !== 3
    || parts[0] !== 'images'
    || parts[1] !== expectedDirectory.slice('images/'.length)
    || !fileName
    || fileName === '.'
    || fileName === '..'
    || basename(fileName) !== fileName
    || fileName.includes('\\')
    || fileName.includes('\0')
  ) {
    throw new ApiError('VALIDATION_ERROR', 'Profile image path is invalid');
  }

  const { root } = assertSafeImagesRoot(dataDir);
  const profileDirectory = join(root, `profile-${profileId}`);
  const source = join(profileDirectory, fileName);
  assertSafeProfileDirectory(dataDir, profileDirectory, root);
  try {
    const fileStat = lstatSync(source);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error('unsafe image source');
    }
    assertLocalPath(dataDir, source);
    const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile()) throw new Error('unsafe image source');
      return readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('VALIDATION_ERROR', 'Profile image is unavailable');
  }
}

export function createProfileTransferService({ dataDir, database }: Pick<ServiceContext, 'dataDir' | 'database'>) {
  if (!database) throw new Error('Database is required for profile transfer service');
  const db = database;
  const pendingImports = new Map<string, PendingImport>();

  function cleanupPendingImports() {
    const now = Date.now();
    for (const [importId, pending] of pendingImports) if (pending.expiresAt <= now) pendingImports.delete(importId);
    while (pendingImports.size >= MAX_PENDING_IMPORTS) {
      const oldest = pendingImports.keys().next().value;
      if (oldest === undefined) break;
      pendingImports.delete(oldest);
    }
  }

  function currentProfileId() {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'current_profile_id'").get() as { value?: string } | undefined;
    return row?.value ? Number(row.value) : undefined;
  }

  function planImport(data: ProfileTransferData, resolutions: ImportResolution[] | undefined) {
    const conflicts = findConflicts(db, data['profiles.json']);
    const conflictsByProfile = new Map<number, typeof conflicts>();
    for (const conflict of conflicts) {
      const profileConflicts = conflictsByProfile.get(conflict.profileId) ?? [];
      profileConflicts.push(conflict);
      conflictsByProfile.set(conflict.profileId, profileConflicts);
    }
    const localProfiles = db.prepare('SELECT id, name FROM profiles ORDER BY id').all() as Array<{ id: number; name: string }>;
    const localNames = new Map(localProfiles.map((profile) => [profileNameKey(profile.name), profile.id]));
    const resolutionsByProfile = new Map<number, ImportResolution>();
    for (const resolution of resolutions ?? []) {
      if (resolutionsByProfile.has(resolution.profileId)) validationError('Each profile may have only one conflict resolution');
      resolutionsByProfile.set(resolution.profileId, resolution);
    }
    for (const profileId of resolutionsByProfile.keys()) {
      if (!data['profiles.json'].some((profile) => profile.id === profileId)) validationError('Conflict resolution references an unknown profile');
    }

    const plans: ProfileImportPlan[] = [];
    for (const source of data['profiles.json']) {
      const profileConflicts = conflictsByProfile.get(source.id) ?? [];
      if (profileConflicts.length === 0) {
        if (resolutionsByProfile.has(source.id)) validationError('A resolution was supplied for a profile without a conflict');
        plans.push({ source, strategy: 'import', name: source.name.trim() });
        continue;
      }

      const resolution = resolutionsByProfile.get(source.id);
      if (!resolution) validationError('A conflict strategy is required for every conflicting profile');
      if (resolution.strategy === 'cancel') throw new ApiError('CONFLICT', 'Profile import was cancelled');
      if (resolution.strategy === 'skip') {
        const targetId = localProfiles.find((profile) => profile.id === source.id)?.id
          ?? localNames.get(profileNameKey(source.name));
        plans.push({ source, strategy: 'skip', name: source.name.trim(), existingProfileId: targetId });
        continue;
      }
      if (resolution.strategy === 'overwrite') {
        const target = localProfiles.find((profile) => profile.id === source.id)
          ?? localProfiles.find((profile) => profileNameKey(profile.name) === profileNameKey(source.name));
        if (!target) throw new ApiError('CONFLICT', 'Overwrite requires an existing profile with the same ID');
        plans.push({ source, strategy: 'overwrite', name: source.name.trim(), existingProfileId: target.id });
        continue;
      }

      const name = resolution.newName?.trim() ?? '';
      if (!name) validationError('A new profile name is required');
      plans.push({ source, strategy: 'new', name });
    }

    const overwriteTargets = new Set<number>();
    for (const plan of plans) {
      if (plan.strategy === 'overwrite') {
        if (plan.existingProfileId === undefined || overwriteTargets.has(plan.existingProfileId)) {
          throw new ApiError('CONFLICT', 'Each overwrite target may be used only once');
        }
        overwriteTargets.add(plan.existingProfileId);
      }
    }
    const finalNames = new Set<string>();
    for (const profile of localProfiles) {
      if (!overwriteTargets.has(profile.id)) finalNames.add(profileNameKey(profile.name));
    }
    for (const plan of plans) {
      if (plan.strategy === 'skip') continue;
      const key = profileNameKey(plan.name);
      if (finalNames.has(key)) throw new ApiError('CONFLICT', 'Profile name conflict was not resolved');
      finalNames.add(key);
    }
    return plans;
  }

  function snapshotProfile(profileId: number): ProfileSnapshot {
    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId) as Row | undefined;
    if (!profile) throw new ApiError('CONFLICT', 'Profile overwrite target was not found');
    const dailyEntries = selectRows(db, 'daily_entries', dailyEntryFields, 'profile_id', [profileId]);
    const dailyEntryIds = dailyEntries.map((row) => Number(row.id));
    const weights = selectRows(db, 'weight_measurements', weightFields, 'daily_entry_id', dailyEntryIds);
    const meals = selectRows(db, 'meals', mealFields, 'daily_entry_id', dailyEntryIds);
    const mealIds = meals.map((row) => Number(row.id));
    const mealImages = selectImageRows(db, mealIds);
    const foodItems = selectRows(db, 'food_items', foodItemFields, 'meal_id', mealIds);
    const workouts = selectRows(db, 'workouts', workoutFields, 'daily_entry_id', dailyEntryIds);
    const workoutIds = workouts.map((row) => Number(row.id));
    const exercises = selectRows(db, 'exercises', exerciseFields, 'workout_id', workoutIds);
    const bodyFeedback = selectRows(db, 'body_feedback', feedbackFields, 'daily_entry_id', dailyEntryIds);
    const recommendations = selectRows(db, 'recommendations', recommendationFields, 'profile_id', [profileId]);
    return { profile, dailyEntries, weights, meals, mealImages, foodItems, workouts, exercises, bodyFeedback, recommendations };
  }

  function restoreSnapshot(snapshot: ProfileSnapshot) {
    const profile = snapshot.profile;
    db.prepare(`INSERT INTO profiles (id, name, status, goal, goal_description, height_cm, age, sex,
      training_experience, equipment, training_days_per_week, session_duration_minutes, diet_preferences,
      allergies, health_restrictions, created_at, updated_at, archived_at)
      VALUES (@id, @name, @status, @goal, @goal_description, @height_cm, @age, @sex,
      @training_experience, @equipment, @training_days_per_week, @session_duration_minutes, @diet_preferences,
      @allergies, @health_restrictions, @created_at, @updated_at, @archived_at)`).run(profile);
    const insertDailyEntry = db.prepare(`INSERT INTO daily_entries
      (id, profile_id, entry_date, status, status_note, created_at, updated_at) VALUES
      (@id, @profile_id, @entry_date, @status, @status_note, @created_at, @updated_at)`);
    const insertWeight = db.prepare(`INSERT INTO weight_measurements
      (id, daily_entry_id, measured_at, weight_kg, note) VALUES
      (@id, @daily_entry_id, @measured_at, @weight_kg, @note)`);
    const insertMeal = db.prepare(`INSERT INTO meals
      (id, daily_entry_id, eaten_at, meal_type, notes, recognition_status, created_at, updated_at) VALUES
      (@id, @daily_entry_id, @eaten_at, @meal_type, @notes, @recognition_status, @created_at, @updated_at)`);
    const insertImage = db.prepare(`INSERT INTO meal_images
      (id, meal_id, relative_path, mime_type, file_size, created_at) VALUES
      (@id, @meal_id, @relative_path, @mime_type, @file_size, @created_at)`);
    const insertFood = db.prepare(`INSERT INTO food_items
      (id, meal_id, name, amount, unit, cooking_method, confidence, needs_confirmation,
       is_user_confirmed, source, notes) VALUES
      (@id, @meal_id, @name, @amount, @unit, @cooking_method, @confidence, @needs_confirmation,
       @is_user_confirmed, @source, @notes)`);
    const insertWorkout = db.prepare(`INSERT INTO workouts
      (id, daily_entry_id, started_at, workout_type, duration_minutes, perceived_difficulty, notes) VALUES
      (@id, @daily_entry_id, @started_at, @workout_type, @duration_minutes, @perceived_difficulty, @notes)`);
    const insertExercise = db.prepare(`INSERT INTO exercises
      (id, workout_id, name, weight, weight_unit, sets, repetitions, completed, notes) VALUES
      (@id, @workout_id, @name, @weight, @weight_unit, @sets, @repetitions, @completed, @notes)`);
    const insertFeedback = db.prepare(`INSERT INTO body_feedback
      (id, daily_entry_id, recorded_at, category, body_part, severity, impact, description, created_at) VALUES
      (@id, @daily_entry_id, @recorded_at, @category, @body_part, @severity, @impact, @description, @created_at)`);
    const insertRecommendation = db.prepare(`INSERT INTO recommendations (${recommendationFields.join(', ')})
      VALUES (${recommendationFields.map((field) => `@${field}`).join(', ')})`);
    for (const row of snapshot.dailyEntries) insertDailyEntry.run(row);
    for (const row of snapshot.weights) insertWeight.run(row);
    for (const row of snapshot.meals) insertMeal.run(row);
    for (const row of snapshot.mealImages) insertImage.run(row);
    for (const row of snapshot.foodItems) insertFood.run(row);
    for (const row of snapshot.workouts) insertWorkout.run(row);
    for (const row of snapshot.exercises) insertExercise.run(row);
    for (const row of snapshot.bodyFeedback) insertFeedback.run(row);
    for (const row of snapshot.recommendations) insertRecommendation.run(row);
  }

  function insertArchive(data: ProfileTransferData, plans: ProfileImportPlan[], currentProfile: () => number | undefined) {
    const profileIds = new Map<number, number>();
    const dailyEntryIds = new Map<number, number>();
    const weightIds = new Map<number, number>();
    const mealIds = new Map<number, number>();
    const mealImageIds = new Map<number, number>();
    const foodItemIds = new Map<number, number>();
    const workoutIds = new Map<number, number>();
    const exerciseIds = new Map<number, number>();
    const feedbackIds = new Map<number, number>();
    const recommendationIds = new Map<number, number>();
    const results: Array<{ sourceProfileId: number; targetProfileId: number; status: 'imported' | 'skipped' }> = [];

    for (const plan of plans) {
      if (plan.strategy === 'overwrite') {
        if (plan.existingProfileId === undefined) validationError();
        if (currentProfile() === plan.existingProfileId) throw new ApiError('CONFLICT', 'Current profile cannot be overwritten');
        db.prepare('DELETE FROM profiles WHERE id = ?').run(plan.existingProfileId);
        if (currentProfile() === plan.existingProfileId) throw new ApiError('CONFLICT', 'Current profile cannot be overwritten');
      }
    }

    for (const plan of plans) {
      if (plan.strategy === 'skip') {
        results.push({ sourceProfileId: plan.source.id, targetProfileId: plan.existingProfileId ?? plan.source.id, status: 'skipped' });
        continue;
      }
      let targetProfileId: number;
      if (plan.strategy === 'overwrite') {
        targetProfileId = plan.existingProfileId!;
        db.prepare(`INSERT INTO profiles (id, name, status, goal, goal_description, height_cm, age, sex,
          training_experience, equipment, training_days_per_week, session_duration_minutes, diet_preferences,
          allergies, health_restrictions, created_at, updated_at, archived_at)
          VALUES (@id, @name, @status, @goal, @goal_description, @height_cm, @age, @sex,
          @training_experience, @equipment, @training_days_per_week, @session_duration_minutes, @diet_preferences,
          @allergies, @health_restrictions, @created_at, @updated_at, @archived_at)`)
          .run({ ...plan.source, id: targetProfileId, name: plan.name });
      } else {
        const inserted = db.prepare(`INSERT INTO profiles (name, status, goal, goal_description, height_cm, age, sex,
          training_experience, equipment, training_days_per_week, session_duration_minutes, diet_preferences,
          allergies, health_restrictions, created_at, updated_at, archived_at)
          VALUES (@name, @status, @goal, @goal_description, @height_cm, @age, @sex,
          @training_experience, @equipment, @training_days_per_week, @session_duration_minutes, @diet_preferences,
          @allergies, @health_restrictions, @created_at, @updated_at, @archived_at)`)
          .run({ ...plan.source, name: plan.name });
        targetProfileId = Number(inserted.lastInsertRowid);
      }
      profileIds.set(plan.source.id, targetProfileId);
      results.push({ sourceProfileId: plan.source.id, targetProfileId, status: 'imported' });
    }

    const importedSourceIds = new Set(profileIds.keys());
    for (const row of data['daily-entries.json']) {
      const profileId = profileIds.get(row.profile_id);
      if (profileId === undefined) continue;
      const inserted = db.prepare(`INSERT INTO daily_entries (profile_id, entry_date, status, status_note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(profileId, row.entry_date, row.status, row.status_note, row.created_at, row.updated_at);
      dailyEntryIds.set(row.id, Number(inserted.lastInsertRowid));
    }
    for (const row of data['weights.json']) {
      const dailyEntryId = dailyEntryIds.get(row.daily_entry_id);
      if (dailyEntryId === undefined) continue;
      const inserted = db.prepare(`INSERT INTO weight_measurements (daily_entry_id, measured_at, weight_kg, note)
        VALUES (?, ?, ?, ?)`)
        .run(dailyEntryId, row.measured_at, row.weight_kg, row.note);
      weightIds.set(row.id, Number(inserted.lastInsertRowid));
    }
    for (const row of data['meals.json']) {
      const dailyEntryId = dailyEntryIds.get(row.daily_entry_id);
      if (dailyEntryId === undefined) continue;
      const inserted = db.prepare(`INSERT INTO meals (daily_entry_id, eaten_at, meal_type, notes, recognition_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(dailyEntryId, row.eaten_at, row.meal_type, row.notes, row.recognition_status, row.created_at, row.updated_at);
      mealIds.set(row.id, Number(inserted.lastInsertRowid));
    }
    for (const row of data['meal-images.json']) {
      const mealId = mealIds.get(row.meal_id);
      if (mealId === undefined) continue;
      const sourceProfileId = data['meals.json'].find((meal) => meal.id === row.meal_id);
      const sourceEntry = sourceProfileId && data['daily-entries.json'].find((entry) => entry.id === sourceProfileId.daily_entry_id);
      const targetProfileId = sourceEntry && profileIds.get(sourceEntry.profile_id);
      if (targetProfileId === undefined) validationError();
      const relativePath = `images/profile-${targetProfileId}/${imageFileName(row.relative_path)}`;
      const inserted = db.prepare(`INSERT INTO meal_images (meal_id, relative_path, mime_type, file_size, created_at)
        VALUES (?, ?, ?, ?, ?)`)
        .run(mealId, relativePath, row.mime_type, row.file_size, row.created_at);
      mealImageIds.set(row.id, Number(inserted.lastInsertRowid));
    }
    for (const row of data['food-items.json']) {
      const mealId = mealIds.get(row.meal_id);
      if (mealId === undefined) continue;
      const inserted = db.prepare(`INSERT INTO food_items (meal_id, name, amount, unit, cooking_method, confidence,
        needs_confirmation, is_user_confirmed, source, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(mealId, row.name, row.amount, row.unit, row.cooking_method, row.confidence,
          Number(row.needs_confirmation), Number(row.is_user_confirmed), row.source, row.notes);
      foodItemIds.set(row.id, Number(inserted.lastInsertRowid));
    }
    for (const row of data['workouts.json']) {
      const dailyEntryId = dailyEntryIds.get(row.daily_entry_id);
      if (dailyEntryId === undefined) continue;
      const inserted = db.prepare(`INSERT INTO workouts (daily_entry_id, started_at, workout_type, duration_minutes, perceived_difficulty, notes)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(dailyEntryId, row.started_at, row.workout_type, row.duration_minutes, row.perceived_difficulty, row.notes);
      workoutIds.set(row.id, Number(inserted.lastInsertRowid));
    }
    for (const row of data['exercises.json']) {
      const workoutId = workoutIds.get(row.workout_id);
      if (workoutId === undefined) continue;
      const inserted = db.prepare(`INSERT INTO exercises (workout_id, name, weight, weight_unit, sets, repetitions, completed, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(workoutId, row.name, row.weight, row.weight_unit, row.sets, row.repetitions, Number(row.completed), row.notes);
      exerciseIds.set(row.id, Number(inserted.lastInsertRowid));
    }
    for (const row of data['body-feedback.json']) {
      const dailyEntryId = dailyEntryIds.get(row.daily_entry_id);
      if (dailyEntryId === undefined) continue;
      const inserted = db.prepare(`INSERT INTO body_feedback (daily_entry_id, recorded_at, category, body_part, severity, impact, description, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(dailyEntryId, row.recorded_at, row.category, row.body_part, row.severity, row.impact, row.description, row.created_at);
      feedbackIds.set(row.id, Number(inserted.lastInsertRowid));
    }
    for (const row of data['recommendations.json']) {
      if (!importedSourceIds.has(row.profile_id)) continue;
      const fields = recommendationFields.filter((field) => field !== 'id');
      const inserted = db.prepare(`INSERT INTO recommendations (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`)
        .run(...fields.map((field) => field === 'profile_id' ? profileIds.get(row.profile_id) : row[field]));
      recommendationIds.set(row.id, Number(inserted.lastInsertRowid));
    }
    return { results, profileIds };
  }

  async function stageImportImages(
    validated: ReturnType<typeof parseAndValidateArchive>,
    plans: ProfileImportPlan[],
    temporaryRoot: string,
  ) {
    assertSafeImagesRoot(dataDir);
    assertLocalPath(dataDir, temporaryRoot);
    const importedSourceIds = new Set(plans.filter((plan) => plan.strategy !== 'skip').map((plan) => plan.source.id));
    for (const sourceId of importedSourceIds) {
      await mkdir(join(temporaryRoot, `profile-source-${sourceId}`), { recursive: true, mode: 0o700 });
    }
    for (const image of validated.manifest.images) {
      if (!importedSourceIds.has(image.profile_id)) continue;
      const directory = join(temporaryRoot, `profile-source-${image.profile_id}`);
      const bytes = validated.imageBytes.get(image.path);
      if (!bytes) validationError();
      await writeFile(join(directory, imageFileName(image.path)), bytes, { flag: 'wx', mode: 0o600 });
    }
  }

  async function replaceImageDirectories(
    moves: Array<{ target: string; staged?: string; backup?: string; installed: boolean }>,
    persist: () => void,
  ) {
    const { root } = assertSafeImagesRoot(dataDir);
    for (const move of moves) {
      if (!move.staged) throw new Error('Profile import journal is missing a staged directory');
      assertSafeProfileDirectory(dataDir, move.target, root);
      assertLocalPath(dataDir, move.staged);
      if (move.backup) assertLocalPath(dataDir, move.backup);
      const stagedMetadata = await lstat(move.staged);
      if (!stagedMetadata.isDirectory() || stagedMetadata.isSymbolicLink()) validationError('Profile image directory is unsafe');
      let targetExists = false;
      try {
        const metadata = await lstat(move.target);
        targetExists = true;
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) validationError('Profile image directory is unsafe');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (targetExists) {
        if (!move.backup) throw new ApiError('VALIDATION_ERROR', 'Profile image directory state changed');
        await rename(move.target, move.backup);
        persist();
      }
      move.installed = true;
      persist();
      await rename(move.staged, move.target);
      persist();
    }
    return moves;
  }

  async function restoreImageDirectories(
    moves: Array<{ target: string; staged?: string; backup?: string; installed: boolean }>,
  ) {
    const failures: string[] = [];
    for (const move of [...moves].reverse()) {
      try {
        assertSafeImagesRoot(dataDir);
        assertLocalPath(dataDir, move.target);
        if (move.staged) assertLocalPath(dataDir, move.staged);
        if (move.backup) assertLocalPath(dataDir, move.backup);
        const targetMetadata = await lstat(move.target).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
        const stagedMetadata = move.staged
          ? await lstat(move.staged).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
          })
          : undefined;
        const backupMetadata = move.backup
          ? await lstat(move.backup).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
          })
          : undefined;
        if (targetMetadata && (!stagedMetadata || backupMetadata)) {
          if (targetMetadata.isSymbolicLink() || !targetMetadata.isDirectory()) throw new Error('unsafe target directory');
          await rm(move.target, { recursive: true, force: true });
        }
        if (backupMetadata) {
          if (backupMetadata.isSymbolicLink() || !backupMetadata.isDirectory()) throw new Error('unsafe backup directory');
          await rename(move.backup!, move.target);
        }
      } catch (error) {
        failures.push(`${move.target}: ${error instanceof Error ? error.message : 'restore failed'}`);
      }
    }
    return failures;
  }

  function readJournal() {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(profileImportJournalKey) as { value: string } | undefined;
    if (!row) return undefined;
    try {
      const journal = JSON.parse(row.value) as ImportJournal;
      if (
        journal.version !== 1
        || !['prepared', 'database_committed', 'files_installed'].includes(journal.phase)
        || typeof journal.temporaryRoot !== 'string'
        || !Array.isArray(journal.insertedProfileIds)
        || !Array.isArray(journal.snapshots)
        || !Array.isArray(journal.moves)
      ) throw new Error('invalid journal shape');
      const dataRoot = realpathSync(dataDir);
      const canonicalJournalPath = (path: string) => {
        const candidate = resolve(path);
        try {
          const resolved = realpathSync(candidate);
          if (!pathIsWithin(dataRoot, resolved)) throw new Error('path is outside the data directory');
          return resolved;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          assertLocalPath(dataDir, candidate);
          return candidate;
        }
      };
      journal.temporaryRoot = canonicalJournalPath(journal.temporaryRoot);
      const temporaryRelative = relative(dataRoot, journal.temporaryRoot);
      if (!isAbsolute(journal.temporaryRoot) || temporaryRelative.startsWith('..')) throw new Error('invalid temporary root');
      for (const move of journal.moves) {
        if (typeof move.target !== 'string' || (move.staged !== undefined && typeof move.staged !== 'string') || typeof move.installed !== 'boolean') throw new Error('invalid move shape');
        move.target = canonicalJournalPath(move.target);
        if (move.staged !== undefined) move.staged = canonicalJournalPath(move.staged);
        if (move.backup !== undefined) move.backup = canonicalJournalPath(move.backup);
        if (!isAbsolute(move.target) || relative(realpathSync(dataDir), move.target).startsWith('..')) throw new Error('invalid move target');
        if (move.staged !== undefined && (!isAbsolute(move.staged) || relative(realpathSync(dataDir), move.staged).startsWith('..'))) throw new Error('invalid staged path');
        if (move.backup !== undefined && (!isAbsolute(move.backup) || relative(realpathSync(dataDir), move.backup).startsWith('..'))) throw new Error('invalid backup path');
      }
      return journal;
    } catch (error) {
      throw new Error(`Profile import journal is invalid: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  function writeJournal(journal: ImportJournal) {
    db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(profileImportJournalKey, JSON.stringify(journal));
  }

  function clearJournal() {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(profileImportJournalKey);
  }

  function rollbackJournalDatabase(journal: ImportJournal) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const profileId of [...journal.insertedProfileIds].reverse()) db.prepare('DELETE FROM profiles WHERE id = ?').run(profileId);
      for (const snapshot of journal.snapshots) restoreSnapshot(snapshot);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async function cleanTemporaryRoot(temporaryRoot: string) {
    assertLocalPath(dataDir, temporaryRoot);
    const metadata = await lstat(temporaryRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!metadata) return;
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Temporary import directory is unsafe');
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  async function recoverImport() {
    const journal = readJournal();
    if (!journal) return { cleanup_failures: [] as string[] };
    const cleanupFailures: string[] = [];
    if (journal.phase !== 'files_installed') {
      const failures = await restoreImageDirectories(journal.moves);
      cleanupFailures.push(...failures);
      if (journal.phase === 'database_committed') rollbackJournalDatabase(journal);
    }
    try {
      await cleanTemporaryRoot(journal.temporaryRoot);
    } catch (error) {
      cleanupFailures.push(`temporary import files: ${error instanceof Error ? error.message : 'cleanup failed'}`);
    }
    if (cleanupFailures.length === 0) clearJournal();
    else {
      journal.cleanup_failures = cleanupFailures;
      writeJournal(journal);
    }
    return { cleanup_failures: cleanupFailures };
  }

  return {
    recoverImport,
    async exportProfiles(inputProfileIds: number[]) {
      const profileIds = [...new Set(inputProfileIds)];
      const selected = database.transaction(() => {
        const profiles = selectRows(database, 'profiles', profileFields, 'id', profileIds);
        if (profiles.length !== profileIds.length) throw new ApiError('NOT_FOUND', 'One or more selected profiles were not found');

        const dailyEntries = selectRows(database, 'daily_entries', dailyEntryFields, 'profile_id', profileIds);
        const dailyEntryIds = dailyEntries.map((row) => Number(row.id));
        const weights = selectRows(database, 'weight_measurements', weightFields, 'daily_entry_id', dailyEntryIds);
        const meals = selectRows(database, 'meals', mealFields, 'daily_entry_id', dailyEntryIds);
        const mealIds = meals.map((row) => Number(row.id));
        const mealImages = selectImageRows(database, mealIds);
        const foodItems = selectRows(database, 'food_items', foodItemFields, 'meal_id', mealIds);
        const workouts = selectRows(database, 'workouts', workoutFields, 'daily_entry_id', dailyEntryIds);
        const workoutIds = workouts.map((row) => Number(row.id));
        const exercises = selectRows(database, 'exercises', exerciseFields, 'workout_id', workoutIds);
        const bodyFeedback = selectRows(database, 'body_feedback', feedbackFields, 'daily_entry_id', dailyEntryIds);
        const recommendations = selectRows(database, 'recommendations', recommendationFields, 'profile_id', profileIds);
        const packageImages = new Map<string, Buffer>();
        const exportedMealImages = [] as Row[];
        const manifestImages = [] as ExportImage[];
        for (const image of mealImages) {
          const profileId = Number(image.profile_id);
          const sourcePath = String(image.relative_path);
          const bytes = readProfileImage(dataDir, profileId, sourcePath);
          const fileName = sourcePath.split('/')[2]!;
          const packagePath = `images/${profileId}/${fileName}`;
          packageImages.set(packagePath, bytes);
          if (!manifestImages.some((item) => item.path === packagePath)) {
            manifestImages.push({ profile_id: profileId, path: packagePath, size: bytes.length, sha256: hash(bytes) });
          }
          exportedMealImages.push({ ...asJsonRow(image, mealImageFields), relative_path: packagePath, file_size: bytes.length });
        }
        return { profiles, dailyEntries, weights, meals, mealImages: exportedMealImages, foodItems, workouts, exercises, bodyFeedback, recommendations, packageImages, manifestImages };
      })();

      const jsonData = {
        profiles: selected.profiles.map((row) => asJsonRow(row, profileFields)),
        dailyEntries: selected.dailyEntries.map((row) => asJsonRow(row, dailyEntryFields)),
        weights: selected.weights.map((row) => asJsonRow(row, weightFields)),
        meals: selected.meals.map((row) => asJsonRow(row, mealFields)),
        mealImages: selected.mealImages,
        foodItems: booleanJsonRows(selected.foodItems, foodItemFields, ['needs_confirmation', 'is_user_confirmed']),
        workouts: selected.workouts.map((row) => asJsonRow(row, workoutFields)),
        exercises: booleanJsonRows(selected.exercises, exerciseFields, ['completed']),
        bodyFeedback: selected.bodyFeedback.map((row) => asJsonRow(row, feedbackFields)),
        recommendations: selected.recommendations.map((row) => asJsonRow(row, recommendationFields)),
      };
      const counts = {
        profiles: jsonData.profiles.length,
        daily_entries: jsonData.dailyEntries.length,
        weight_measurements: jsonData.weights.length,
        meals: jsonData.meals.length,
        meal_images: jsonData.mealImages.length,
        food_items: jsonData.foodItems.length,
        workouts: jsonData.workouts.length,
        exercises: jsonData.exercises.length,
        body_feedback: jsonData.bodyFeedback.length,
        recommendations: jsonData.recommendations.length,
      };
      const schemaVersion = getSchemaVersion(database);
      const manifest = {
        format: 'fitness-coach-profile-transfer',
        version: 1,
        created_at: new Date().toISOString(),
        schema_version: schemaVersion,
        profiles: jsonData.profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          status: profile.status,
        })),
        counts,
        images: selected.manifestImages,
      };
      const entries: ArchiveEntry[] = [
        { path: 'manifest.json', bytes: jsonBytes(manifest) },
        { path: 'schema-version.json', bytes: jsonBytes({ schema_version: schemaVersion }) },
        ...jsonFilenames.map((filename) => ({
          path: filename,
          bytes: jsonBytes(jsonData[jsonFileDataKeys[filename]]),
        })),
        ...[...selected.packageImages.entries()].map(([path, bytes]) => ({ path, bytes })),
      ];
      const archive = gzipSync(createTar(entries));
      const timestamp = new Date().toISOString().replace(/[T:.]/g, '-').replace(/Z$/, '');
      return { filename: `profiles-${timestamp}-${randomBytes(4).toString('hex')}.tar.gz`, archive };
    },
    async previewImport(input: { filename: string; mime_type: string; bytes: Uint8Array }) {
      try {
        cleanupPendingImports();
        if (!input || typeof input.filename !== 'string' || typeof input.mime_type !== 'string' || !(input.bytes instanceof Uint8Array)) validationError('Import file is missing');
        const archive = Buffer.from(input.bytes);
        const validated = parseAndValidateArchive(archive, db);
        cleanupPendingImports();
        const importId = randomBytes(24).toString('base64url');
        pendingImports.set(importId, { archive, expiresAt: Date.now() + IMPORT_TTL_MS });
        return {
          importId,
          manifest: validated.manifest,
          profileStats: validated.stats,
          conflicts: findConflicts(db, validated.data['profiles.json']),
        };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError('VALIDATION_ERROR', 'Profile transfer package is invalid');
      }
    },
    async executeImport(input: { importId: string; resolutions?: ImportResolution[] }) {
      if (executeImportInProgress) throw new ApiError('CONFLICT', 'Another profile import is already executing');
      executeImportInProgress = true;
      try {
      if (db.prepare('SELECT 1 FROM app_settings WHERE key = ?').get(profileImportJournalKey)) {
        throw new ApiError('CONFLICT', 'Profile import recovery is required before another import can execute');
      }
      cleanupPendingImports();
      const pending = pendingImports.get(input.importId);
      if (!pending || pending.expiresAt <= Date.now()) {
        pendingImports.delete(input.importId);
        throw new ApiError('NOT_FOUND', 'Profile import is unavailable or expired');
      }
      pendingImports.delete(input.importId);

      const temporaryRoot = join(dataDir, `.profile-import-${randomBytes(16).toString('hex')}`);
      let journal: ImportJournal | undefined;
      let transactionStarted = false;
      let transactionCommitted = false;
      try {
        const validated = parseAndValidateArchive(pending.archive, db);
        const plans = planImport(validated.data, input.resolutions);
        assertSafeImagesRoot(dataDir);
        assertLocalPath(dataDir, temporaryRoot);
        await mkdir(temporaryRoot, { mode: 0o700 });
        await stageImportImages(validated, plans, temporaryRoot);
        const snapshots = plans
          .filter((plan) => plan.strategy === 'overwrite' && plan.existingProfileId !== undefined)
          .map((plan) => snapshotProfile(plan.existingProfileId!));

        journal = {
          version: 1,
          phase: 'prepared',
          temporaryRoot,
          insertedProfileIds: [],
          snapshots,
          moves: [],
        };
        db.transaction(() => writeJournal(journal!))();

        db.exec('BEGIN IMMEDIATE');
        transactionStarted = true;
        const current = currentProfileId();
        if (plans.some((plan) => plan.strategy === 'overwrite' && plan.existingProfileId === current)) {
          throw new ApiError('CONFLICT', 'Current profile cannot be overwritten');
        }
        const inserted = insertArchive(validated.data, plans, currentProfileId);
        const root = join(dataDir, 'images');
        const moves = plans.flatMap((plan) => {
          if (plan.strategy === 'skip') return [];
          const targetProfileId = inserted.profileIds.get(plan.source.id);
          if (targetProfileId === undefined) validationError();
          const target = join(root, `profile-${targetProfileId}`);
          const staged = join(temporaryRoot, `profile-source-${plan.source.id}`);
          const targetExists = (() => {
            try {
              const metadata = lstatSync(target);
              if (!metadata.isDirectory() || metadata.isSymbolicLink()) validationError('Profile image directory is unsafe');
              return true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
              throw error;
            }
          })();
          return [{
            target,
            staged,
            ...(targetExists ? { backup: join(temporaryRoot, `.backup-profile-${targetProfileId}`) } : {}),
            installed: false,
          }];
        });
        journal.phase = 'database_committed';
        journal.insertedProfileIds = [...inserted.profileIds.values()];
        journal.moves = moves;
        writeJournal(journal);
        db.exec('COMMIT');
        transactionCommitted = true;
        await replaceImageDirectories(journal.moves, () => writeJournal(journal!));
        journal.phase = 'files_installed';
        writeJournal(journal);
        const cleanupFailures: string[] = [];
        try {
          await cleanTemporaryRoot(temporaryRoot);
        } catch (cleanupError) {
          cleanupFailures.push(`temporary import files: ${cleanupError instanceof Error ? cleanupError.message : 'cleanup failed'}`);
        }
        if (cleanupFailures.length === 0) clearJournal();
        else {
          journal.cleanup_failures = cleanupFailures;
          writeJournal(journal);
        }
        return {
          results: inserted.results,
          ...(cleanupFailures.length === 0 ? {} : { cleanup_failures: cleanupFailures }),
        };
      } catch (error) {
        if (transactionStarted && !transactionCommitted) {
          try {
            db.exec('ROLLBACK');
          } catch {
            // The original import error remains the actionable failure.
          }
        }
        const cleanupFailures: string[] = [];
        if (transactionCommitted && journal) {
          try {
            cleanupFailures.push(...(await restoreImageDirectories(journal.moves)));
          } catch (cleanupError) {
            cleanupFailures.push(`image restore: ${cleanupError instanceof Error ? cleanupError.message : 'restore failed'}`);
          }
          try {
            rollbackJournalDatabase(journal);
          } catch (cleanupError) {
            cleanupFailures.push(`database restore: ${cleanupError instanceof Error ? cleanupError.message : 'restore failed'}`);
          }
        }
        try {
          await cleanTemporaryRoot(temporaryRoot);
        } catch (cleanupError) {
          cleanupFailures.push(`temporary import files: ${cleanupError instanceof Error ? cleanupError.message : 'cleanup failed'}`);
        }
        if (cleanupFailures.length > 0) {
          if (journal) {
            journal.cleanup_failures = cleanupFailures;
            writeJournal(journal);
          }
          throw new ApiError('INTERNAL_ERROR', `Profile import cleanup failed: ${cleanupFailures.join('; ')}`);
        }
        if (journal) clearJournal();
        if (error instanceof ApiError) throw error;
        throw new ApiError('INTERNAL_ERROR', 'Profile import failed');
      }
      } finally {
        executeImportInProgress = false;
      }
    },
  };
}
