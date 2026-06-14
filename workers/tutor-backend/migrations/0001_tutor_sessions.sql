PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tutor_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('starting', 'active', 'ended', 'failed', 'cancelled')),
  model_id TEXT NOT NULL,
  openai_session_id TEXT,
  openai_request_id TEXT,
  photo_r2_key TEXT,
  error_summary TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_tutor_sessions_user_started
  ON tutor_sessions (user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_tutor_sessions_status
  ON tutor_sessions (status);

CREATE INDEX IF NOT EXISTS idx_tutor_sessions_photo_r2_key
  ON tutor_sessions (photo_r2_key)
  WHERE photo_r2_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS tutor_session_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  role TEXT CHECK (role IS NULL OR role IN ('student', 'assistant', 'system', 'tool')),
  modality TEXT CHECK (modality IS NULL OR modality IN ('text', 'image', 'audio_transcript', 'system', 'data')),
  content TEXT,
  metadata_json TEXT,
  client_created_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (session_id) REFERENCES tutor_sessions (id) ON DELETE CASCADE,
  UNIQUE (session_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_tutor_session_events_session_sequence
  ON tutor_session_events (session_id, sequence);

CREATE INDEX IF NOT EXISTS idx_tutor_session_events_type
  ON tutor_session_events (event_type);
