# Realtime Session Broker

The tutor backend uses a Cloudflare Worker at `tutor.digitalvanguard.xyz` to create OpenAI Realtime WebRTC sessions without exposing the OpenAI API key to the Expo app.

## Routes

- `GET /health` returns basic service health and the configured Realtime model.
- `GET /debug` validates Cloudflare Access and returns non-secret configuration booleans.
- `POST /session` accepts a WebRTC offer SDP body with `Content-Type: application/sdp`, verifies Cloudflare Access, forwards the SDP to OpenAI, and returns OpenAI's SDP answer as `application/sdp`.

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
