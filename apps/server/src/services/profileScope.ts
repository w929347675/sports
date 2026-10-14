import { AsyncLocalStorage } from 'node:async_hooks';
import { ApiError, notFound } from '../errors.js';
import type { Repositories } from './context.js';

const scopedRepositories = new Set([
  'profile', 'dailyEntry', 'weight', 'meal', 'image', 'foodItem', 'workout', 'exercise', 'feedback', 'recommendation',
]);
const readMethods = new Set(['get', 'getByDate', 'list', 'listRange', 'listForEntry', 'getForParent', 'currentId', 'recoverProcessing']);

export function createProfileScope(repositories: Repositories) {
  const requestProfileId = new AsyncLocalStorage<number>();
  let mutationQueue = Promise.resolve();

  function runProfileMutation<T>(callback: () => Promise<T>) {
    const next = mutationQueue.then(callback, callback);
    mutationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  function lockedProfileId() {
    const profileId = requestProfileId.getStore();
    if (!profileId) throw new ApiError('CONFLICT', 'A current profile is required');
    return profileId;
  }

  function emptyScopedRepository(property: string) {
    return new Proxy({}, {
      get(_target, method) {
        return (..._args: unknown[]) => {
          if (typeof method === 'string' && readMethods.has(method)) {
            if (method === 'list' || method === 'listRange' || method === 'listForEntry') return [];
            if (method === 'recoverProcessing') return 0;
            return undefined;
          }
          throw new ApiError('CONFLICT', 'A current profile is required');
        };
      },
    }) as Repositories[keyof Repositories];
  }

  const scoped = new Proxy(repositories, {
    get(target, property, receiver) {
      if (typeof property !== 'string' || !scopedRepositories.has(property)) return Reflect.get(target, property, receiver);
      const profileId = requestProfileId.getStore() ?? target.profiles.currentId();
      if (!profileId) return emptyScopedRepository(property);
      return target.forProfile(profileId)[property as keyof ReturnType<Repositories['forProfile']>];
    },
  }) as Repositories;

  function currentProfile() {
    const id = requestProfileId.getStore() ?? repositories.profiles.currentId();
    return id === undefined ? undefined : repositories.profiles.get(id);
  }

  return {
    repositories: scoped,
    baseRepositories: repositories,
    lockCurrentProfile() {
      const profileId = repositories.profiles.currentId();
      if (!profileId) throw new ApiError('CONFLICT', 'A current profile is required');
      requestProfileId.enterWith(profileId);
      return profileId;
    },
    runWithCurrentProfile<T>(callback: () => Promise<T>): Promise<T> {
      const profileId = repositories.profiles.currentId();
      if (!profileId) return Promise.reject(new ApiError('CONFLICT', 'A current profile is required'));
      return requestProfileId.run(profileId, callback);
    },
    runWithOptionalCurrentProfile<T>(callback: () => Promise<T>): Promise<T> {
      const profileId = repositories.profiles.currentId();
      return profileId ? requestProfileId.run(profileId, callback) : callback();
    },
    currentProfile,
    currentProfileId() {
      return requestProfileId.getStore() ?? repositories.profiles.currentId();
    },
    setCurrentProfile(profileIdInput: unknown) {
      const profileId = Number(profileIdInput);
      if (!Number.isInteger(profileId) || profileId <= 0) throw new ApiError('VALIDATION_ERROR', 'Invalid profile ID');
      const profile = repositories.profiles.get(profileId);
      if (!profile) notFound('Profile not found');
      if (profile.status !== 'active') throw new ApiError('PROFILE_ARCHIVED', 'Archived profiles are read-only', 400);
      repositories.profiles.setCurrentId(profile.id);
      return profile;
    },
    runProfileMutation,
    assertWritable() {
      const id = requestProfileId.getStore() ?? repositories.profiles.currentId();
      if (id === undefined) return;
      const profile = repositories.profiles.get(id);
      if (!profile) throw new ApiError('CONFLICT', 'A current profile is required');
      if (profile.status === 'archived') throw new ApiError('PROFILE_ARCHIVED', 'Archived profiles are read-only', 409);
    },
  };
}
