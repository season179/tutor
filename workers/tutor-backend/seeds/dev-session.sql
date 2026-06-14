INSERT OR IGNORE INTO tutor_sessions (
  id,
  user_id,
  started_at,
  ended_at,
  status,
  model_id,
  openai_session_id,
  openai_request_id,
  photo_r2_key,
  error_summary
) VALUES (
  'dev-session-001',
  'dev-user',
  '2026-06-14T00:00:00.000Z',
  '2026-06-14T00:05:00.000Z',
  'ended',
  'gpt-realtime-2',
  NULL,
  'req_dev_seed',
  'questions/dev-photo.jpg',
  NULL
);

INSERT OR IGNORE INTO tutor_session_events (
  id,
  session_id,
  sequence,
  event_type,
  role,
  modality,
  content,
  metadata_json,
  client_created_at
) VALUES
  (
    'dev-event-001',
    'dev-session-001',
    1,
    'student_message',
    'student',
    'text',
    'I need help with this question.',
    NULL,
    '2026-06-14T00:00:10.000Z'
  ),
  (
    'dev-event-002',
    'dev-session-001',
    2,
    'assistant_message',
    'assistant',
    'text',
    'Let us look at the first step together.',
    NULL,
    '2026-06-14T00:00:20.000Z'
  );
