import type { createRepositories } from '@fitness-coach/db';
import type Database from 'better-sqlite3';
import type { createProfileTransferService } from './profileTransfer.js';
import type { createRecommendationJobService } from './recommendationJobs.js';

export type Repositories = ReturnType<typeof createRepositories>;

export type ServiceContext = {
  repositories: Repositories;
  dataDir: string;
  database?: Database.Database;
  profileTransfers?: ReturnType<typeof createProfileTransferService>;
  recommendationJobs?: ReturnType<typeof createRecommendationJobService>;
  profileScope?: {
    baseRepositories: Repositories;
    currentProfile: () => ReturnType<Repositories['profiles']['get']>;
    setCurrentProfile: (profileId: unknown) => ReturnType<Repositories['profiles']['get']>;
    assertWritable: () => void;
    lockCurrentProfile: () => number;
    currentProfileId?: () => number | undefined;
    runWithCurrentProfile: <T>(callback: () => Promise<T>) => Promise<T>;
    runWithOptionalCurrentProfile: <T>(callback: () => Promise<T>) => Promise<T>;
    runProfileMutation: <T>(callback: () => Promise<T>) => Promise<T>;
  };
};
