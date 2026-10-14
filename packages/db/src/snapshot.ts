import Database from 'better-sqlite3';

const exportTables = [
  'schema_migrations',
  'profiles',
  'daily_entries',
  'weight_measurements',
  'meals',
  'meal_images',
  'food_items',
  'workouts',
  'exercises',
  'body_feedback',
  'recommendations',
  'app_settings',
] as const;

export function getSchemaVersion(db: Database.Database): number {
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version?: number } | undefined;
  if (!row?.version) throw new Error('Database schema version is unavailable');
  return row.version;
}

function sanitizeRow(table: string, row: Record<string, unknown>) {
  if (table === 'app_settings' && typeof row.key === 'string' && row.key !== 'model_base_url' && row.key !== 'model_name') return undefined;
  return Object.fromEntries(Object.entries(row).filter(([key, value]) => {
    if (/api.?key/i.test(key)) return false;
    return true;
  }));
}

export function exportDatabase(db: Database.Database) {
  const tables = Object.fromEntries(exportTables.map((table) => {
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    return [table, rows.flatMap((row) => {
      const sanitized = sanitizeRow(table, row);
      return sanitized ? [sanitized] : [];
    })];
  }));
  return { schemaVersion: getSchemaVersion(db), tables };
}

export async function snapshotDatabase(db: Database.Database, destination: string): Promise<void> {
  await db.backup(destination);
}
