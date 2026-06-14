import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const DEFAULT_MODEL = "gpt-realtime-2";
const DEFAULT_VOICE = "marin";
const SERVICE_NAME = "tutor-backend";
const MAX_SDP_LENGTH = 256_000;
const MAX_ERROR_SUMMARY_LENGTH = 1_000;
const MAX_EVENT_CONTENT_LENGTH = 16_000;
const MAX_EVENT_METADATA_LENGTH = 16_000;
const MAX_EVENTS_PER_REQUEST = 50;

type SecretEnv = {
  OPENAI_API_KEY?: string;
  CLOUDFLARE_ACCESS_AUD?: string;
  OPENAI_SAFETY_IDENTIFIER_SALT?: string;
};

type TutorEnv = Env & SecretEnv;

type AccessPayload = JWTPayload & {
  email?: string;
};

type AccessUser = {
  email: string;
};

type JsonBody = Record<string, unknown>;

type SessionStatus = "starting" | "active" | "ended" | "failed" | "cancelled";
type FinishStatus = Extract<SessionStatus, "ended" | "failed" | "cancelled">;
type EventRole = "student" | "assistant" | "system" | "tool";
type EventModality = "text" | "image" | "audio_transcript" | "system" | "data";

type SessionEventInput = {
  sequence?: unknown;
  eventType?: unknown;
  type?: unknown;
  role?: unknown;
  modality?: unknown;
  content?: unknown;
  metadata?: unknown;
  clientCreatedAt?: unknown;
};

type SessionEventRecord = {
  id: string;
  sessionId: string;
  sequence: number;
  eventType: string;
  role: EventRole | null;
  modality: EventModality | null;
  content: string | null;
  metadataJson: string | null;
  clientCreatedAt: string | null;
};

const TUTOR_INSTRUCTIONS = `# Role and Objective
You are a gentle, patient tutor helping a student solve a photographed school question.

# Teaching Style
- Guide the student step by step instead of giving the final answer immediately.
- Ask one small question at a time when the next step depends on the student's thinking.
- Use clear language and short spoken turns.
- If the student is stuck, give a hint, then wait for them to try.
- Praise effort calmly without overdoing it.

# Boundaries
- Do not shame, scold, or rush the student.
- Do not claim you can see an image unless image context has actually been provided in the conversation.
- If the question is unclear, ask the student to retake the photo or read the missing part aloud.

# Reasoning
- Use low-latency reasoning for simple steps.
- For multi-step math or word problems, reason through the solution before speaking, then explain only the next useful step.
- Never reveal private chain-of-thought; give concise reasoning that is appropriate for a child.

# Output
- Speak naturally and kindly.
- Keep responses concise enough for a voice conversation.
- Provide text output that matches the spoken guidance.`;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, env),
      });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return jsonResponse(
        {
          ok: true,
          service: SERVICE_NAME,
          realtimeModel: env.OPENAI_REALTIME_MODEL || DEFAULT_MODEL,
        },
        { headers: corsHeaders(request, env) },
      );
    }

    if (url.pathname === "/debug" && request.method === "GET") {
      const access = await requireAccessUser(request, env);
      if (access instanceof Response) {
        return withCors(access, request, env);
      }

      return jsonResponse(
        {
          ok: true,
          service: SERVICE_NAME,
          access: "verified",
          openaiKeyConfigured: Boolean(env.OPENAI_API_KEY),
          safetySaltConfigured: Boolean(env.OPENAI_SAFETY_IDENTIFIER_SALT),
          d1Configured: Boolean(env.TUTOR_DB),
          realtimeModel: env.OPENAI_REALTIME_MODEL || DEFAULT_MODEL,
          realtimeVoice: env.OPENAI_REALTIME_VOICE || DEFAULT_VOICE,
        },
        { headers: corsHeaders(request, env) },
      );
    }

    if (url.pathname === "/session" && request.method === "POST") {
      return withCors(await createRealtimeSession(request, env), request, env);
    }

    if (url.pathname === "/sessions/recent" && request.method === "GET") {
      return withCors(await listRecentSessions(request, env), request, env);
    }

    const sessionRoute = parseSessionRoute(url.pathname);
    if (sessionRoute && request.method === "POST") {
      if (sessionRoute.action === "events") {
        return withCors(
          await appendSessionEvents(request, env, sessionRoute.sessionId),
          request,
          env,
        );
      }

      return withCors(
        await finishSession(request, env, sessionRoute.sessionId),
        request,
        env,
      );
    }

    return jsonResponse(
      { error: "not_found", message: "Route not found." },
      { status: 404, headers: corsHeaders(request, env) },
    );
  },
} satisfies ExportedHandler<TutorEnv>;

async function createRealtimeSession(request: Request, env: TutorEnv): Promise<Response> {
  const access = await requireAccessUser(request, env);
  if (access instanceof Response) {
    return access;
  }

  const openAiApiKey = requiredSecret(env.OPENAI_API_KEY);
  if (!openAiApiKey) {
    return configurationError("OPENAI_API_KEY is not configured.");
  }

  const salt = requiredSecret(env.OPENAI_SAFETY_IDENTIFIER_SALT);
  if (!salt) {
    return configurationError("OPENAI_SAFETY_IDENTIFIER_SALT is not configured.");
  }

  const db = requiredDatabase(env);
  if (db instanceof Response) {
    return db;
  }

  if (!request.headers.get("content-type")?.toLowerCase().includes("application/sdp")) {
    return jsonResponse(
      {
        error: "unsupported_media_type",
        message: "POST the WebRTC offer SDP with Content-Type application/sdp.",
      },
      { status: 415 },
    );
  }

  const offerSdp = await request.text();
  if (!looksLikeSdpOffer(offerSdp)) {
    return jsonResponse(
      {
        error: "invalid_sdp",
        message: "Request body must be a WebRTC offer SDP.",
      },
      { status: 400 },
    );
  }

  const photoR2Key = parseOptionalHeader(request.headers.get("x-tutor-photo-key"), 1_024);
  if (photoR2Key instanceof Response) {
    return photoR2Key;
  }

  const sessionId = crypto.randomUUID();
  const startedAt = nowIso();
  const modelId = env.OPENAI_REALTIME_MODEL || DEFAULT_MODEL;
  const userId = await safetyIdentifier(access.email, salt);

  await createSessionRow(db, {
    id: sessionId,
    userId,
    startedAt,
    status: "starting",
    modelId,
    photoR2Key,
  });

  const formData = new FormData();
  formData.set("sdp", offerSdp);
  formData.set("session", JSON.stringify(realtimeSessionConfig(env)));

  let openAiResponse: Response;
  try {
    openAiResponse = await fetch(OPENAI_REALTIME_CALLS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openAiApiKey}`,
        "OpenAI-Safety-Identifier": userId,
      },
      body: formData,
    });
  } catch (error) {
    await markSessionFailed(db, sessionId, "OpenAI Realtime session request failed.", null);
    console.error(
      JSON.stringify({
        service: SERVICE_NAME,
        event: "openai_realtime_session_request_error",
        message: error instanceof Error ? error.message : "Unknown OpenAI request error",
      }),
    );

    return jsonResponse(
      {
        error: "openai_session_failed",
        message: "Failed to create a Realtime session.",
      },
      { status: 502 },
    );
  }

  const requestId = openAiResponse.headers.get("x-request-id");

  if (!openAiResponse.ok) {
    await markSessionFailed(
      db,
      sessionId,
      `OpenAI Realtime session failed with status ${openAiResponse.status}.`,
      requestId,
    );

    console.error(
      JSON.stringify({
        service: SERVICE_NAME,
        event: "openai_realtime_session_failed",
        status: openAiResponse.status,
        requestId,
      }),
    );

    return jsonResponse(
      {
        error: "openai_session_failed",
        message: "Failed to create a Realtime session.",
        requestId,
      },
      { status: 502 },
    );
  }

  let answerSdp: string;
  try {
    answerSdp = await openAiResponse.text();
  } catch (error) {
    await markSessionFailed(db, sessionId, "OpenAI Realtime SDP response could not be read.", requestId);
    console.error(
      JSON.stringify({
        service: SERVICE_NAME,
        event: "openai_realtime_sdp_read_error",
        requestId,
        message: error instanceof Error ? error.message : "Unknown OpenAI response read error",
      }),
    );

    return jsonResponse(
      {
        error: "openai_session_failed",
        message: "Failed to read the Realtime session response.",
        requestId,
      },
      { status: 502 },
    );
  }

  await markSessionActive(db, sessionId, requestId);

  return new Response(answerSdp, {
    status: 200,
    headers: {
      "Content-Type": "application/sdp",
      "X-Tutor-Session-Id": sessionId,
      ...(requestId ? { "X-OpenAI-Request-Id": requestId } : {}),
      ...cacheControlHeaders(),
    },
  });
}

async function appendSessionEvents(
  request: Request,
  env: TutorEnv,
  sessionId: string,
): Promise<Response> {
  const accessContext = await requireAccessContext(request, env);
  if (accessContext instanceof Response) {
    return accessContext;
  }

  const owner = await assertSessionOwner(env.TUTOR_DB, sessionId, accessContext.userId);
  if (owner instanceof Response) {
    return owner;
  }

  const body = await readJsonBody(request, 80_000);
  if (body instanceof Response) {
    return body;
  }

  const inputs = normalizeEventInputs(body);
  if (inputs instanceof Response) {
    return inputs;
  }

  const nextSequence = await getNextEventSequence(env.TUTOR_DB, sessionId);
  const records: SessionEventRecord[] = [];

  for (const [index, input] of inputs.entries()) {
    const record = normalizeEventInput(input, sessionId, nextSequence + index);
    if (record instanceof Response) {
      return record;
    }
    records.push(record);
  }

  await env.TUTOR_DB.batch(
    records.map((record) =>
      env.TUTOR_DB.prepare(
        `INSERT INTO tutor_session_events (
          id,
          session_id,
          sequence,
          event_type,
          role,
          modality,
          content,
          metadata_json,
          client_created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        record.id,
        record.sessionId,
        record.sequence,
        record.eventType,
        record.role,
        record.modality,
        record.content,
        record.metadataJson,
        record.clientCreatedAt,
      ),
    ),
  );

  await touchSession(env.TUTOR_DB, sessionId);

  return jsonResponse({
    ok: true,
    sessionId,
    stored: records.length,
  });
}

async function finishSession(
  request: Request,
  env: TutorEnv,
  sessionId: string,
): Promise<Response> {
  const accessContext = await requireAccessContext(request, env);
  if (accessContext instanceof Response) {
    return accessContext;
  }

  const body = await readJsonBody(request, 8_000, true);
  if (body instanceof Response) {
    return body;
  }

  const status = normalizeFinishStatus(body.status);
  if (!status) {
    return jsonResponse(
      {
        error: "invalid_status",
        message: "Status must be ended, failed, or cancelled.",
      },
      { status: 400 },
    );
  }

  const errorSummary = optionalString(body.errorSummary, MAX_ERROR_SUMMARY_LENGTH);
  if (errorSummary instanceof Response) {
    return errorSummary;
  }

  const result = await env.TUTOR_DB.prepare(
    `UPDATE tutor_sessions
      SET status = ?,
          ended_at = ?,
          error_summary = ?,
          updated_at = ?
      WHERE id = ? AND user_id = ?`,
  )
    .bind(status, nowIso(), errorSummary, nowIso(), sessionId, accessContext.userId)
    .run();

  if (result.meta.changes === 0) {
    return sessionNotFound();
  }

  return jsonResponse({
    ok: true,
    sessionId,
    status,
  });
}

async function listRecentSessions(request: Request, env: TutorEnv): Promise<Response> {
  const accessContext = await requireAccessContext(request, env);
  if (accessContext instanceof Response) {
    return accessContext;
  }

  const url = new URL(request.url);
  const limit = clampNumber(Number(url.searchParams.get("limit") || 10), 1, 50);
  const { results } = await env.TUTOR_DB.prepare(
    `SELECT
        s.id,
        s.started_at,
        s.ended_at,
        s.status,
        s.model_id,
        s.openai_session_id,
        s.openai_request_id,
        s.photo_r2_key,
        s.error_summary,
        COUNT(e.id) AS event_count
      FROM tutor_sessions s
      LEFT JOIN tutor_session_events e ON e.session_id = s.id
      WHERE s.user_id = ?
      GROUP BY s.id
      ORDER BY s.started_at DESC
      LIMIT ?`,
  )
    .bind(accessContext.userId, limit)
    .all();

  return jsonResponse({
    ok: true,
    sessions: results,
  });
}

async function requireAccessContext(
  request: Request,
  env: TutorEnv,
): Promise<(AccessUser & { userId: string }) | Response> {
  const access = await requireAccessUser(request, env);
  if (access instanceof Response) {
    return access;
  }

  const salt = requiredSecret(env.OPENAI_SAFETY_IDENTIFIER_SALT);
  if (!salt) {
    return configurationError("OPENAI_SAFETY_IDENTIFIER_SALT is not configured.");
  }

  const db = requiredDatabase(env);
  if (db instanceof Response) {
    return db;
  }

  return {
    ...access,
    userId: await safetyIdentifier(access.email, salt),
  };
}

async function requireAccessUser(request: Request, env: TutorEnv): Promise<AccessUser | Response> {
  const teamDomain = normalizeTeamDomain(env.CLOUDFLARE_ACCESS_TEAM_DOMAIN);
  const audience = requiredSecret(env.CLOUDFLARE_ACCESS_AUD);

  if (!teamDomain || !audience) {
    return configurationError(
      "Cloudflare Access verification is not fully configured.",
    );
  }

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) {
    return jsonResponse(
      {
        error: "access_required",
        message: "Missing Cloudflare Access JWT.",
      },
      { status: 403 },
    );
  }

  try {
    const jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    const { payload } = await jwtVerify(token, jwks, {
      audience,
      issuer: teamDomain,
    });
    const email = normalizedEmail(payload);

    if (!email) {
      return jsonResponse(
        {
          error: "access_identity_missing",
          message: "Cloudflare Access token does not include an email identity.",
        },
        { status: 403 },
      );
    }

    return {
      email,
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        service: SERVICE_NAME,
        event: "cloudflare_access_jwt_invalid",
        message: error instanceof Error ? error.message : "Unknown verification error",
      }),
    );

    return jsonResponse(
      {
        error: "access_invalid",
        message: "Invalid Cloudflare Access JWT.",
      },
      { status: 403 },
    );
  }
}

function realtimeSessionConfig(env: TutorEnv): JsonBody {
  return {
    type: "realtime",
    model: env.OPENAI_REALTIME_MODEL || DEFAULT_MODEL,
    instructions: TUTOR_INSTRUCTIONS,
    reasoning: {
      effort: "low",
    },
    audio: {
      output: {
        voice: env.OPENAI_REALTIME_VOICE || DEFAULT_VOICE,
      },
    },
  };
}

function requiredDatabase(env: TutorEnv): D1Database | Response {
  if (!env.TUTOR_DB) {
    return configurationError("TUTOR_DB D1 binding is not configured.");
  }

  return env.TUTOR_DB;
}

async function createSessionRow(
  db: D1Database,
  input: {
    id: string;
    userId: string;
    startedAt: string;
    status: SessionStatus;
    modelId: string;
    photoR2Key: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tutor_sessions (
        id,
        user_id,
        started_at,
        status,
        model_id,
        photo_r2_key,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.userId,
      input.startedAt,
      input.status,
      input.modelId,
      input.photoR2Key,
      input.startedAt,
      input.startedAt,
    )
    .run();
}

async function markSessionActive(
  db: D1Database,
  sessionId: string,
  openAiRequestId: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE tutor_sessions
        SET status = 'active',
            openai_request_id = ?,
            updated_at = ?
        WHERE id = ?`,
    )
    .bind(openAiRequestId, nowIso(), sessionId)
    .run();
}

async function markSessionFailed(
  db: D1Database,
  sessionId: string,
  errorSummary: string,
  openAiRequestId: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE tutor_sessions
        SET status = 'failed',
            ended_at = ?,
            error_summary = ?,
            openai_request_id = ?,
            updated_at = ?
        WHERE id = ?`,
    )
    .bind(
      nowIso(),
      truncateText(errorSummary, MAX_ERROR_SUMMARY_LENGTH),
      openAiRequestId,
      nowIso(),
      sessionId,
    )
    .run();
}

async function touchSession(db: D1Database, sessionId: string): Promise<void> {
  await db
    .prepare("UPDATE tutor_sessions SET updated_at = ? WHERE id = ?")
    .bind(nowIso(), sessionId)
    .run();
}

async function assertSessionOwner(
  db: D1Database,
  sessionId: string,
  userId: string,
): Promise<true | Response> {
  const row = await db
    .prepare("SELECT id FROM tutor_sessions WHERE id = ? AND user_id = ?")
    .bind(sessionId, userId)
    .first<{ id: string }>();

  return row ? true : sessionNotFound();
}

async function getNextEventSequence(db: D1Database, sessionId: string): Promise<number> {
  const result = await db
    .prepare(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM tutor_session_events WHERE session_id = ?",
    )
    .bind(sessionId)
    .first<{ next_sequence: number }>();

  return result?.next_sequence ?? 1;
}

function parseSessionRoute(
  pathname: string,
): { sessionId: string; action: "events" | "finish" } | null {
  const match = pathname.match(/^\/sessions\/([^/]+)\/(events|finish)$/);
  if (!match) {
    return null;
  }

  return {
    sessionId: decodeURIComponent(match[1]),
    action: match[2] as "events" | "finish",
  };
}

async function readJsonBody(
  request: Request,
  maxLength: number,
  allowEmpty = false,
): Promise<JsonBody | Response> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return jsonResponse(
      {
        error: "unsupported_media_type",
        message: "POST JSON with Content-Type application/json.",
      },
      { status: 415 },
    );
  }

  const text = await request.text();
  if (!text.trim() && allowEmpty) {
    return {};
  }

  if (text.length > maxLength) {
    return jsonResponse(
      {
        error: "payload_too_large",
        message: `JSON body must be ${maxLength} characters or less.`,
      },
      { status: 413 },
    );
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
      return jsonResponse(
        {
          error: "invalid_json",
          message: "JSON body must be an object.",
        },
        { status: 400 },
      );
    }

    return parsed;
  } catch {
    return jsonResponse(
      {
        error: "invalid_json",
        message: "Request body is not valid JSON.",
      },
      { status: 400 },
    );
  }
}

function normalizeEventInputs(body: JsonBody): SessionEventInput[] | Response {
  const rawEvents = Array.isArray(body.events) ? body.events : [body];
  if (rawEvents.length === 0 || rawEvents.length > MAX_EVENTS_PER_REQUEST) {
    return jsonResponse(
      {
        error: "invalid_events",
        message: `Send between 1 and ${MAX_EVENTS_PER_REQUEST} events.`,
      },
      { status: 400 },
    );
  }

  if (!rawEvents.every(isRecord)) {
    return jsonResponse(
      {
        error: "invalid_events",
        message: "Each event must be an object.",
      },
      { status: 400 },
    );
  }

  return rawEvents as SessionEventInput[];
}

function normalizeEventInput(
  input: SessionEventInput,
  sessionId: string,
  fallbackSequence: number,
): SessionEventRecord | Response {
  if (hasRawAudioPayload(input)) {
    return jsonResponse(
      {
        error: "raw_audio_not_allowed",
        message: "Store text transcripts or metadata only; raw audio blobs do not belong in D1.",
      },
      { status: 400 },
    );
  }

  const eventType = optionalString(input.eventType ?? input.type, 80);
  if (!eventType || eventType instanceof Response) {
    return jsonResponse(
      {
        error: "invalid_event_type",
        message: "Event type is required and must be a short string.",
      },
      { status: 400 },
    );
  }

  const sequence = normalizeSequence(input.sequence, fallbackSequence);
  if (!sequence) {
    return jsonResponse(
      {
        error: "invalid_sequence",
        message: "Event sequence must be a positive integer when provided.",
      },
      { status: 400 },
    );
  }

  const role = normalizeRole(input.role);
  if (role instanceof Response) {
    return role;
  }

  const modality = normalizeModality(input.modality);
  if (modality instanceof Response) {
    return modality;
  }

  const content = optionalString(input.content, MAX_EVENT_CONTENT_LENGTH);
  if (content instanceof Response) {
    return content;
  }

  const metadataJson = normalizeMetadata(input.metadata);
  if (metadataJson instanceof Response) {
    return metadataJson;
  }

  const clientCreatedAt = optionalString(input.clientCreatedAt, 80);
  if (clientCreatedAt instanceof Response) {
    return clientCreatedAt;
  }

  return {
    id: crypto.randomUUID(),
    sessionId,
    sequence,
    eventType,
    role,
    modality,
    content,
    metadataJson,
    clientCreatedAt,
  };
}

function normalizeFinishStatus(value: unknown): FinishStatus | null {
  if (value === undefined) {
    return "ended";
  }

  return value === "ended" || value === "failed" || value === "cancelled" ? value : null;
}

function normalizeSequence(value: unknown, fallback: number): number | null {
  if (value === undefined || value === null) {
    return fallback;
  }

  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function normalizeRole(value: unknown): EventRole | null | Response {
  if (value === undefined || value === null) {
    return null;
  }

  if (value === "student" || value === "assistant" || value === "system" || value === "tool") {
    return value;
  }

  return jsonResponse(
    {
      error: "invalid_role",
      message: "Role must be student, assistant, system, or tool.",
    },
    { status: 400 },
  );
}

function normalizeModality(value: unknown): EventModality | null | Response {
  if (value === undefined || value === null) {
    return null;
  }

  if (value === "audio") {
    return jsonResponse(
      {
        error: "raw_audio_not_allowed",
        message: "Use audio_transcript for text derived from audio; do not store raw audio in D1.",
      },
      { status: 400 },
    );
  }

  if (
    value === "text" ||
    value === "image" ||
    value === "audio_transcript" ||
    value === "system" ||
    value === "data"
  ) {
    return value;
  }

  return jsonResponse(
    {
      error: "invalid_modality",
      message: "Modality must be text, image, audio_transcript, system, or data.",
    },
    { status: 400 },
  );
}

function normalizeMetadata(value: unknown): string | null | Response {
  if (value === undefined || value === null) {
    return null;
  }

  const metadataJson = JSON.stringify(value);
  if (metadataJson.length > MAX_EVENT_METADATA_LENGTH) {
    return jsonResponse(
      {
        error: "metadata_too_large",
        message: `Event metadata must be ${MAX_EVENT_METADATA_LENGTH} characters or less.`,
      },
      { status: 413 },
    );
  }

  return metadataJson;
}

function optionalString(value: unknown, maxLength: number): string | null | Response {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    return jsonResponse(
      {
        error: "invalid_string",
        message: "Expected a string value.",
      },
      { status: 400 },
    );
  }

  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    return jsonResponse(
      {
        error: "string_too_long",
        message: `String value must be ${maxLength} characters or less.`,
      },
      { status: 413 },
    );
  }

  return trimmed || null;
}

function parseOptionalHeader(value: string | null, maxLength: number): string | null | Response {
  if (!value) {
    return null;
  }

  if (value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    return jsonResponse(
      {
        error: "invalid_header",
        message: "Optional header value is invalid.",
      },
      { status: 400 },
    );
  }

  return value.trim() || null;
}

function hasRawAudioPayload(input: SessionEventInput): boolean {
  return ["audio", "audioBase64", "audioBlob", "blob", "dataUri"].some(
    (key) => key in input,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sessionNotFound(): Response {
  return jsonResponse(
    {
      error: "session_not_found",
      message: "Session was not found for this authenticated user.",
    },
    { status: 404 },
  );
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(Math.max(Math.trunc(value), min), max);
}

function nowIso(): string {
  return new Date().toISOString();
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function normalizedEmail(payload: JWTPayload): string | null {
  const accessPayload = payload as AccessPayload;
  if (typeof accessPayload.email !== "string") {
    return null;
  }

  const email = accessPayload.email.trim().toLowerCase();
  return email.includes("@") ? email : null;
}

async function safetyIdentifier(email: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(salt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(email));
  return `family-tutor:${toHex(signature)}`;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function looksLikeSdpOffer(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SDP_LENGTH && /\nm=/.test(value) && /\na=/.test(value);
}

function requiredSecret(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeTeamDomain(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`);
    return url.origin;
  } catch {
    return null;
  }
}

function configurationError(message: string): Response {
  return jsonResponse(
    {
      error: "configuration_error",
      message,
    },
    { status: 503 },
  );
}

function jsonResponse(
  body: JsonBody,
  init: ResponseInit & { headers?: HeadersInit } = {},
): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...cacheControlHeaders(),
      ...headersToRecord(init.headers),
    },
  });
}

function withCors(response: Response, request: Request, env: TutorEnv): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request, env))) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function corsHeaders(request: Request, env: TutorEnv): Record<string, string> {
  const origin = request.headers.get("origin");
  const allowedOrigins = new Set(
    (env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );

  const headers: Record<string, string> = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Cf-Access-Jwt-Assertion,X-Tutor-Photo-Key",
    "Access-Control-Expose-Headers": "X-Tutor-Session-Id,X-OpenAI-Request-Id",
    "Access-Control-Max-Age": "86400",
  };

  if (origin && allowedOrigins.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  return headers;
}

function cacheControlHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store",
  };
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }

  return Object.fromEntries(new Headers(headers).entries());
}
