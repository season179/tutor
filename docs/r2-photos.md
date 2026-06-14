# R2 Question Photos

Captured question photos are stored in a private Cloudflare R2 bucket for tutor session history.

## Bucket

- Bucket name: `tutor-question-photos`
- Worker binding: `env.TUTOR_PHOTOS`
- Access: private, no public bucket domain
- Object keys: `sessions/{sessionId}/photos/{photoId}.{ext}`

The app can still send the local captured image directly to OpenAI Realtime for immediate model context. R2 is for private session history and later review.

## Routes

- `POST /sessions/:sessionId/photo`
  - Requires Cloudflare Access.
  - Requires the session to belong to the authenticated user.
  - Accepts raw image bytes with `Content-Type` of `image/jpeg`, `image/png`, `image/webp`, `image/heic`, or `image/heif`.
  - Stores the object in R2 and writes metadata to D1.
  - Updates `tutor_sessions.photo_r2_key`.
- `GET /sessions/:sessionId/photos`
  - Requires Cloudflare Access.
  - Returns D1 metadata for the authenticated user's session photos.

## Metadata

D1 stores photo metadata in `tutor_session_photos`:

- R2 object key
- content type
- size in bytes
- SHA-256 hash
- R2 etag
- optional original filename
- upload timestamp

Raw image bytes are never stored in D1 and should not be logged.

## Retention

Retention is currently manual. The private bucket should be reviewed periodically and objects can be removed by R2 key when a session is no longer needed. A lifecycle rule or scheduled cleanup Worker can be added later after the family usage pattern is clearer.
