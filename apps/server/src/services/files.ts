import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, rm, rmdir, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { idParamsSchema, imageUploadSchema } from '@fitness-coach/shared';
import { ApiError, internalError, notFound, payloadTooLarge } from '../errors.js';
import type { ServiceContext } from './context.js';

const maxImageSize = 10 * 1024 * 1024;

function unsafePath(): never {
  throw new Error('Stored image path is unsafe');
}

function imageParts(relativePath: string) {
  if (relativePath.startsWith('/') || relativePath.includes('\0')) unsafePath();
  const parts = relativePath.split(/[\\/]/);
  if (parts.length < 2 || parts[0] !== 'images' || parts.some((part) => !part || part === '.' || part === '..')) unsafePath();
  return parts;
}

type DirectorySnapshot = {
  root: string;
  images: string;
  rootDev: number;
  rootIno: number;
  dev: number;
  ino: number;
};

function isInside(directory: string, path: string) {
  const child = relative(directory, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function safeImagesDirectory(dataDir: string) {
  const configuredRoot = resolve(dataDir);
  const configuredMetadata = await lstat(configuredRoot);
  if (configuredMetadata.isSymbolicLink() || !configuredMetadata.isDirectory()) unsafePath();
  const root = await realpath(configuredRoot);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) unsafePath();
  const currentRootMetadata = await lstat(configuredRoot);
  if (
    currentRootMetadata.isSymbolicLink()
    || !currentRootMetadata.isDirectory()
    || currentRootMetadata.dev !== configuredMetadata.dev
    || currentRootMetadata.ino !== configuredMetadata.ino
    || (await realpath(configuredRoot)) !== root
  ) unsafePath();
  const images = join(root, 'images');
  const metadata = await lstat(images);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) unsafePath();
  const canonicalImages = await realpath(images);
  if (canonicalImages !== images || !isInside(root, canonicalImages)) unsafePath();
  const currentImagesMetadata = await lstat(images);
  if (
    currentImagesMetadata.isSymbolicLink()
    || !currentImagesMetadata.isDirectory()
    || currentImagesMetadata.dev !== metadata.dev
    || currentImagesMetadata.ino !== metadata.ino
    || (await realpath(images)) !== canonicalImages
  ) unsafePath();
  return {
    root,
    images: canonicalImages,
    rootDev: rootMetadata.dev,
    rootIno: rootMetadata.ino,
    dev: metadata.dev,
    ino: metadata.ino,
  } satisfies DirectorySnapshot;
}

async function assertSafeImagesDirectory(dataDir: string, expected?: DirectorySnapshot) {
  const actual = await safeImagesDirectory(dataDir);
  if (expected && (
    actual.root !== expected.root
    || actual.images !== expected.images
    || actual.rootDev !== expected.rootDev
    || actual.rootIno !== expected.rootIno
    || actual.dev !== expected.dev
    || actual.ino !== expected.ino
  )) {
    unsafePath();
  }
  return actual;
}

async function assertSafePath(
  dataDir: string,
  directory: DirectorySnapshot,
  path: string,
  allowMissingFinal = false,
  allowDirectoryFinal = false,
) {
  await assertSafeImagesDirectory(dataDir, directory);
  if (!isInside(directory.images, path)) unsafePath();
  const parts = relative(directory.images, path).split(sep);
  let current = directory.images;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) unsafePath();
      if (index < parts.length - 1 && !metadata.isDirectory()) unsafePath();
      if (index === parts.length - 1 && !metadata.isFile() && !(allowDirectoryFinal && metadata.isDirectory())) unsafePath();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissingFinal && index === parts.length - 1) {
        await assertSafeImagesDirectory(dataDir, directory);
        return;
      }
      throw error;
    }
  }
  const canonical = await realpath(path);
  if (!isInside(directory.images, canonical)) unsafePath();
  await assertSafeImagesDirectory(dataDir, directory);
}

async function assertSafeEntryPath(
  dataDir: string,
  directory: DirectorySnapshot,
  path: string,
  allowMissingFinal = false,
  allowDirectoryFinal = false,
) {
  try {
    await assertSafePath(dataDir, directory, path, allowMissingFinal, allowDirectoryFinal);
  } catch (error) {
    if (allowDirectoryFinal && (error as NodeJS.ErrnoException).code === 'EISDIR') {
      await assertSafeImagesDirectory(dataDir, directory);
      return;
    }
    throw error;
  }
}

async function resolveStoredPath(dataDir: string, relativePath: string) {
  const parts = imageParts(relativePath);
  const directory = await safeImagesDirectory(dataDir);
  const { root, images } = directory;
  let current = images;
  for (const part of parts.slice(1)) {
    current = join(current, part);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) unsafePath();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { root, images, path: current, directory, missing: true };
      }
      throw error;
    }
  }
  const canonical = await realpath(current);
  if (!isInside(images, canonical)) unsafePath();
  await assertSafeImagesDirectory(dataDir, directory);
  return { root, images, path: current, directory, missing: false };
}

async function writeExclusive(path: string, bytes: Uint8Array) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

async function assertSafeRegularFile(path: string) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await handle.stat()).isFile()) unsafePath();
  } finally {
    await handle.close();
  }
}

type StagedImage = {
  imageId: number;
  originalPath: string;
  tombstonePath?: string;
  missing: boolean;
  directory: DirectorySnapshot;
};

type ImageRecord = {
  id: number;
  meal_id?: number;
  relative_path: string;
  mime_type: string;
  file_size: number;
  created_at?: string;
};

export function createFilesService({ repositories, dataDir }: ServiceContext) {
  const profileDirectory = (images: string, profileId: number) => join(images, `profile-${profileId}`);
  async function stageImage(image: { id: number; relative_path: string }): Promise<StagedImage> {
    const resolved = await resolveStoredPath(dataDir, image.relative_path);
    if (resolved.missing) return { imageId: image.id, originalPath: resolved.path, missing: true, directory: resolved.directory };
    const tombstonePath = join(dirname(resolved.path), `.deleted-${randomBytes(16).toString('hex')}`);
    await safeRename(resolved.directory, resolved.path, tombstonePath, true);
    return { imageId: image.id, originalPath: resolved.path, tombstonePath, missing: false, directory: resolved.directory };
  }

  async function rollback(staged: StagedImage[]) {
    const failures: StagedImage[] = [];
    for (const image of staged) {
      if (!image.tombstonePath) continue;
      try {
        await safeRename(image.directory, image.tombstonePath, image.originalPath, true);
      } catch {
        failures.push(image);
      }
    }
    if (failures.length > 0) internalError('Unable to restore image files after database deletion failed');
  }

  async function discard(staged: StagedImage[]) {
    const pending: StagedImage[] = [];
    for (const image of staged) {
      if (!image.tombstonePath) continue;
      try {
        await assertSafeEntryPath(dataDir, image.directory, image.tombstonePath, false, true);
        await rm(image.tombstonePath, { force: false, recursive: false });
        await assertSafeImagesDirectory(dataDir, image.directory);
      } catch {
        pending.push(image);
      }
    }
    return pending;
  }

  async function openImage(image: ImageRecord): Promise<{ handle: FileHandle; directory: DirectorySnapshot }> {
    const resolved = await resolveStoredPath(dataDir, image.relative_path);
    if (resolved.missing) notFound('Image file not found');
    await assertSafePath(dataDir, resolved.directory, resolved.path);
    let handle: FileHandle | undefined;
    try {
      handle = await open(resolved.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      await assertSafePath(dataDir, resolved.directory, resolved.path);
      if (!(await handle.stat()).isFile()) unsafePath();
      return { handle, directory: resolved.directory };
    } catch (error) {
      await handle?.close();
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') notFound('Image file not found');
      throw error;
    }
  }

  async function readImage(image: ImageRecord) {
    const { handle, directory } = await openImage(image);
    try {
      const bytes = await handle.readFile();
      await assertSafeImagesDirectory(dataDir, directory);
      return { image, bytes };
    } finally {
      await handle.close();
    }
  }

  async function imageStatus(image: ImageRecord) {
    try {
      const { handle, directory } = await openImage(image);
      await handle.close();
      await assertSafeImagesDirectory(dataDir, directory);
      return image;
    } catch {
      return { ...image, warning: 'FILE_MISSING' as const };
    }
  }

  async function safeRename(directory: DirectorySnapshot, sourcePath: string, targetPath: string, allowDirectorySource = false) {
    await assertSafePath(dataDir, directory, sourcePath, false, allowDirectorySource);
    if (!allowDirectorySource) await assertSafeRegularFile(sourcePath);
    await assertSafePath(dataDir, directory, targetPath, true, allowDirectorySource);
    await rename(sourcePath, targetPath);
    await assertSafeImagesDirectory(dataDir, directory);
    await assertSafePath(dataDir, directory, targetPath, false, allowDirectorySource);
    if (!allowDirectorySource) await assertSafeRegularFile(targetPath);
  }

  async function safeRemove(directory: DirectorySnapshot, path: string) {
    try {
      await assertSafePath(dataDir, directory, path);
      await assertSafeRegularFile(path);
      await rm(path, { force: false, recursive: false });
      await assertSafeImagesDirectory(dataDir, directory);
      return true;
    } catch {
      return false;
    }
  }

  async function deleteMeal(mealIdInput: unknown, parentId?: number) {
    const { id } = idParamsSchema.parse({ id: mealIdInput });
    const meal = parentId === undefined ? repositories.meal.get(id) : repositories.meal.getForParent(parentId, id);
    if (!meal) notFound(parentId === undefined ? 'Meal not found' : 'Meal not found for this date');
    const images = repositories.image.listForEntry(id);
    const staged: StagedImage[] = [];
    let deleted: ReturnType<typeof repositories.meal.delete>;
    try {
      for (const image of images) staged.push(await stageImage(image));
      for (const image of staged) await assertSafeImagesDirectory(dataDir, image.directory);
      deleted = parentId === undefined ? repositories.meal.delete(id) : repositories.meal.deleteForParent(parentId, id);
      if (!deleted) {
        notFound('Meal not found');
      }
    } catch (error) {
      await rollback(staged);
      throw error;
    }
    const pending = await discard(staged);
    if (pending.length > 0) return { ...deleted!, warning: 'CLEANUP_PENDING' as const };
    return staged.some((image) => image.missing) ? { ...deleted!, warning: 'FILE_MISSING' as const } : deleted;
  }

  return {
    async upload(mealIdInput: unknown, file: { filename: string; mime_type: string; bytes: Uint8Array; file_size: number }, profileId: number) {
      const { id: mealId } = idParamsSchema.parse({ id: mealIdInput });
      const uploadRepositories = repositories.forProfile(profileId);
      if (!uploadRepositories.meal.get(mealId)) notFound('Meal not found');
      if (file.bytes.length > maxImageSize) payloadTooLarge('Image is too large');
      const parsed = imageUploadSchema.parse(file);
      const { root, images } = await safeImagesDirectory(dataDir);
      const profileImages = profileDirectory(images, profileId);
      let createdProfileImages = false;
      try {
        const existing = await lstat(profileImages);
        if (!existing.isDirectory() || existing.isSymbolicLink()) unsafePath();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try {
          await mkdir(profileImages, { recursive: false, mode: 0o700 });
          createdProfileImages = true;
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
        }
      }
      const profileDirectoryMetadata = await lstat(profileImages);
      if (!profileDirectoryMetadata.isDirectory() || profileDirectoryMetadata.isSymbolicLink()) unsafePath();
      const extension = parsed.mime_type.slice('image/'.length).replace('jpeg', 'jpg');
      const filename = `${randomBytes(16).toString('hex')}.${extension}`;
      const absolutePath = join(profileImages, filename);
      const relativePath = relative(root, absolutePath);
      const temporaryPath = join(profileImages, `.${filename}.${randomBytes(8).toString('hex')}.tmp`);
      const metadata = await lstat(images);
      const directory = {
        root,
        images,
        rootDev: (await lstat(root)).dev,
        rootIno: (await lstat(root)).ino,
        dev: metadata.dev,
        ino: metadata.ino,
      } satisfies DirectorySnapshot;
      try {
        await assertSafeImagesDirectory(dataDir, directory);
        await writeExclusive(temporaryPath, parsed.bytes);
        await assertSafePath(dataDir, directory, temporaryPath);
        await safeRename(directory, temporaryPath, absolutePath);
        const saved = uploadRepositories.image.register(mealId, {
          relative_path: relativePath,
          mime_type: parsed.mime_type,
          file_size: parsed.file_size,
        });
        if (!saved) notFound('Meal not found');
        return saved;
      } catch (error) {
        await safeRemove(directory, temporaryPath);
        await safeRemove(directory, absolutePath);
        if (createdProfileImages) {
          try {
            await rmdir(profileImages);
          } catch (cleanupError) {
            if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((cleanupError as NodeJS.ErrnoException).code ?? '')) throw cleanupError;
          }
        }
        throw new Error('Unable to save image', { cause: error });
      }
    },
    async read(idInput: unknown) {
      const { id } = idParamsSchema.parse({ id: idInput });
      const image = repositories.image.get(id);
      if (!image) notFound('Image not found');
      return readImage(image);
    },
    async readForMeal(mealId: number, idInput: unknown) {
      const { id } = idParamsSchema.parse({ id: idInput });
      const image = repositories.image.get(id);
      if (!image) notFound('Image not found');
      if (image.meal_id !== mealId) throw new ApiError('VALIDATION_ERROR', 'Image does not belong to meal');
      return readImage(image);
    },
    async delete(idInput: unknown) {
      const { id } = idParamsSchema.parse({ id: idInput });
      const image = repositories.image.get(id);
      if (!image) notFound('Image not found');
      const staged = await stageImage(image);
      if (staged.missing) {
        await assertSafeImagesDirectory(dataDir, staged.directory);
        repositories.image.delete(id);
        return { ...image, warning: 'FILE_MISSING' as const };
      }
      try {
        const deleted = repositories.image.delete(id);
        if (!deleted) notFound('Image not found');
      } catch (error) {
        await rollback([staged]);
        throw error;
      }
      const pending = await discard([staged]);
      return pending.length > 0 ? { ...image, warning: 'CLEANUP_PENDING' as const } : image;
    },
    deleteMeal,
    imageStatus,
  };
}
