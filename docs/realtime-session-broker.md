# Realtime Session Broker

The tutor backend uses a Cloudflare Worker at `tutor.digitalvanguard.xyz` to create OpenAI Realtime WebRTC sessions without exposing the OpenAI API key to the Expo app.

## Routes

- `GET /health` returns basic service health and the configured Realtime model.
- `GET /debug` validates Cloudflare Access and returns non-secret configuration booleans.
- `POST /session` accepts a WebRTC offer SDP body with `Content-Type: application/sdp`, verifies Cloudflare Access, forwards the SDP to OpenAI, and returns OpenAI's SDP answer as `application/sdp`.
- `POST /sessions/:id/photo` stores a session photo in R2 after Access verification.
- `POST /sessions/:id/events` stores text/image/session metadata events in D1.
- `POST /sessions/:id/finish` marks the session ended, failed, or cancelled.

## Required Secrets

Set these before deploying:

```sh
pnpm worker:types
pnpm exec wrangler secret put OPENAI_API_KEY --config workers/tutor-backend/wrangler.jsonc
pnpm exec wrangler secret put CLOUDFLARE_ACCESS_AUD --config workers/tutor-backend/wrangler.jsonc
pnpm exec wrangler secret put OPENAI_SAFETY_IDENTIFIER_SALT --config workers/tutor-backend/wrangler.jsonc
```

`CLOUDFLARE_ACCESS_AUD` is the Access application's AUD tag. `OPENAI_SAFETY_IDENTIFIER_SALT` should be a random secret used to HMAC the authenticated family email before sending `OpenAI-Safety-Identifier` to OpenAI.

## Non-Secret Vars

The Worker config stores these non-secret vars:

- `CLOUDFLARE_ACCESS_TEAM_DOMAIN=https://season-internal.cloudflareaccess.com`
- `OPENAI_REALTIME_MODEL=gpt-realtime-2`
- `OPENAI_REALTIME_VOICE=marin`
- `ALLOWED_ORIGINS` for local Expo web development

## Security Notes

The session route does not trust a raw email header. It requires `Cf-Access-Jwt-Assertion`, verifies the JWT against the Cloudflare Access signing keys, checks the configured AUD tag, derives a stable HMAC safety identifier from the Access email, and only then calls OpenAI.

The Worker never returns the OpenAI key, the Access JWT, raw user email, or the HMAC salt in responses.

## App Client Flow

The Expo app uses the Cloudflare Access-protected Worker as the only route to OpenAI:

1. The student captures a temporary cache photo.
2. If the app does not have a Cloudflare Access cookie yet, it opens `GET /debug` in an in-app WebView so the family member can complete the one-time PIN flow.
3. The app reads the `CF_Authorization` cookie from the WebView and sends it as the `Cookie` header on native fetches. Cloudflare Access validates that cookie at the edge and injects `Cf-Access-Jwt-Assertion` before the Worker runs.
4. The app creates a native WebRTC offer and posts it to `POST /session`.
5. After the Realtime data channel opens, the app uploads the captured photo to R2 and also sends the photo bytes to `gpt-realtime-2` as an `input_image` conversation item.
6. The app requests audio and text output, streams microphone audio over WebRTC, plays model audio via the native WebRTC track, and renders text/transcript events in the tutor screen.
7. On end, cancel, or failed startup, the app closes the peer connection, stops microphone tracks, finishes the D1 session, and deletes the local temporary photo.

This WebView cookie bridge requires the Access application cookie to be readable by the app WebView. If the Access app is configured with an HttpOnly `CF_Authorization` cookie, native app login will need a different Access flow.
