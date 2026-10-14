import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { z } from 'zod';
import {
  dailyEntrySchema,
  exerciseSchema,
  feedbackSchema,
  foodItemSchema,
  mealImageSchema,
  mealSchema,
  profileSchema,
  profileRecordSchema,
  recommendationSchema,
  recommendationJobCreateInputSchema,
  recommendationJobSchema,
  recommendationJobStatusSchema,
  recommendationStatusSchema,
  weightMeasurementSchema,
  workoutSchema,
  type ConfirmFoodItemInput,
  type FoodItem,
  type RecommendationJob,
  type RecommendationJobStatus,
} from '@fitness-coach/shared';

type RecordSchema = z.ZodObject<z.ZodRawShape>;

function databaseValues(values: Record<string, unknown>) {
  const result = { ...values };
  for (const [key, value] of Object.entries(result)) {
    if (value === undefined) delete result[key];
    else if (typeof value === 'boolean') result[key] = Number(value);
  }
  return result;
}

function ensureRecommendationColumns(db: Database.Database) {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'recommendations'").get();
  if (!table) return;

  const columns = new Set((db.prepare('PRAGMA table_info(recommendations)').all() as Array<{ name: string }>).map(({ name }) => name));
  const expected = [
    ['job_id', 'TEXT'],
    ['input_record_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['image_review_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['error_code', 'TEXT'],
    ['error_message', 'TEXT'],
  ] as const;
  for (const [name, definition] of expected) {
    if (!columns.has(name)) db.exec(`ALTER TABLE recommendations ADD COLUMN ${name} ${definition}`);
  }
}

const jobPhasePercent: Record<RecommendationJobStatus, number> = {
  queued: 5,
  preparing: 15,
  sending: 25,
  waiting_model: 60,
  receiving: 80,
  parsing: 90,
  saving: 98,
  completed: 100,
  failed: 0,
  cancelled: 0,
};

const jobWorkStatuses = ['queued', 'preparing', 'sending', 'waiting_model', 'receiving', 'parsing', 'saving'] as const;
const jobCancelableStatuses = ['queued', 'preparing', 'sending', 'waiting_model', 'receiving'] as const;
const jobPhaseStatusSet = new Set<string>(jobWorkStatuses);
const jobCancelableStatusSet = new Set<string>(jobCancelableStatuses);
const nextJobStatus: Partial<Record<RecommendationJobStatus, RecommendationJobStatus>> = {
  queued: 'preparing',
  preparing: 'sending',
  sending: 'waiting_model',
  waiting_model: 'receiving',
  receiving: 'parsing',
  parsing: 'saving',
};

function placeholders(values: readonly string[]) {
  return values.map(() => '?').join(', ');
}

function createRecommendationJobRepository(db: Database.Database, profileId: number) {
  function get(jobId: string): RecommendationJob | undefined {
    const row = db.prepare(`SELECT * FROM recommendation_jobs WHERE job_id = ? AND profile_id = ?`).get(jobId, profileId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return recommendationJobSchema.parse({
      job_id: row.job_id,
      profile_id: row.profile_id,
      profile_snapshot: JSON.parse(String(row.profile_snapshot_json)),
      range_start: row.range_start,
      range_end: row.range_end,
      image_policy: JSON.parse(String(row.image_policy_json)),
      specified_meal_ids: JSON.parse(String(row.specified_meal_ids_json)),
      specified_meal_payload: row.specified_meal_payload_json === null ? null : JSON.parse(String(row.specified_meal_payload_json)),
      status: row.status,
      phase_percent: row.phase_percent,
      received_chars: row.received_chars,
      started_at: row.started_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at,
      error_code: row.error_code,
      error_message: row.error_message,
      error_phase: row.error_phase,
      request_id: row.request_id,
      recommendation_id: row.recommendation_id,
    });
  }

  function ownedRecommendation(recommendationId: number) {
    return db.prepare('SELECT 1 FROM recommendations WHERE id = ? AND profile_id = ?').get(recommendationId, profileId) !== undefined;
  }

  function insertRecommendation(input: z.input<typeof recommendationSchema>) {
    const parsed = recommendationSchema.parse(input);
    const { id: _id, generated_at: _generated, ...fields } = parsed;
    const names = Object.keys(fields);
    const result = db.prepare(`INSERT INTO recommendations (${names.join(', ')}) VALUES (${names.map((name) => `@${name}`).join(', ')})`).run(fields);
    return Number(result.lastInsertRowid);
  }

  function updateTerminal(jobId: string, values: {
    status: 'completed' | 'failed' | 'cancelled';
    phase_percent?: number;
    completed_at?: string;
    error_code?: string | null;
    error_message?: string | null;
    error_phase?: string | null;
    request_id?: string | null;
    recommendation_id?: number | null;
  }) {
    const current = get(jobId);
    if (!current) return undefined;
    if (!jobPhaseStatusSet.has(current.status)) return current;
    const now = new Date().toISOString();
    db.prepare(`UPDATE recommendation_jobs SET
      status = @status,
      phase_percent = COALESCE(@phase_percent, phase_percent),
      completed_at = @completed_at,
      error_code = @error_code,
      error_message = @error_message,
      error_phase = @error_phase,
      request_id = COALESCE(@request_id, request_id),
      recommendation_id = COALESCE(@recommendation_id, recommendation_id),
      updated_at = @updated_at
      WHERE job_id = @job_id AND profile_id = @profile_id AND status IN (${placeholders(jobWorkStatuses)})`)
      .run({
        ...values,
        phase_percent: values.phase_percent ?? null,
        completed_at: values.completed_at ?? now,
        error_code: values.error_code ?? null,
        error_message: values.error_message ?? null,
        error_phase: values.error_phase ?? null,
        request_id: values.request_id ?? null,
        recommendation_id: values.recommendation_id ?? null,
        updated_at: now,
        job_id: jobId,
        profile_id: profileId,
      }, ...jobWorkStatuses);
    return get(jobId);
  }

  function createOrGet(input: z.input<typeof recommendationJobCreateInputSchema>): { job: RecommendationJob; created: boolean } {
      const parsed = recommendationJobCreateInputSchema.parse(input);
      const imagePolicyJson = JSON.stringify(parsed.image_policy);
      const specifiedMealIdsJson = JSON.stringify([...parsed.specified_meal_ids].sort((left, right) => left - right));
      const profile = db.prepare("SELECT * FROM profiles WHERE id = ? AND status = 'active'").get(profileId);
      if (!profile) throw new Error('An active profile is required to create a recommendation job');
      if (parsed.specified_meal_ids.length > 0) {
        const ownedMealCount = db.prepare(`
          SELECT COUNT(*) AS count
          FROM meals m
          JOIN daily_entries d ON d.id = m.daily_entry_id
          WHERE d.profile_id = ? AND m.id IN (${placeholders(parsed.specified_meal_ids.map(String))})
        `).get(profileId, ...parsed.specified_meal_ids) as { count: number };
        if (Number(ownedMealCount.count) !== parsed.specified_meal_ids.length) {
          throw new Error('Specified meals must belong to the profile');
        }
      }
      const profileSnapshot = profileRecordSchema.parse(profile);
      const jobId = randomUUID();
      try {
        db.prepare(`INSERT INTO recommendation_jobs (
          job_id, profile_id, profile_snapshot_json, range_start, range_end, image_policy_json,
          specified_meal_ids_json, specified_meal_payload_json, status, phase_percent, received_chars, request_id
        ) VALUES (@job_id, @profile_id, @profile_snapshot_json, @range_start, @range_end, @image_policy_json,
          @specified_meal_ids_json, @specified_meal_payload_json, 'queued', @phase_percent, 0, @request_id)`)
          .run({
            job_id: jobId,
            profile_id: profileId,
            profile_snapshot_json: JSON.stringify(profileSnapshot),
            range_start: parsed.range_start,
            range_end: parsed.range_end,
            image_policy_json: imagePolicyJson,
            specified_meal_ids_json: specifiedMealIdsJson,
            specified_meal_payload_json: parsed.specified_meal_payload === null ? null : JSON.stringify(parsed.specified_meal_payload),
            phase_percent: jobPhasePercent.queued,
            request_id: parsed.request_id,
          });
      } catch (error) {
        if ((error as { code?: string }).code !== 'SQLITE_CONSTRAINT_UNIQUE') throw error;
        const existing = db.prepare(`SELECT job_id FROM recommendation_jobs
          WHERE profile_id = ? AND range_start = ? AND range_end = ?
            AND image_policy_json = ? AND specified_meal_ids_json = ?
            AND status IN (${placeholders(jobWorkStatuses)})
          ORDER BY updated_at, job_id LIMIT 1`).get(profileId, parsed.range_start, parsed.range_end, imagePolicyJson, specifiedMealIdsJson, ...jobWorkStatuses) as { job_id?: string } | undefined;
        if (!existing?.job_id) throw error;
        return { job: get(existing.job_id)!, created: false };
      }
      return { job: get(jobId)!, created: true };
  }

  return {
    create(input: z.input<typeof recommendationJobCreateInputSchema>): RecommendationJob {
      return createOrGet(input).job;
    },
    createOrGet,
    get,
    updateStatus(jobId: string, status: RecommendationJobStatus): RecommendationJob | undefined {
      const parsedStatus = recommendationJobStatusSchema.parse(status);
      const current = get(jobId);
      if (!current) return undefined;
      if (!jobPhaseStatusSet.has(parsedStatus) || !jobPhaseStatusSet.has(current.status)) return current;
      if (nextJobStatus[current.status] !== parsedStatus) return undefined;
      const now = new Date().toISOString();
      db.prepare(`UPDATE recommendation_jobs SET status = @status,
        phase_percent = MAX(phase_percent, @phase_percent), started_at = COALESCE(started_at, @started_at), updated_at = @updated_at
        WHERE job_id = @job_id AND profile_id = @profile_id AND status IN (${placeholders(jobWorkStatuses)})`)
        .run({ status: parsedStatus, phase_percent: jobPhasePercent[parsedStatus], started_at: now, updated_at: now, job_id: jobId, profile_id: profileId }, ...jobWorkStatuses);
      return get(jobId);
    },
    updateProgress(jobId: string, progress: { phase_percent?: number; received_chars?: number }): RecommendationJob | undefined {
      const current = get(jobId);
      if (!current) return undefined;
      if (!jobPhaseStatusSet.has(current.status)) return current;
      if (progress.phase_percent !== undefined && (!Number.isInteger(progress.phase_percent) || progress.phase_percent < 0 || progress.phase_percent > 100)) {
        throw new Error('phase_percent must be an integer between 0 and 100');
      }
      if (progress.received_chars !== undefined && (!Number.isInteger(progress.received_chars) || progress.received_chars < 0)) {
        throw new Error('received_chars must be a non-negative integer');
      }
      if (progress.phase_percent !== undefined && progress.phase_percent < current.phase_percent) return undefined;
      if (progress.received_chars !== undefined && progress.received_chars < current.received_chars) return undefined;
      if (progress.phase_percent === undefined && progress.received_chars === undefined) return current;
      const now = new Date().toISOString();
      db.prepare(`UPDATE recommendation_jobs SET
        phase_percent = COALESCE(@phase_percent, phase_percent),
        received_chars = COALESCE(@received_chars, received_chars),
        updated_at = @updated_at
        WHERE job_id = @job_id AND profile_id = @profile_id AND status IN (${placeholders(jobWorkStatuses)})`)
        .run({ phase_percent: progress.phase_percent ?? null, received_chars: progress.received_chars ?? null, updated_at: now, job_id: jobId, profile_id: profileId }, ...jobWorkStatuses);
      return get(jobId);
    },
    complete(jobId: string, recommendationId: number): RecommendationJob | undefined {
      if (!Number.isInteger(recommendationId) || recommendationId <= 0) throw new Error('recommendation_id must be a positive integer');
      if (!ownedRecommendation(recommendationId)) return undefined;
      if (get(jobId)?.status !== 'saving') return undefined;
      return updateTerminal(jobId, { status: 'completed', phase_percent: jobPhasePercent.completed, recommendation_id: recommendationId });
    },
    completeWithRecommendation(jobId: string, input: z.input<typeof recommendationSchema>): RecommendationJob | undefined {
      const parsed = recommendationSchema.parse(input);
      return db.transaction(() => {
        const current = get(jobId);
        if (!current || current.status !== 'saving') return undefined;
        if (parsed.profile_id !== profileId || parsed.job_id !== jobId || parsed.range_start !== current.range_start || parsed.range_end !== current.range_end || parsed.status !== 'completed') {
          const error = new Error('Recommendation does not belong to the job') as Error & { code?: string };
          error.code = 'CONFLICT';
          throw error;
        }
        const profile = db.prepare("SELECT status FROM profiles WHERE id = ?").get(profileId) as { status?: string } | undefined;
        if (profile?.status !== 'active') {
          const error = new Error('Profile is archived') as Error & { code?: string };
          error.code = 'PROFILE_ARCHIVED';
          throw error;
        }
        const recommendationId = insertRecommendation(parsed);
        const now = new Date().toISOString();
        const updated = db.prepare(`UPDATE recommendation_jobs SET
          status = 'completed', phase_percent = @phase_percent, completed_at = @completed_at,
          error_code = NULL, error_message = NULL, error_phase = NULL,
          recommendation_id = @recommendation_id, updated_at = @updated_at
          WHERE job_id = @job_id AND profile_id = @profile_id AND status = 'saving'`)
          .run({ phase_percent: jobPhasePercent.completed, completed_at: now, recommendation_id: recommendationId, updated_at: now, job_id: jobId, profile_id: profileId });
        if (updated.changes !== 1) throw new Error('Unable to complete recommendation job');
        return get(jobId);
      })();
    },
    fail(jobId: string, failure: { error_code: string; error_message: string; error_phase: string; request_id?: string | null }): RecommendationJob | undefined {
      return updateTerminal(jobId, { status: 'failed', error_code: failure.error_code, error_message: failure.error_message, error_phase: failure.error_phase, request_id: failure.request_id });
    },
    cancel(jobId: string): RecommendationJob | undefined {
      const current = get(jobId);
      if (!current) return undefined;
      if (!jobCancelableStatusSet.has(current.status)) return current;
      return updateTerminal(jobId, { status: 'cancelled' });
    },
    cancelActive(): number {
      const now = new Date().toISOString();
      return Number(db.prepare(`UPDATE recommendation_jobs SET status = 'cancelled', completed_at = @completed_at, updated_at = @updated_at
        WHERE profile_id = @profile_id AND status IN (${placeholders(jobWorkStatuses)})`)
        .run({ completed_at: now, updated_at: now, profile_id: profileId }, ...jobWorkStatuses).changes);
    },
    listActive(): RecommendationJob[] {
      const rows = db.prepare(`SELECT job_id FROM recommendation_jobs WHERE profile_id = ? AND status IN (${placeholders(jobWorkStatuses)}) ORDER BY updated_at, job_id`).all(profileId, ...jobWorkStatuses) as Array<{ job_id: string }>;
      return rows.map(({ job_id }) => get(job_id)!);
    },
    markUnfinishedFailed(): number {
      const now = new Date().toISOString();
      return Number(db.prepare(`UPDATE recommendation_jobs SET status = 'failed', error_code = 'SERVER_RESTARTED',
        error_message = 'The server restarted before the recommendation job finished', error_phase = 'server_restart',
        completed_at = @completed_at, updated_at = @updated_at
        WHERE profile_id = @profile_id AND status IN (${placeholders(jobWorkStatuses)})`)
        .run({ completed_at: now, updated_at: now, profile_id: profileId }, ...jobWorkStatuses).changes);
    },
    retrySourceSnapshot(jobId: string) {
      const current = get(jobId);
      if (!current) return undefined;
      return {
        profile_snapshot: current.profile_snapshot,
        range_start: current.range_start,
        range_end: current.range_end,
        image_policy: current.image_policy,
        specified_meal_ids: current.specified_meal_ids,
        specified_meal_payload: current.specified_meal_payload,
      };
    },
    getRetrySourceSnapshot(jobId: string) {
      return this.retrySourceSnapshot(jobId);
    },
  };
}

function childRepository<S extends RecordSchema>(
  db: Database.Database,
  table: string,
  parentColumn: string,
  schema: S,
) {
  type Item = z.infer<S>;
  return {
    save(parentId: number, input: Item): Item & { id: number } {
      const { id: _id, [parentColumn]: _parent, ...fields } = schema.parse(input);
      const values = databaseValues({ ...fields, [parentColumn]: parentId });
      const names = Object.keys(values);
      const result = db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map((name) => `@${name}`).join(', ')})`).run(values);
      return this.get(Number(result.lastInsertRowid))!;
    },
    get(id: number): (Item & { id: number }) | undefined {
      const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      if (table === 'food_items') {
        row.needs_confirmation = Boolean(row.needs_confirmation);
        row.is_user_confirmed = Boolean(row.is_user_confirmed);
      }
      if (table === 'exercises') row.completed = Boolean(row.completed);
      return row as Item & { id: number };
    },
    listForEntry(parentId: number): Array<Item & { id: number }> {
      const ids = db.prepare(`SELECT id FROM ${table} WHERE ${parentColumn} = ? ORDER BY id`).all(parentId) as Array<{ id: number }>;
      return ids.map(({ id }) => this.get(id)!);
    },
    getForParent(parentId: number, id: number): (Item & { id: number }) | undefined {
      const row = db.prepare(`SELECT id FROM ${table} WHERE id = ? AND ${parentColumn} = ?`).get(id, parentId) as { id: number } | undefined;
      return row ? this.get(row.id) : undefined;
    },
    updateForParent(parentId: number, id: number, patch: Partial<Item>): (Item & { id: number }) | undefined {
      const current = this.getForParent(parentId, id);
      if (!current) return undefined;
      const parsed = schema.parse({ ...current, ...patch });
      const values = databaseValues(Object.fromEntries(
        Object.keys(patch)
          .filter((key) => !['id', parentColumn, 'created_at', 'updated_at'].includes(key))
          .map((key) => [key, parsed[key] as unknown]),
      ));
      const names = Object.keys(values);
      if (names.length > 0) {
        db.prepare(`UPDATE ${table} SET ${names.map((name) => `${name} = @${name}`).join(', ')} WHERE id = @id AND ${parentColumn} = @parentId`)
          .run({ ...values, id, parentId });
        if (table === 'meals') db.prepare("UPDATE meals SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(id);
      }
      return this.get(id);
    },
    deleteForParent(parentId: number, id: number): (Item & { id: number }) | undefined {
      const current = this.getForParent(parentId, id);
      if (!current) return undefined;
      db.prepare(`DELETE FROM ${table} WHERE id = ? AND ${parentColumn} = ?`).run(id, parentId);
      return current;
    },
    update(id: number, patch: Partial<Item>): (Item & { id: number }) | undefined {
      const current = this.get(id);
      if (!current) return undefined;
      const parsed = schema.parse({ ...current, ...patch });
      const values = databaseValues(Object.fromEntries(
        Object.keys(patch)
          .filter((key) => !['id', parentColumn, 'created_at', 'updated_at'].includes(key))
          .map((key) => [key, parsed[key] as unknown]),
      ));
      const names = Object.keys(values);
      if (names.length > 0) {
        db.prepare(`UPDATE ${table} SET ${names.map((name) => `${name} = @${name}`).join(', ')} WHERE id = @id`).run({ ...values, id });
        if (table === 'meals') db.prepare("UPDATE meals SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(id);
      }
      return this.get(id);
    },
    delete(id: number): (Item & { id: number }) | undefined {
      const current = this.get(id);
      if (!current) return undefined;
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      return current;
    },
  };
}

export function createRepositories(db: Database.Database) {
  ensureRecommendationColumns(db);
  const images = childRepository(db, 'meal_images', 'meal_id', mealImageSchema);
  const meals = childRepository(db, 'meals', 'daily_entry_id', mealSchema);
  const foodItems = childRepository(db, 'food_items', 'meal_id', foodItemSchema);
  const base = {
    profiles: {
      create(input: Record<string, unknown>) {
        const values = { ...input, status: input.status ?? 'active', goal_description: input.goal_description ?? '' };
        const parsed = profileRecordSchema.omit({ id: true, created_at: true, updated_at: true, archived_at: true }).parse(values);
        const normalized = { ...parsed, name: parsed.name.trim() };
        const names = Object.keys(normalized);
        const result = db.prepare(`INSERT INTO profiles (${names.join(', ')}) VALUES (${names.map((name) => `@${name}`).join(', ')})`).run(normalized);
        return this.get(Number(result.lastInsertRowid))!;
      },
      createAndSetCurrent(input: Record<string, unknown>) {
        return db.transaction(() => {
          const created = this.create(input);
          this.setCurrentId(created.id);
          return created;
        })();
      },
      get(id: number) {
        const row = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
        return row ? profileRecordSchema.parse(row) : undefined;
      },
      list() {
        return db.prepare('SELECT * FROM profiles ORDER BY id').all().map((row) => profileRecordSchema.parse(row));
      },
      listManaged(options: {
        status?: 'active' | 'archived' | 'all';
        timeField?: 'created_at' | 'updated_at' | 'last_entry_at' | 'last_recommendation_at';
        from?: string;
        to?: string;
        order?: 'asc' | 'desc';
      } = {}) {
        const status = options.status ?? 'active';
        const timeField = options.timeField;
        const order = options.order ?? 'desc';
        const timeExpression = timeField === undefined
          ? status === 'archived'
            ? 'p.archived_at'
            : status === 'all'
              ? "CASE WHEN p.status = 'active' THEN p.updated_at ELSE p.archived_at END"
              : 'p.updated_at'
          : timeField === 'last_entry_at'
          ? '(SELECT MAX(entry_date) FROM daily_entries WHERE profile_id = p.id)'
          : timeField === 'last_recommendation_at'
            ? '(SELECT MAX(generated_at) FROM recommendations WHERE profile_id = p.id)'
            : `p.${timeField}`;
        const conditions: string[] = [];
        const values: Record<string, string> = {};
        if (status !== 'all') {
          conditions.push('p.status = @status');
          values.status = status;
        }
        if (options.from !== undefined) {
          conditions.push(`date(${timeExpression}) >= date(@from)`);
          values.from = options.from;
        }
        if (options.to !== undefined) {
          conditions.push(`date(${timeExpression}) <= date(@to)`);
          values.to = options.to;
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const rows = db.prepare(`
          SELECT p.*,
            (SELECT MAX(entry_date) FROM daily_entries WHERE profile_id = p.id) AS last_entry_at,
            (SELECT MAX(generated_at) FROM recommendations WHERE profile_id = p.id) AS last_recommendation_at,
            (SELECT COUNT(*) FROM daily_entries WHERE profile_id = p.id) AS record_days,
            (SELECT COUNT(*) FROM recommendations WHERE profile_id = p.id) AS report_count,
            EXISTS (
              SELECT 1 FROM meals m
              JOIN daily_entries d ON d.id = m.daily_entry_id
              WHERE d.profile_id = p.id AND m.recognition_status = 'needs_review'
            ) OR EXISTS (
              SELECT 1 FROM food_items f
              JOIN meals m ON m.id = f.meal_id
              JOIN daily_entries d ON d.id = m.daily_entry_id
              WHERE d.profile_id = p.id AND f.needs_confirmation = 1
            ) AS has_unconfirmed_diet,
            EXISTS (
              SELECT 1 FROM body_feedback f
              JOIN daily_entries d ON d.id = f.daily_entry_id
              WHERE d.profile_id = p.id AND (f.severity >= 7 OR f.category = 'pain')
            ) AS has_high_risk_feedback
          FROM profiles p
          ${where}
          ORDER BY ${timeExpression} ${order.toUpperCase()} NULLS LAST, p.id ${order.toUpperCase()}
        `).all(values) as Array<Record<string, unknown>>;
        return rows.map((row) => ({
          ...profileRecordSchema.parse(row),
          last_entry_at: row.last_entry_at as string | null,
          last_recommendation_at: row.last_recommendation_at as string | null,
          record_days: Number(row.record_days),
          report_count: Number(row.report_count),
          has_unconfirmed_diet: Boolean(row.has_unconfirmed_diet),
          has_high_risk_feedback: Boolean(row.has_high_risk_feedback),
        }));
      },
      details(id: number) {
        const rows = this.listManaged({ status: 'all' });
        const profile = rows.find((item) => item.id === id);
        if (!profile) return undefined;
        const scoped = createScopedRepositories(id);
        const entries = scoped.dailyEntry.listRange('0000-01-01', '9999-12-31').map((entry) => ({
          ...entry,
          weights: scoped.weight.listForEntry(entry.id),
          meals: scoped.meal.listForEntry(entry.id).map((meal) => ({
            ...meal,
            images: scoped.image.listForEntry(meal.id),
            food_items: scoped.foodItem.listForEntry(meal.id),
          })),
          workouts: scoped.workout.listForEntry(entry.id).map((workout) => ({
            ...workout,
            exercises: scoped.exercise.listForEntry(workout.id),
          })),
          feedback: scoped.feedback.listForEntry(entry.id),
        }));
        return {
          ...profile,
          daily_entries: entries,
          recommendations: scoped.recommendation.list(),
          summary: {
            record_days: profile.record_days,
            last_entry_at: profile.last_entry_at,
            last_recommendation_at: profile.last_recommendation_at,
            report_count: profile.report_count,
            has_unconfirmed_diet: profile.has_unconfirmed_diet,
            has_high_risk_feedback: profile.has_high_risk_feedback,
          },
        };
      },
      update(id: number, input: Record<string, unknown>) {
        const current = this.get(id);
        if (!current) return undefined;
        const parsed = profileRecordSchema.omit({ id: true, created_at: true, updated_at: true, archived_at: true }).parse({ ...current, ...input });
        const values = databaseValues({ ...parsed, name: parsed.name.trim() });
        const names = Object.keys(values);
        db.prepare(`UPDATE profiles SET ${names.map((name) => `${name} = @${name}`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = @id`)
          .run({ ...values, id });
        return this.get(id);
      },
      archive(id: number) {
        return db.transaction(() => {
          const result = db.prepare("UPDATE profiles SET status = 'archived', archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'active'").run(id);
          return result.changes > 0 ? this.get(id) : undefined;
        })();
      },
      restore(id: number) {
        return db.transaction(() => {
          const result = db.prepare("UPDATE profiles SET status = 'active', archived_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'archived'").run(id);
          return result.changes > 0 ? this.get(id) : undefined;
        })();
      },
      imagePaths(ids: number[]) {
        if (ids.length === 0) return [] as string[];
        return (db.prepare(`
          SELECT i.relative_path
          FROM meal_images i
          JOIN meals m ON m.id = i.meal_id
          JOIN daily_entries d ON d.id = m.daily_entry_id
          WHERE d.profile_id IN (${ids.map(() => '?').join(', ')})
          ORDER BY i.id
        `).all(...ids) as Array<{ relative_path: string }>).map(({ relative_path }) => relative_path);
      },
      delete(ids: number[], expectedCurrentId: number | null) {
        if (ids.length === 0) return 0;
        return db.transaction(() => {
          const currentId = this.currentId();
          const expected = expectedCurrentId ?? undefined;
          if (currentId !== expected || (currentId !== undefined && ids.includes(currentId))) return 0;
          const result = db.prepare(`DELETE FROM profiles WHERE id IN (${ids.map(() => '?').join(', ')})`).run(...ids);
          return result.changes;
        })();
      },
      currentId() {
        const row = db.prepare("SELECT value FROM app_settings WHERE key = 'current_profile_id'").get() as { value?: string } | undefined;
        return row?.value ? Number(row.value) : undefined;
      },
      setCurrentId(id: number | null) {
        if (id === null) db.prepare("DELETE FROM app_settings WHERE key = 'current_profile_id'").run();
        else db.prepare("INSERT INTO app_settings (key, value) VALUES ('current_profile_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(id));
      },
    },
    profile: {
      save(input: z.input<typeof profileSchema>) {
        const { id: _id, updated_at: _updated, ...fields } = profileSchema.parse(input);
        let profileId = base.profiles.currentId();
        if (!profileId) {
          const existing = base.profiles.list();
          if (existing.length > 0) throw new Error('Current profile is required');
          const created = base.profiles.create({ name: '默认档案', status: 'active', goal_description: '', ...fields });
          profileId = created.id;
          base.profiles.setCurrentId(profileId);
          return this.get()!;
        }
        db.prepare(`UPDATE profiles SET goal = @goal, height_cm = @height_cm, age = @age,
          sex = @sex, training_experience = @training_experience, equipment = @equipment,
          training_days_per_week = @training_days_per_week, session_duration_minutes = @session_duration_minutes,
          diet_preferences = @diet_preferences, allergies = @allergies, health_restrictions = @health_restrictions,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = @profile_id`).run({ ...fields, profile_id: profileId });
        return this.get()!;
      },
      get(): (z.infer<typeof profileSchema> & { id: number }) | undefined {
        const current = db.prepare("SELECT * FROM profiles WHERE id = (SELECT CAST(value AS INTEGER) FROM app_settings WHERE key = 'current_profile_id')").get();
        if (current) return current as z.infer<typeof profileSchema> & { id: number };
        return undefined;
      },
    },
    dailyEntry: {
      save(input: z.input<typeof dailyEntrySchema>) {
        const { id: _id, created_at: _created, updated_at: _updated, ...fields } = dailyEntrySchema.parse(input);
        const profileId = base.profiles.currentId();
        if (!profileId) throw new Error('Current profile is required');
        const existing = db.prepare('SELECT id FROM daily_entries WHERE profile_id = ? AND entry_date = ?').get(profileId, fields.entry_date) as { id?: number } | undefined;
        if (existing) db.prepare(`UPDATE daily_entries SET status = @status, status_note = @status_note, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = @id`).run({ ...fields, id: existing.id, status_note: fields.status_note ?? '' });
        else db.prepare(`INSERT INTO daily_entries (profile_id, entry_date, status, status_note)
          VALUES (@profile_id, @entry_date, @status, @status_note)`).run({ ...fields, profile_id: profileId, status_note: fields.status_note ?? '' });
        /* The profile-scoped facade uses the composite key; this compatibility entry point uses the current profile. */
        /* ON CONFLICT(entry_date) DO UPDATE SET status = excluded.status,
            status_note = excluded.status_note,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`).run({ ...fields, status_note: fields.status_note ?? '' }); */
        return this.getByDate(fields.entry_date)!;
      },
      getByDate(date: string): (z.infer<typeof dailyEntrySchema> & { id: number }) | undefined {
        const profileId = base.profiles.currentId();
        if (!profileId) throw new Error('Current profile is required');
        return db.prepare('SELECT * FROM daily_entries WHERE profile_id = ? AND entry_date = ?').get(profileId, date) as z.infer<typeof dailyEntrySchema> & { id: number } | undefined;
      },
      listRange(from: string, to: string): Array<z.infer<typeof dailyEntrySchema> & { id: number }> {
        const profileId = base.profiles.currentId();
        if (!profileId) throw new Error('Current profile is required');
        return db.prepare('SELECT * FROM daily_entries WHERE profile_id = ? AND entry_date BETWEEN ? AND ? ORDER BY entry_date').all(profileId, from, to) as Array<z.infer<typeof dailyEntrySchema> & { id: number }>;
      },
    },
    weight: childRepository(db, 'weight_measurements', 'daily_entry_id', weightMeasurementSchema),
    meal: {
      ...meals,
      recoverProcessing() {
        const result = db.prepare(`UPDATE meals SET recognition_status = 'failed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE recognition_status = 'processing' AND daily_entry_id IN (
            SELECT d.id FROM daily_entries d JOIN profiles p ON p.id = d.profile_id WHERE p.status = 'active'
          )`).run();
        return result.changes;
      },
    },
    image: {
      ...images,
      register(mealId: number, input: z.input<typeof mealImageSchema>) {
        return db.transaction(() => images.save(mealId, input))();
      },
    },
    foodItem: {
      ...foodItems,
      replaceModelDrafts(mealId: number, drafts: FoodItem[]) {
        return db.transaction(() => {
          db.prepare("DELETE FROM food_items WHERE meal_id = ? AND source = 'model' AND is_user_confirmed = 0").run(mealId);
          for (const draft of drafts) foodItems.save(mealId, draft);
          const meal = meals.update(mealId, { recognition_status: 'needs_review' });
          if (!meal) throw new Error('Meal not found');
          return { meal, food_items: foodItems.listForEntry(mealId) };
        })();
      },
      confirmForMeal(mealId: number, submitted: ConfirmFoodItemInput[]) {
        return db.transaction(() => {
          for (const item of submitted) {
            if (item.id !== undefined && !foodItems.getForParent(mealId, item.id)) {
              throw new Error('Food item does not belong to meal');
            }
          }

          const submittedIds = submitted.flatMap((item) => item.id === undefined ? [] : [item.id]);
          const deleteDrafts = submittedIds.length === 0
            ? "DELETE FROM food_items WHERE meal_id = ? AND source = 'model' AND is_user_confirmed = 0"
            : `DELETE FROM food_items WHERE meal_id = ? AND source = 'model' AND is_user_confirmed = 0 AND id NOT IN (${submittedIds.map(() => '?').join(', ')})`;
          db.prepare(deleteDrafts).run(mealId, ...submittedIds);

          for (const item of submitted) {
            const confirmed = {
              ...item,
              source: 'user' as const,
              is_user_confirmed: true,
              needs_confirmation: false,
            };
            if (item.id === undefined) foodItems.save(mealId, confirmed);
            else foodItems.updateForParent(mealId, item.id, confirmed);
          }

          const meal = meals.update(mealId, { recognition_status: 'confirmed' });
          if (!meal) throw new Error('Meal not found');
          return { meal, food_items: foodItems.listForEntry(mealId) };
        })();
      },
    },
    workout: childRepository(db, 'workouts', 'daily_entry_id', workoutSchema),
    exercise: childRepository(db, 'exercises', 'workout_id', exerciseSchema),
    feedback: childRepository(db, 'body_feedback', 'daily_entry_id', feedbackSchema),
    recommendation: {
      save(input: z.input<typeof recommendationSchema>) {
        const profileId = base.profiles.currentId();
        if (!profileId) throw new Error('Current profile is required');
        const { id: _id, generated_at: _generated, ...fields } = recommendationSchema.parse({ ...input, profile_id: profileId });
        const names = Object.keys(fields);
        const result = db.prepare(`INSERT INTO recommendations (${names.join(', ')}) VALUES (${names.map((name) => `@${name}`).join(', ')})`).run(fields);
        return this.get(Number(result.lastInsertRowid))!;
      },
      get(id: number): (z.infer<typeof recommendationSchema> & { id: number }) | undefined {
        return db.prepare('SELECT * FROM recommendations WHERE id = ?').get(id) as z.infer<typeof recommendationSchema> & { id: number } | undefined;
      },
      list(): Array<z.infer<typeof recommendationSchema> & { id: number }> {
        return db.prepare('SELECT * FROM recommendations ORDER BY generated_at DESC, id DESC').all() as Array<z.infer<typeof recommendationSchema> & { id: number }>;
      },
    },
    settings: {
      getModel(): { base_url?: string; model_name?: string } {
        const rows = db.prepare("SELECT key, value FROM app_settings WHERE key IN ('model_base_url', 'model_name')").all() as Array<{ key: string; value: string }>;
        const values = Object.fromEntries(rows.map(({ key, value }) => [key, value]));
        return {
          base_url: values.model_base_url,
          model_name: values.model_name,
        };
      },
      saveModel(input: { base_url: string; model_name: string }) {
        const save = db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
        db.transaction(() => {
          save.run('model_base_url', input.base_url);
          save.run('model_name', input.model_name);
        })();
        return this.getModel();
      },
      clearModel() {
        db.prepare("DELETE FROM app_settings WHERE key IN ('model_base_url', 'model_name')").run();
      },
    },
  };

  function scopedChild<Item extends Record<string, unknown>>(
    repository: { save: (parentId: number, input: Item) => Item & { id: number }; get: (id: number) => (Item & { id: number }) | undefined; listForEntry: (parentId: number) => Array<Item & { id: number }>; getForParent: (parentId: number, id: number) => (Item & { id: number }) | undefined; updateForParent: (parentId: number, id: number, patch: Partial<Item>) => (Item & { id: number }) | undefined; deleteForParent: (parentId: number, id: number) => (Item & { id: number }) | undefined; update: (id: number, patch: Partial<Item>) => (Item & { id: number }) | undefined; delete: (id: number) => (Item & { id: number }) | undefined },
    parentBelongs: (id: number) => boolean,
    itemBelongs: (id: number) => boolean,
  ) {
    return {
      save(parentId: number, input: Item) { return parentBelongs(parentId) ? repository.save(parentId, input) : undefined; },
      get(id: number) { return itemBelongs(id) ? repository.get(id) : undefined; },
      listForEntry(parentId: number) { return parentBelongs(parentId) ? repository.listForEntry(parentId) : []; },
      getForParent(parentId: number, id: number) { return parentBelongs(parentId) && itemBelongs(id) ? repository.getForParent(parentId, id) : undefined; },
      updateForParent(parentId: number, id: number, patch: Partial<Item>) { return parentBelongs(parentId) && itemBelongs(id) ? repository.updateForParent(parentId, id, patch) : undefined; },
      deleteForParent(parentId: number, id: number) { return parentBelongs(parentId) && itemBelongs(id) ? repository.deleteForParent(parentId, id) : undefined; },
      update(id: number, patch: Partial<Item>) { return itemBelongs(id) ? repository.update(id, patch) : undefined; },
      delete(id: number) { return itemBelongs(id) ? repository.delete(id) : undefined; },
    };
  }

  function createScopedRepositories(profileId: number) {
    const profile = () => db.prepare('SELECT id FROM profiles WHERE id = ?').get(profileId) !== undefined;
    const entryBelongs = (entryId: number) => db.prepare('SELECT 1 FROM daily_entries WHERE id = ? AND profile_id = ?').get(entryId, profileId) !== undefined;
    const mealBelongs = (mealId: number) => db.prepare('SELECT 1 FROM meals m JOIN daily_entries d ON d.id = m.daily_entry_id WHERE m.id = ? AND d.profile_id = ?').get(mealId, profileId) !== undefined;
    const workoutBelongs = (workoutId: number) => db.prepare('SELECT 1 FROM workouts w JOIN daily_entries d ON d.id = w.daily_entry_id WHERE w.id = ? AND d.profile_id = ?').get(workoutId, profileId) !== undefined;
    const weightBelongs = (weightId: number) => db.prepare('SELECT 1 FROM weight_measurements w JOIN daily_entries d ON d.id = w.daily_entry_id WHERE w.id = ? AND d.profile_id = ?').get(weightId, profileId) !== undefined;
    const feedbackBelongs = (feedbackId: number) => db.prepare('SELECT 1 FROM body_feedback f JOIN daily_entries d ON d.id = f.daily_entry_id WHERE f.id = ? AND d.profile_id = ?').get(feedbackId, profileId) !== undefined;
    const imageBelongs = (imageId: number) => db.prepare('SELECT 1 FROM meal_images i JOIN meals m ON m.id = i.meal_id JOIN daily_entries d ON d.id = m.daily_entry_id WHERE i.id = ? AND d.profile_id = ?').get(imageId, profileId) !== undefined;
    const foodBelongs = (foodId: number) => db.prepare('SELECT 1 FROM food_items f JOIN meals m ON m.id = f.meal_id JOIN daily_entries d ON d.id = m.daily_entry_id WHERE f.id = ? AND d.profile_id = ?').get(foodId, profileId) !== undefined;
    const exerciseBelongs = (exerciseId: number) => db.prepare('SELECT 1 FROM exercises e JOIN workouts w ON w.id = e.workout_id JOIN daily_entries d ON d.id = w.daily_entry_id WHERE e.id = ? AND d.profile_id = ?').get(exerciseId, profileId) !== undefined;
    const scopedEntries = {
      save(input: z.input<typeof dailyEntrySchema>) {
        if (!profile()) return undefined;
        const { id: _id, created_at: _created, updated_at: _updated, ...fields } = dailyEntrySchema.parse(input);
        db.prepare(`INSERT INTO daily_entries (profile_id, entry_date, status, status_note) VALUES (?, @entry_date, @status, @status_note)
          ON CONFLICT(profile_id, entry_date) DO UPDATE SET status = excluded.status, status_note = excluded.status_note, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
          .run(profileId, { ...fields, status_note: fields.status_note ?? '' });
        return this.getByDate(fields.entry_date)!;
      },
      getByDate(date: string) { return db.prepare('SELECT * FROM daily_entries WHERE profile_id = ? AND entry_date = ?').get(profileId, date) as z.infer<typeof dailyEntrySchema> & { id: number } | undefined; },
      listRange(from: string, to: string) { return db.prepare('SELECT * FROM daily_entries WHERE profile_id = ? AND entry_date BETWEEN ? AND ? ORDER BY entry_date').all(profileId, from, to) as Array<z.infer<typeof dailyEntrySchema> & { id: number }>; },
    };
    const scopedMeals = scopedChild(base.meal, entryBelongs, mealBelongs);
    const scopedImages = scopedChild(base.image, mealBelongs, imageBelongs);
    const scopedFood = scopedChild(base.foodItem, mealBelongs, foodBelongs);
    const scopedWorkouts = scopedChild(base.workout, entryBelongs, workoutBelongs);
    const scopedExercises = scopedChild(base.exercise, workoutBelongs, exerciseBelongs);
    const scopedFeedback = scopedChild(base.feedback, entryBelongs, feedbackBelongs);
    const recommendationJob = createRecommendationJobRepository(db, profileId);
    return {
      profile: {
        get: () => base.profiles.get(profileId),
        save(input: z.input<typeof profileSchema>) {
          const { id: _id, updated_at: _updated, ...fields } = profileSchema.parse(input);
          db.prepare(`UPDATE profiles SET goal = @goal, height_cm = @height_cm, age = @age,
            sex = @sex, training_experience = @training_experience, equipment = @equipment,
            training_days_per_week = @training_days_per_week, session_duration_minutes = @session_duration_minutes,
            diet_preferences = @diet_preferences, allergies = @allergies, health_restrictions = @health_restrictions,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = @profile_id`).run({ ...fields, profile_id: profileId });
          return this.get()!;
        },
      },
      dailyEntry: scopedEntries,
      weight: scopedChild(base.weight, entryBelongs, weightBelongs),
      meal: { ...scopedMeals, recoverProcessing: () => db.prepare("UPDATE meals SET recognition_status = 'failed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE recognition_status = 'processing' AND id IN (SELECT m.id FROM meals m JOIN daily_entries d ON d.id = m.daily_entry_id WHERE d.profile_id = ?)").run(profileId).changes },
      image: { ...scopedImages, register(mealId: number, input: z.input<typeof mealImageSchema>) { return mealBelongs(mealId) ? base.image.register(mealId, input) : undefined; } },
      foodItem: {
        ...scopedFood,
        replaceModelDrafts(mealId: number, drafts: FoodItem[]) {
          if (!mealBelongs(mealId)) return undefined;
          return base.foodItem.replaceModelDrafts(mealId, drafts);
        },
        confirmForMeal(mealId: number, submitted: ConfirmFoodItemInput[]) {
          if (!mealBelongs(mealId)) throw new Error('Meal does not belong to profile');
          if (submitted.some((item) => item.id !== undefined && !foodBelongs(item.id))) throw new Error('Food item does not belong to profile');
          return base.foodItem.confirmForMeal(mealId, submitted);
        },
      },
      workout: scopedWorkouts,
      exercise: scopedExercises,
      feedback: scopedFeedback,
      recommendation: {
        save(input: z.input<typeof recommendationSchema>) {
          if (!profile()) return undefined;
          const { id: _id, generated_at: _generated, ...fields } = recommendationSchema.parse({ ...input, profile_id: profileId });
          const names = Object.keys(fields);
          const result = db.prepare(`INSERT INTO recommendations (${names.join(', ')}) VALUES (${names.map((name) => `@${name}`).join(', ')})`).run(fields);
          return this.get(Number(result.lastInsertRowid))!;
        },
        get(id: number) { return db.prepare('SELECT * FROM recommendations WHERE id = ? AND profile_id = ?').get(id, profileId) as z.infer<typeof recommendationSchema> & { id: number } | undefined; },
        list(options: {
          status?: z.infer<typeof recommendationStatusSchema>;
          from?: string;
          to?: string;
          order?: 'asc' | 'desc';
        } = {}) {
          const conditions = ['profile_id = @profileId'];
          const values: Record<string, string | number> = { profileId };
          if (options.status !== undefined) {
            conditions.push('status = @status');
            values.status = options.status;
          }
          if (options.from !== undefined) {
            conditions.push('range_end >= @from');
            values.from = options.from;
          }
          if (options.to !== undefined) {
            conditions.push('range_start <= @to');
            values.to = options.to;
          }
          const order = options.order === 'asc' ? 'ASC' : 'DESC';
          return db.prepare(`SELECT * FROM recommendations WHERE ${conditions.join(' AND ')} ORDER BY generated_at ${order}, id ${order}`)
            .all(values) as Array<z.infer<typeof recommendationSchema> & { id: number }>;
        },
        delete(id: number) {
          const current = this.get(id);
          if (!current) return undefined;
          db.prepare('DELETE FROM recommendations WHERE id = ? AND profile_id = ?').run(id, profileId);
          return current;
        },
        deleteMany(ids: number[]) {
          const uniqueIds = [...new Set(ids)];
          return db.transaction(() => {
            const placeholders = uniqueIds.map(() => '?').join(', ');
            const owned = db.prepare(`SELECT id FROM recommendations WHERE profile_id = ? AND id IN (${placeholders}) ORDER BY id`)
              .all(profileId, ...uniqueIds) as Array<{ id: number }>;
            if (owned.length !== uniqueIds.length) return undefined;
            db.prepare(`DELETE FROM recommendations WHERE profile_id = ? AND id IN (${placeholders})`).run(profileId, ...uniqueIds);
            return uniqueIds;
          })();
        },
      },
      recommendationJob,
    };
  }

  return { ...base, forProfile: (profileId: number) => createScopedRepositories(profileId) };
}
