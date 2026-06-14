# D1 Tutor Sessions

The `tutor-backend` Worker stores structured session metadata and reviewable transcript events in Cloudflare D1.

## Database

- Database name: `tutor-sessions`
- Binding: `env.TUTOR_DB`
- Migrations: `workers/tutor-backend/migrations`

Large binary data does not belong in D1. Captured question photos should be stored in R2 and linked from D1 with `photo_r2_key`. Raw audio blobs should not be stored in D1; store text transcripts or small event metadata only.

## Routes

- `POST /session`
  - Creates a `tutor_sessions` row before calling OpenAI.
  - Stores a stable HMAC user id, timestamps, model id, optional `X-Tutor-Photo-Key`, status, and OpenAI request id.
  - Returns OpenAI's SDP answer with `X-Tutor-Session-Id`.
- `POST /sessions/:sessionId/events`
  - Stores one event or an `events` array.
  - Accepts text, image, audio transcript, system, or small data metadata.
  - Rejects raw audio/blob-like payload keys.
- `POST /sessions/:sessionId/finish`
  - Marks a session as `ended`, `failed`, or `cancelled` and stores an optional error summary.
- `GET /sessions/recent?limit=10`
  - Returns recent sessions for the authenticated user with event counts.

All session routes require a verified Cloudflare Access JWT.

## Local Workflow

```sh
pnpm db:migrate:local
pnpm db:seed:local
pnpm db:recent:local
```

## Remote Workflow

```sh
pnpm db:migrate:remote
pnpm worker:deploy
```
