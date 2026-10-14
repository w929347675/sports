import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories, migrate } from '@fitness-coach/db';
import { createFilesService } from './files.js';
import { createProfileScope } from './profileScope.js';

const profileInput = (name: string) => ({
  name, goal: 'maintain', goal_description: '', height_cm: 175, age: 30, sex: 'unspecified',
  training_experience: 'beginner', equipment: 'home', training_days_per_week: 3,
  session_duration_minutes: 45, diet_preferences: '', allergies: '', health_restrictions: '',
});

describe('files service profile binding', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('rejects a meal outside the immutable upload profile ID', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-files-profile-'));
    directories.push(dataDir);
    await mkdir(join(dataDir, 'images'));
    const database = new Database(':memory:');
    migrate(database);
    const repositories = createRepositories(database);
    const first = repositories.profiles.create(profileInput('First'));
    const second = repositories.profiles.create(profileInput('Second'));
    const entry = repositories.forProfile(second.id).dailyEntry.save({ entry_date: '2026-10-01', status: 'training' })!;
    const meal = repositories.forProfile(second.id).meal.save(entry.id, {
      eaten_at: '2026-10-01T12:00:00Z', meal_type: 'lunch', recognition_status: 'unrecognized',
    })!;
    const files = createFilesService({ repositories, dataDir });

    await expect(files.upload(meal.id, {
      filename: 'meal.png', mime_type: 'image/png', bytes: new Uint8Array([1]), file_size: 1,
    }, first.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(repositories.forProfile(second.id).image.listForEntry(meal.id)).toEqual([]);
    database.close();
  });

  it('uses one captured profile ID for the directory, path, and scoped database registration', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-files-captured-'));
    directories.push(dataDir);
    await mkdir(join(dataDir, 'images'));
    const database = new Database(':memory:');
    migrate(database);
    const baseRepositories = createRepositories(database);
    const first = baseRepositories.profiles.create(profileInput('Captured'));
    const second = baseRepositories.profiles.create(profileInput('Later current'));
    baseRepositories.profiles.setCurrentId(first.id);
    const entry = baseRepositories.forProfile(first.id).dailyEntry.save({ entry_date: '2026-10-01', status: 'training' })!;
    const meal = baseRepositories.forProfile(first.id).meal.save(entry.id, {
      eaten_at: '2026-10-01T12:00:00Z', meal_type: 'lunch', recognition_status: 'unrecognized',
    })!;
    const profileScope = createProfileScope(baseRepositories);
    const files = createFilesService({ repositories: profileScope.repositories, profileScope, dataDir });

    const saved = await profileScope.runWithCurrentProfile(async () => {
      const capturedId = profileScope.currentProfileId()!;
      baseRepositories.profiles.setCurrentId(second.id);
      return files.upload(meal.id, {
        filename: 'meal.png', mime_type: 'image/png', bytes: new Uint8Array([1]), file_size: 1,
      }, capturedId);
    });

    expect(saved.relative_path).toMatch(new RegExp(`^images/profile-${first.id}/`));
    expect(baseRepositories.forProfile(first.id).image.get(saved.id)).toMatchObject({ relative_path: saved.relative_path });
    expect(baseRepositories.forProfile(second.id).image.get(saved.id)).toBeUndefined();
    database.close();
  });

  it('does not remove a concurrent successful upload when another upload fails', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'fitness-coach-files-concurrent-'));
    directories.push(dataDir);
    await mkdir(join(dataDir, 'images'));
    const database = new Database(':memory:');
    migrate(database);
    const baseRepositories = createRepositories(database);
    const profile = baseRepositories.profiles.create(profileInput('Concurrent'));
    const scoped = baseRepositories.forProfile(profile.id);
    const entry = scoped.dailyEntry.save({ entry_date: '2026-10-01', status: 'training' })!;
    const failingMeal = scoped.meal.save(entry.id, {
      eaten_at: '2026-10-01T12:00:00Z', meal_type: 'lunch', recognition_status: 'unrecognized',
    })!;
    const successfulMeal = scoped.meal.save(entry.id, {
      eaten_at: '2026-10-01T18:00:00Z', meal_type: 'dinner', recognition_status: 'unrecognized',
    })!;
    const successfulRelativePath = `images/profile-${profile.id}/concurrent-success.png`;
    const originalForProfile = baseRepositories.forProfile.bind(baseRepositories);
    const failingRepositories = {
      ...baseRepositories,
      forProfile(profileId: number) {
        const repository = originalForProfile(profileId);
        if (profileId !== profile.id) return repository;
        return {
          ...repository,
          image: {
            ...repository.image,
            register(mealId: number, input: Parameters<typeof repository.image.register>[1]) {
              if (mealId !== failingMeal.id) return repository.image.register(mealId, input);
              writeFileSync(join(dataDir, successfulRelativePath), 'successful upload');
              repository.image.register(successfulMeal.id, {
                relative_path: successfulRelativePath, mime_type: 'image/png', file_size: 17,
              });
              throw new Error('simulated registration failure');
            },
          },
        };
      },
    } as typeof baseRepositories;
    const files = createFilesService({ repositories: failingRepositories, dataDir });

    await expect(files.upload(failingMeal.id, {
      filename: 'failing.png', mime_type: 'image/png', bytes: new Uint8Array([1]), file_size: 1,
    }, profile.id)).rejects.toThrow('Unable to save image');

    await expect(stat(join(dataDir, successfulRelativePath))).resolves.toBeDefined();
    expect(scoped.image.listForEntry(successfulMeal.id)).toEqual([
      expect.objectContaining({ relative_path: successfulRelativePath }),
    ]);
    database.close();
  });
});
