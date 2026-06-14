PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tutor_session_photos (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256_hex TEXT NOT NULL,
  etag TEXT,
  original_filename TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (session_id) REFERENCES tutor_sessions (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tutor_session_photos_session
  ON tutor_session_photos (session_id, uploaded_at DESC);

CREATE INDEX IF NOT EXISTS idx_tutor_session_photos_user_uploaded
  ON tutor_session_photos (user_id, uploaded_at DESC);

CREATE INDEX IF NOT EXISTS idx_tutor_session_photos_r2_key
  ON tutor_session_photos (r2_key);
