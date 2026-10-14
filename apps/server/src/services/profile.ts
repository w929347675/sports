import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { profileInputSchema, profileRecordInputSchema } from '@fitness-coach/shared';
import { ApiError, notFound } from '../errors.js';
import type { ServiceContext } from './context.js';

export function createProfileService({ repositories, profileScope, dataDir, recommendationJobs }: ServiceContext) {
  const profiles = profileScope?.baseRepositories.profiles ?? repositories.profiles;
  const profileCreateSchema = profileRecordInputSchema.omit({ status: true }).strict();
  const profilePatchSchema = profileCreateSchema.partial().refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });

  function parseId(input: unknown) {
    const id = Number(input);
    if (!Number.isInteger(id) || id <= 0) throw new ApiError('VALIDATION_ERROR', 'Invalid profile ID');
    return id;
  }

  function getOrThrow(input: unknown) {
    const profile = profiles.get(parseId(input));
    if (!profile) notFound('Profile not found');
    return profile;
  }

  function duplicateName(error: unknown): never {
    if (typeof error === 'object' && error !== null && 'code' in error && String(error.code).includes('SQLITE_CONSTRAINT')) {
      throw new ApiError('CONFLICT', 'Profile name already exists');
    }
    throw error;
  }

  function nonBlankName(name: string) {
    const trimmed = name.trim();
    if (!trimmed) throw new ApiError('VALIDATION_ERROR', 'Profile name is required');
    return trimmed;
  }

  function safeImagePath(relativePath: string) {
    if (!relativePath || relativePath.includes('\0')) throw new ApiError('VALIDATION_ERROR', 'Stored image path is unsafe');
    const parts = relativePath.split(/[\\/]/);
    if (parts.length < 2 || parts[0] !== 'images' || parts.some((part) => !part || part === '.' || part === '..')) {
      throw new ApiError('VALIDATION_ERROR', 'Stored image path is unsafe');
    }
    const imagesRoot = resolve(dataDir, 'images');
    const absolutePath = resolve(dataDir, ...parts);
    const child = relative(imagesRoot, absolutePath);
    if (!child || child === '..' || child.startsWith(`..${sep}`)) {
      throw new ApiError('VALIDATION_ERROR', 'Stored image path is unsafe');
    }
    return absolutePath;
  }

  async function cleanImages(paths: string[], profileIds: number[]) {
    const cleanup_failures: string[] = [];
    for (const relativePath of [...new Set(paths)]) {
      const profileId = profileIds.find((candidate) => relativePath.split(/[\\/]/)[1] === `profile-${candidate}`);
      if (profileId === undefined) {
        cleanup_failures.push(relativePath);
        continue;
      }
      const absolutePath = safeImagePath(relativePath);
      try {
        const metadata = await lstat(absolutePath);
        if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Not a regular file');
      } catch {
        cleanup_failures.push(relativePath);
      }
    }
    for (const profileId of profileIds) {
      const directoryPath = resolve(dataDir, 'images', `profile-${profileId}`);
      try {
        const metadata = await lstat(directoryPath);
        const imagesRoot = resolve(dataDir, 'images');
        const child = relative(imagesRoot, directoryPath);
        if (metadata.isSymbolicLink() || !metadata.isDirectory() || !child || child.startsWith(`..${sep}`)) throw new Error('Profile image directory is unsafe');
        await rm(directoryPath, { force: false, recursive: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanup_failures.push(`images/profile-${profileId}`);
      }
    }
    return cleanup_failures;
  }

  async function assertImageDirectoriesSafe(profileIds: number[]) {
    const root = resolve(dataDir);
    const images = resolve(root, 'images');
    const rootMetadata = await lstat(root);
    const imagesMetadata = await lstat(images);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory() || imagesMetadata.isSymbolicLink() || !imagesMetadata.isDirectory()) {
      throw new ApiError('VALIDATION_ERROR', 'Image storage path is unsafe');
    }
    const canonicalRoot = await realpath(root);
    const canonicalImages = await realpath(images);
    const imagesRelative = relative(canonicalRoot, canonicalImages);
    if (!imagesRelative || imagesRelative === '..' || imagesRelative.startsWith(`..${sep}`)) {
      throw new ApiError('VALIDATION_ERROR', 'Image storage path is unsafe');
    }

    async function inspect(directory: string) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const entryPath = join(directory, entry.name);
        const metadata = await lstat(entryPath);
        if (metadata.isSymbolicLink()) throw new ApiError('VALIDATION_ERROR', 'Image storage path is unsafe');
        if (metadata.isDirectory()) await inspect(entryPath);
        else if (!metadata.isFile()) throw new ApiError('VALIDATION_ERROR', 'Image storage path is unsafe');
        const canonicalEntry = await realpath(entryPath);
        const child = relative(canonicalImages, canonicalEntry);
        if (!child || child === '..' || child.startsWith(`..${sep}`)) throw new ApiError('VALIDATION_ERROR', 'Image storage path is unsafe');
      }
    }

    for (const profileId of profileIds) {
      const directory = join(canonicalImages, `profile-${profileId}`);
      try {
        const metadata = await lstat(directory);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new ApiError('VALIDATION_ERROR', 'Image storage path is unsafe');
        await inspect(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  return {
    get() {
      return profileScope?.currentProfile() ?? null;
    },
    upsert(input: unknown) {
      if (profiles.list().length > 0) {
        const current = profiles.currentId();
        const currentProfile = current === undefined ? undefined : profiles.get(current);
        if (currentProfile?.status === 'archived') throw new ApiError('PROFILE_ARCHIVED', 'Archived profiles are read-only');
        profileScope?.assertWritable();
      }
      const target = profiles.currentId();
      if (!target) {
        const created = profiles.create({ name: '默认档案', status: 'active', goal_description: '', ...profileInputSchema.parse(input) });
        profiles.setCurrentId(created.id);
        return created;
      }
      const saved = repositories.profile.save(profileInputSchema.parse(input));
      return profiles.get(saved.id) ?? saved;
    },
    list(options: Parameters<typeof profiles.listManaged>[0] = {}) {
      return profiles.listManaged(options);
    },
    getById(input: unknown) {
      return profiles.details(parseId(input)) ?? notFound('Profile not found');
    },
    create(input: unknown) {
      const parsed = profileCreateSchema.parse(input);
      try {
        const created = profiles.createAndSetCurrent({ ...parsed, name: nonBlankName(parsed.name), status: 'active' });
        return created;
      } catch (error) {
        return duplicateName(error);
      }
    },
    patch(inputId: unknown, input: unknown) {
      const id = parseId(inputId);
      const current = getOrThrow(id);
      if (current.status !== 'active') throw new ApiError('PROFILE_ARCHIVED', 'Archived profiles are read-only');
      const parsed = profilePatchSchema.parse(input);
      try {
        return profiles.update(id, { ...parsed, ...(parsed.name === undefined ? {} : { name: nonBlankName(parsed.name) }) })!;
      } catch (error) {
        return duplicateName(error);
      }
    },
    archive(input: unknown) {
      const id = parseId(input);
      const current = getOrThrow(id);
      if (profiles.currentId() === id) throw new ApiError('CONFLICT', 'Current profile cannot be archived');
      if (current.status === 'archived') throw new ApiError('CONFLICT', 'Profile is already archived');
      return profiles.archive(id) ?? notFound('Profile not found');
    },
    restore(input: unknown) {
      const id = parseId(input);
      const current = getOrThrow(id);
      if (current.status === 'active') throw new ApiError('CONFLICT', 'Profile is already active');
      try {
        return profiles.restore(id) ?? notFound('Profile not found');
      } catch (error) {
        return duplicateName(error);
      }
    },
    async remove(input: unknown) {
      if (!profileScope) throw new ApiError('CONFLICT', 'Profile scope is required');
      return profileScope.runProfileMutation(async () => {
        const ids = Array.isArray(input) ? input.map(parseId) : [parseId(input)];
        if (ids.length === 0) throw new ApiError('VALIDATION_ERROR', 'At least one profile ID is required');
        const uniqueIds = [...new Set(ids)];
        const currentId = profiles.currentId();
        if (currentId !== undefined && uniqueIds.includes(currentId)) {
          throw new ApiError('CONFLICT', 'Current profile cannot be deleted');
        }
        for (const id of uniqueIds) getOrThrow(id);
        try {
          for (const id of uniqueIds) await recommendationJobs?.cancelAndWaitForProfile(id);
          const imagePaths = profiles.imagePaths(uniqueIds);
          await assertImageDirectoriesSafe(uniqueIds);
          const currentBeforeDelete = profiles.currentId();
          if (currentBeforeDelete !== currentId || (currentBeforeDelete !== undefined && uniqueIds.includes(currentBeforeDelete))) {
            throw new ApiError('CONFLICT', 'Current profile cannot be deleted');
          }
          if (profiles.delete(uniqueIds, currentId ?? null) !== uniqueIds.length) {
            throw new ApiError('CONFLICT', 'Current profile cannot be deleted');
          }
          return { deleted: uniqueIds, cleanup_failures: await cleanImages(imagePaths, uniqueIds) };
        } finally {
          for (const id of uniqueIds) recommendationJobs?.finishProfileDeletion(id);
        }
      });
    },
  };
}
