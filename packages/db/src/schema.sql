CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  goal TEXT NOT NULL CHECK (goal IN ('fat_loss', 'muscle_gain', 'maintain', 'custom')),
  goal_description TEXT NOT NULL DEFAULT '',
  height_cm REAL NOT NULL CHECK (height_cm > 0),
  age INTEGER NOT NULL CHECK (age BETWEEN 1 AND 150),
  sex TEXT NOT NULL,
  training_experience TEXT NOT NULL,
  equipment TEXT NOT NULL,
  training_days_per_week INTEGER NOT NULL CHECK (training_days_per_week BETWEEN 0 AND 7),
  session_duration_minutes INTEGER NOT NULL CHECK (session_duration_minutes > 0),
  diet_preferences TEXT NOT NULL,
  allergies TEXT NOT NULL,
  health_restrictions TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_profiles_status ON profiles(status);
CREATE INDEX IF NOT EXISTS idx_profiles_updated ON profiles(updated_at);

CREATE TABLE IF NOT EXISTS daily_entries (
  id INTEGER PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  entry_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('training', 'rest', 'paused_sick', 'travel', 'custom')),
  status_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_entries_profile_date ON daily_entries(profile_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_daily_entries_profile_date_range ON daily_entries(profile_id, entry_date);

CREATE TABLE IF NOT EXISTS weight_measurements (
  id INTEGER PRIMARY KEY,
  daily_entry_id INTEGER NOT NULL REFERENCES daily_entries(id) ON DELETE CASCADE,
  measured_at TEXT NOT NULL,
  weight_kg REAL NOT NULL CHECK (weight_kg > 0),
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_weight_entry_time ON weight_measurements(daily_entry_id, measured_at);

CREATE TABLE IF NOT EXISTS meals (
  id INTEGER PRIMARY KEY,
  daily_entry_id INTEGER NOT NULL REFERENCES daily_entries(id) ON DELETE CASCADE,
  eaten_at TEXT NOT NULL,
  meal_type TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  recognition_status TEXT NOT NULL DEFAULT 'unrecognized'
    CHECK (recognition_status IN ('unrecognized', 'processing', 'needs_review', 'confirmed', 'failed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_meals_entry_time ON meals(daily_entry_id, eaten_at);

CREATE TABLE IF NOT EXISTS meal_images (
  id INTEGER PRIMARY KEY,
  meal_id INTEGER NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK (file_size > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_images_meal ON meal_images(meal_id);

CREATE TABLE IF NOT EXISTS food_items (
  id INTEGER PRIMARY KEY,
  meal_id INTEGER NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount > 0),
  unit TEXT NOT NULL,
  cooking_method TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  needs_confirmation INTEGER NOT NULL CHECK (needs_confirmation IN (0, 1)),
  is_user_confirmed INTEGER NOT NULL CHECK (is_user_confirmed IN (0, 1)),
  source TEXT NOT NULL CHECK (source IN ('user', 'model')),
  notes TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_food_items_meal ON food_items(meal_id);

CREATE TABLE IF NOT EXISTS workouts (
  id INTEGER PRIMARY KEY,
  daily_entry_id INTEGER NOT NULL REFERENCES daily_entries(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  workout_type TEXT NOT NULL,
  duration_minutes INTEGER CHECK (duration_minutes > 0),
  perceived_difficulty REAL CHECK (perceived_difficulty BETWEEN 0 AND 10),
  notes TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_workouts_entry_time ON workouts(daily_entry_id, started_at);

CREATE TABLE IF NOT EXISTS exercises (
  id INTEGER PRIMARY KEY,
  workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  weight REAL CHECK (weight >= 0),
  weight_unit TEXT NOT NULL DEFAULT '',
  sets INTEGER NOT NULL CHECK (sets > 0),
  repetitions INTEGER NOT NULL CHECK (repetitions > 0),
  completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
  notes TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_exercises_workout ON exercises(workout_id);

CREATE TABLE IF NOT EXISTS body_feedback (
  id INTEGER PRIMARY KEY,
  daily_entry_id INTEGER NOT NULL REFERENCES daily_entries(id) ON DELETE CASCADE,
  recorded_at TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('normal', 'discomfort', 'pain', 'fatigue', 'other')),
  body_part TEXT NOT NULL,
  severity REAL NOT NULL CHECK (severity BETWEEN 0 AND 10),
  impact TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_feedback_entry_time ON body_feedback(daily_entry_id, recorded_at);

CREATE TABLE IF NOT EXISTS recommendations (
  id INTEGER PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  job_id TEXT,
  range_start TEXT NOT NULL,
  range_end TEXT NOT NULL,
  model_name TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  input_record_count INTEGER NOT NULL DEFAULT 0,
  image_review_count INTEGER NOT NULL DEFAULT 0,
  input_summary_json TEXT NOT NULL,
  report_markdown TEXT NOT NULL,
  structured_report_json TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed'))
);
CREATE INDEX IF NOT EXISTS idx_recommendations_range ON recommendations(range_start, range_end);
CREATE INDEX IF NOT EXISTS idx_recommendations_profile_generated ON recommendations(profile_id, generated_at);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY CHECK (key <> 'api_key'),
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recommendation_jobs (
  job_id TEXT PRIMARY KEY,
  profile_id INTEGER NOT NULL,
  profile_snapshot_json TEXT NOT NULL,
  range_start TEXT NOT NULL,
  range_end TEXT NOT NULL,
  image_policy_json TEXT NOT NULL,
  specified_meal_ids_json TEXT NOT NULL,
  specified_meal_payload_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'preparing', 'sending', 'waiting_model', 'receiving', 'parsing', 'saving', 'completed', 'failed', 'cancelled')),
  phase_percent INTEGER NOT NULL CHECK (phase_percent BETWEEN 0 AND 100),
  received_chars INTEGER NOT NULL DEFAULT 0 CHECK (received_chars >= 0),
  started_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  error_code TEXT,
  error_message TEXT,
  error_phase TEXT,
  request_id TEXT,
  recommendation_id INTEGER,
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_recommendation_jobs_profile_status ON recommendation_jobs(profile_id, status);
CREATE INDEX IF NOT EXISTS idx_recommendation_jobs_profile_updated ON recommendation_jobs(profile_id, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recommendation_jobs_active_input
  ON recommendation_jobs(profile_id, range_start, range_end, image_policy_json, specified_meal_ids_json)
  WHERE status IN ('queued', 'preparing', 'sending', 'waiting_model', 'receiving', 'parsing', 'saving');
