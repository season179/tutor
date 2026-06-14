import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-realtime-2";
const DEFAULT_QUESTION_EXTRACTION_MODEL = "gpt-5.4-mini-2026-03-17";
const DEFAULT_VOICE = "marin";
const SERVICE_NAME = "tutor-backend";
const MAX_SDP_LENGTH = 256_000;
const MAX_ERROR_SUMMARY_LENGTH = 1_000;
const MAX_EVENT_CONTENT_LENGTH = 16_000;
const MAX_EVENT_METADATA_LENGTH = 16_000;
const MAX_EVENTS_PER_REQUEST = 50;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_OPENAI_ERROR_LOG_LENGTH = 4_000;

type SecretEnv = {
  OPENAI_API_KEY?: string;
  CLOUDFLARE_ACCESS_AUD?: string;
  OPENAI_SAFETY_IDENTIFIER_SALT?: string;
  OPENAI_QUESTION_EXTRACTION_MODEL?: string;
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

type PhotoMetadata = {
  id: string;
  sessionId: string;
  userId: string;
  r2Key: string;
  contentType: string;
  sizeBytes: number;
  sha256Hex: string;
  etag: string | null;
  originalFilename: string | null;
  uploadedAt: string;
};

type QuestionExtractionResult = {
  extractedQuestion: string;
  isTutorable: boolean;
  confidence: number;
  reason: string;
  needsRetake: boolean;
  blockers: string[];
  openAiRequestId: string | null;
};

const TUTOR_INSTRUCTIONS = `# Role and Objective
You are a gentle, patient tutor helping a child solve a photographed school question.

# First Turn
- When an image is provided, analyze the photo before starting the conversation.
- Be the first to speak. Do not wait for the child to describe the photo.
- If you can detect the question, briefly say what you see, then ask one small guiding question.
- If the photo is unclear or incomplete, say exactly what is hard to read and gently ask the child to retake the photo or read that part aloud.
- Do not say you did not receive a photo when image context was provided; say it is unclear only if you cannot read it.

# Language
- Match the language used in the photo when it is clear.
- Chinese and Mandarin text are in scope. If the photo contains Chinese characters, try to read them directly.
- Also listen to the language the child uses when speaking or typing, and respond in that language.
- If the photo language and the child's language differ, prefer the child's language while preserving exact question text when needed.
- If the language is ambiguous, use simple English first and ask which language the child prefers.

# Teaching Style
- Guide the student step by step instead of giving the final answer.
- Ask one small question at a time when the next step depends on the student's thinking.
- Use clear language and very short spoken turns.
- Speak very slowly, calmly, and warmly, with simple words suitable for a child.
- Pause naturally between ideas. Avoid long explanations.
- If the student is stuck, give a hint, then wait for them to try.
- Praise effort calmly without overdoing it.

# Answer Policy
- Under normal circumstances, do not tell the student the final answer.
- If the student asks for the answer, gently redirect them to the next small step instead.
- Use progressively clearer hints before giving away the answer.
- Only give the answer when the student seems very frustrated, discouraged, or has very little chance of figuring it out after multiple hints or attempts.
- When you do give the answer, be kind and brief: explain the key step, reassure the student, and invite them to try the next similar problem.

# Working Time
- Give the student quiet time to think, calculate, read, write, or work through a step.
- Do not interrupt silence. Silence usually means the student is thinking.
- Do not interrupt when the student is thinking out loud, counting, rereading the question, sounding out words, or self-correcting.
- Stay quiet unless the student asks for help, gives a final answer, sounds clearly stuck, or has paused after asking a question.
- Do not treat a long pause by itself as frustration.

# Boundaries
- Do not shame, scold, or rush the student.
- Do not claim you can see an image unless image context has actually been provided in the conversation.
- Do not say you cannot read Chinese or Mandarin. Say only that the photo/text is unclear if the image quality prevents reading it.
- If the question is unclear, ask the student to retake the photo or read the missing part aloud.

# Reasoning
- Use low-latency reasoning for simple steps.
- For multi-step math or word problems, reason through the solution before speaking, then explain only the next useful step.
- Never reveal private chain-of-thought; give concise reasoning that is appropriate for a child.

# Output
- Speak naturally and kindly.
- Keep responses concise enough for a slow voice conversation.
- Provide text output that matches the spoken guidance.`;

const QUESTION_EXTRACTION_PROMPT = `Extract the printed school question from this image and decide whether it is ready for a child tutor to help with.

Rules:
- Preserve the original language, numbers, currency symbols, units, names, punctuation, and answer blanks.
- Ignore handwritten working and handwritten answers unless they are clearly correcting the printed question.
- Include the final answer sentence or blank if it is printed as part of the exercise.
- Mark is_tutorable true only when there is a readable school question or exercise with enough information for a tutor to guide the child.
- Mark is_tutorable false when the image is too blurry, incomplete, not a school question, missing key numbers/text, or otherwise not useful for tutoring.
- Set needs_retake true when the user should take/select another photo.
- Keep reason short and user-facing.`;

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
          questionExtractionModel:
            env.OPENAI_QUESTION_EXTRACTION_MODEL || DEFAULT_QUESTION_EXTRACTION_MODEL,
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
          r2Configured: Boolean(env.TUTOR_PHOTOS),
          realtimeModel: env.OPENAI_REALTIME_MODEL || DEFAULT_MODEL,
          realtimeVoice: env.OPENAI_REALTIME_VOICE || DEFAULT_VOICE,
          questionExtractionModel:
            env.OPENAI_QUESTION_EXTRACTION_MODEL || DEFAULT_QUESTION_EXTRACTION_MODEL,
        },
        { headers: corsHeaders(request, env) },
      );
    }

    if (url.pathname === "/session" && request.method === "POST") {
      return withCors(await createRealtimeSession(request, env), request, env);
    }

    if (url.pathname === "/question-extractions" && request.method === "POST") {
      return withCors(await createQuestionExtraction(request, env), request, env);
    }

    if (url.pathname === "/sessions/recent" && request.method === "GET") {
      return withCors(await listRecentSessions(request, env), request, env);
    }

    const sessionRoute = parseSessionRoute(url.pathname);
    if (sessionRoute) {
      if (sessionRoute.action === "photos" && request.method === "GET") {
        return withCors(
          await listSessionPhotos(request, env, sessionRoute.sessionId),
          request,
          env,
        );
      }

      if (sessionRoute.action === "photo" && request.method === "POST") {
        return withCors(
          await uploadSessionPhoto(request, env, sessionRoute.sessionId),
          request,
          env,
        );
      }

      if (sessionRoute.action === "events" && request.method === "POST") {
        return withCors(
          await appendSessionEvents(request, env, sessionRoute.sessionId),
          request,
          env,
        );
      }

      if (sessionRoute.action === "finish" && request.method === "POST") {
        return withCors(
          await finishSession(request, env, sessionRoute.sessionId),
          request,
          env,
        );
      }
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
    const errorBody = await readResponseText(openAiResponse);

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
        errorBody,
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

  const records = await persistSessionEvents(env.TUTOR_DB, sessionId, inputs);
  if (records instanceof Response) {
    return records;
  }

  await touchSession(env.TUTOR_DB, sessionId);

  return jsonResponse({
    ok: true,
    sessionId,
    stored: records.length,
  });
}

async function createQuestionExtraction(request: Request, env: TutorEnv): Promise<Response> {
  const accessContext = await requireAccessContext(request, env);
  if (accessContext instanceof Response) {
    return accessContext;
  }

  const openAiApiKey = requiredSecret(env.OPENAI_API_KEY);
  if (!openAiApiKey) {
    return configurationError("OPENAI_API_KEY is not configured.");
  }

  const bucket = requiredPhotoBucket(env);
  if (bucket instanceof Response) {
    return bucket;
  }

  const contentType = normalizeImageContentType(request.headers.get("content-type"));
  if (!contentType) {
    return jsonResponse(
      {
        error: "unsupported_media_type",
        message: "Upload a JPEG, PNG, WebP, HEIC, or HEIF image.",
      },
      { status: 415 },
    );
  }

  const declaredLength = parseContentLength(request.headers.get("content-length"));
  if (declaredLength > MAX_PHOTO_BYTES) {
    return photoTooLarge();
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) {
    return jsonResponse(
      {
        error: "empty_photo",
        message: "Photo upload body cannot be empty.",
      },
      { status: 400 },
    );
  }

  if (bytes.byteLength > MAX_PHOTO_BYTES) {
    return photoTooLarge();
  }

  const originalFilename = parseOptionalHeader(
    request.headers.get("x-tutor-photo-filename"),
    200,
  );
  if (originalFilename instanceof Response) {
    return originalFilename;
  }

  const sessionId = crypto.randomUUID();
  const startedAt = nowIso();
  const modelId = env.OPENAI_QUESTION_EXTRACTION_MODEL || DEFAULT_QUESTION_EXTRACTION_MODEL;

  await createSessionRow(env.TUTOR_DB, {
    id: sessionId,
    userId: accessContext.userId,
    startedAt,
    status: "starting",
    modelId,
    photoR2Key: null,
  });

  const photo = await storeSessionPhoto({
    bucket,
    db: env.TUTOR_DB,
    bytes,
    contentType,
    originalFilename,
    sessionId,
    userId: accessContext.userId,
  });
  if (photo instanceof Response) {
    await markSessionFailed(env.TUTOR_DB, sessionId, "Question photo storage failed.", null);
    return photo;
  }

  const extraction = await extractQuestionText({
    apiKey: openAiApiKey,
    bytes,
    contentType,
    modelId,
    userId: accessContext.userId,
  });
  if (extraction instanceof Response) {
    await markSessionFailed(
      env.TUTOR_DB,
      sessionId,
      "Question text extraction failed.",
      extraction.headers.get("x-openai-request-id"),
    );
    return extraction;
  }

  const storedEvents = await persistSessionEvents(env.TUTOR_DB, sessionId, [
    {
      eventType: "question_photo_sent",
      role: "student",
      modality: "image",
      content: photo.r2Key,
      metadata: {
        r2Key: photo.r2Key,
        contentType: photo.contentType,
        sizeBytes: photo.sizeBytes,
        sha256Hex: photo.sha256Hex,
      },
      clientCreatedAt: startedAt,
    },
    {
      eventType: "question_text_extracted",
      role: "tool",
      modality: "text",
      content: extraction.extractedQuestion,
      metadata: {
        modelId,
        openAiRequestId: extraction.openAiRequestId,
        isTutorable: extraction.isTutorable,
        confidence: extraction.confidence,
        reason: extraction.reason,
        needsRetake: extraction.needsRetake,
        blockers: extraction.blockers,
      },
      clientCreatedAt: nowIso(),
    },
  ]);
  if (storedEvents instanceof Response) {
    await markSessionFailed(env.TUTOR_DB, sessionId, "Question extraction events could not be stored.", extraction.openAiRequestId);
    return storedEvents;
  }

  await markSessionActive(env.TUTOR_DB, sessionId, extraction.openAiRequestId);

  return jsonResponse({
    ok: true,
    sessionId,
    modelId,
    openAiRequestId: extraction.openAiRequestId,
    extractedQuestion: extraction.extractedQuestion,
    isTutorable: extraction.isTutorable,
    confidence: extraction.confidence,
    reason: extraction.reason,
    needsRetake: extraction.needsRetake,
    blockers: extraction.blockers,
    photo: {
      id: photo.id,
      r2Key: photo.r2Key,
      contentType: photo.contentType,
      sizeBytes: photo.sizeBytes,
      sha256Hex: photo.sha256Hex,
      uploadedAt: photo.uploadedAt,
    },
  });
}

async function extractQuestionText(input: {
  apiKey: string;
  bytes: ArrayBuffer;
  contentType: string;
  modelId: string;
  userId: string;
}): Promise<QuestionExtractionResult | Response> {
  let response: Response;
  try {
    response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Safety-Identifier": input.userId,
      },
      body: JSON.stringify({
        model: input.modelId,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: QUESTION_EXTRACTION_PROMPT,
              },
              {
                type: "input_image",
                image_url: `data:${input.contentType};base64,${arrayBufferToBase64(input.bytes)}`,
                detail: "high",
              },
            ],
          },
        ],
        max_output_tokens: 800,
        text: {
          format: {
            type: "json_schema",
            name: "question_extraction_decision",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                extracted_question: {
                  type: "string",
                  description: "The extracted printed school question text, preserving the original language.",
                },
                is_tutorable: {
                  type: "boolean",
                  description: "True when the extracted text is a school question a child tutor can help with.",
                },
                confidence: {
                  type: "number",
                  description: "Confidence from 0 to 1.",
                },
                reason: {
                  type: "string",
                  description: "Short user-facing reason for the decision.",
                },
                needs_retake: {
                  type: "boolean",
                  description: "True when the user should take/select another photo.",
                },
                blockers: {
                  type: "array",
                  description: "Short labels for issues preventing tutoring.",
                  items: {
                    type: "string",
                  },
                },
              },
              required: [
                "extracted_question",
                "is_tutorable",
                "confidence",
                "reason",
                "needs_retake",
                "blockers",
              ],
            },
          },
        },
      }),
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        service: SERVICE_NAME,
        event: "openai_question_extraction_request_error",
        modelId: input.modelId,
        message: error instanceof Error ? error.message : "Unknown OpenAI request error",
      }),
    );

    return jsonResponse(
      {
        error: "question_extraction_failed",
        message: "Failed to extract the question text.",
      },
      { status: 502 },
    );
  }

  const requestId = response.headers.get("x-request-id");
  if (!response.ok) {
    const errorBody = await readResponseText(response);
    console.error(
      JSON.stringify({
        service: SERVICE_NAME,
        event: "openai_question_extraction_failed",
        status: response.status,
        requestId,
        modelId: input.modelId,
        errorBody,
      }),
    );

    return jsonResponse(
      {
        error: "question_extraction_failed",
        message: "Failed to extract the question text.",
        requestId,
      },
      {
        status: 502,
        headers: requestId ? { "X-OpenAI-Request-Id": requestId } : undefined,
      },
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    console.error(
      JSON.stringify({
        service: SERVICE_NAME,
        event: "openai_question_extraction_json_error",
        requestId,
        modelId: input.modelId,
        message: error instanceof Error ? error.message : "Unknown OpenAI response parse error",
      }),
    );

    return jsonResponse(
      {
        error: "question_extraction_failed",
        message: "Could not read the extracted question text.",
        requestId,
      },
      {
        status: 502,
        headers: requestId ? { "X-OpenAI-Request-Id": requestId } : undefined,
      },
    );
  }

  const decision = parseQuestionExtractionDecision(body);
  if (!decision) {
    console.error(
      JSON.stringify({
        service: SERVICE_NAME,
        event: "openai_question_extraction_empty",
        requestId,
        modelId: input.modelId,
      }),
    );

    return jsonResponse(
      {
        error: "question_extraction_empty",
        message: "OpenAI did not return extracted question text.",
        requestId,
      },
      {
        status: 502,
        headers: requestId ? { "X-OpenAI-Request-Id": requestId } : undefined,
      },
    );
  }

  return {
    ...decision,
    openAiRequestId: requestId,
  };
}

async function uploadSessionPhoto(
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

  const bucket = requiredPhotoBucket(env);
  if (bucket instanceof Response) {
    return bucket;
  }

  const contentType = normalizeImageContentType(request.headers.get("content-type"));
  if (!contentType) {
    return jsonResponse(
      {
        error: "unsupported_media_type",
        message: "Upload a JPEG, PNG, WebP, HEIC, or HEIF image.",
      },
      { status: 415 },
    );
  }

  const declaredLength = parseContentLength(request.headers.get("content-length"));
  if (declaredLength > MAX_PHOTO_BYTES) {
    return photoTooLarge();
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) {
    return jsonResponse(
      {
        error: "empty_photo",
        message: "Photo upload body cannot be empty.",
      },
      { status: 400 },
    );
  }

  if (bytes.byteLength > MAX_PHOTO_BYTES) {
    return photoTooLarge();
  }

  const originalFilename = parseOptionalHeader(
    request.headers.get("x-tutor-photo-filename"),
    200,
  );
  if (originalFilename instanceof Response) {
    return originalFilename;
  }

  const metadata = await storeSessionPhoto({
    bucket,
    db: env.TUTOR_DB,
    bytes,
    contentType,
    originalFilename,
    sessionId,
    userId: accessContext.userId,
  });
  if (metadata instanceof Response) {
    return metadata;
  }

  return jsonResponse(
    {
      ok: true,
      sessionId,
      photo: {
        id: metadata.id,
        r2Key: metadata.r2Key,
        contentType: metadata.contentType,
        sizeBytes: metadata.sizeBytes,
        sha256Hex: metadata.sha256Hex,
        uploadedAt: metadata.uploadedAt,
      },
    },
    {
      headers: {
        "X-Tutor-Photo-Key": metadata.r2Key,
      },
    },
  );
}

async function listSessionPhotos(
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

  const { results } = await env.TUTOR_DB.prepare(
    `SELECT
        id,
        r2_key,
        content_type,
        size_bytes,
        sha256_hex,
        etag,
        original_filename,
        uploaded_at
      FROM tutor_session_photos
      WHERE session_id = ? AND user_id = ?
      ORDER BY uploaded_at DESC`,
  )
    .bind(sessionId, accessContext.userId)
    .all();

  return jsonResponse({
    ok: true,
    sessionId,
    photos: results,
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
    output_modalities: ["audio"],
    reasoning: {
      effort: "low",
    },
    audio: {
      input: {
        turn_detection: {
          type: "server_vad",
          threshold: 0.75,
          prefix_padding_ms: 300,
          silence_duration_ms: 700,
          create_response: true,
          interrupt_response: true,
        },
      },
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

function requiredPhotoBucket(env: TutorEnv): R2Bucket | Response {
  if (!env.TUTOR_PHOTOS) {
    return configurationError("TUTOR_PHOTOS R2 binding is not configured.");
  }

  return env.TUTOR_PHOTOS;
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

async function persistPhotoMetadata(db: D1Database, metadata: PhotoMetadata): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO tutor_session_photos (
          id,
          session_id,
          user_id,
          r2_key,
          content_type,
          size_bytes,
          sha256_hex,
          etag,
          original_filename,
          uploaded_at,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        metadata.id,
        metadata.sessionId,
        metadata.userId,
        metadata.r2Key,
        metadata.contentType,
        metadata.sizeBytes,
        metadata.sha256Hex,
        metadata.etag,
        metadata.originalFilename,
        metadata.uploadedAt,
        metadata.uploadedAt,
      ),
    db
      .prepare(
        `UPDATE tutor_sessions
          SET photo_r2_key = ?,
              updated_at = ?
          WHERE id = ? AND user_id = ?`,
      )
      .bind(metadata.r2Key, metadata.uploadedAt, metadata.sessionId, metadata.userId),
  ]);
}

async function storeSessionPhoto(input: {
  bucket: R2Bucket;
  db: D1Database;
  bytes: ArrayBuffer;
  contentType: string;
  originalFilename: string | null;
  sessionId: string;
  userId: string;
}): Promise<PhotoMetadata | Response> {
  const photoId = crypto.randomUUID();
  const uploadedAt = nowIso();
  const sha256 = await crypto.subtle.digest("SHA-256", input.bytes);
  const sha256Hex = toHex(sha256);
  const r2Key = photoObjectKey(input.sessionId, photoId, input.contentType);
  let object: R2Object | null;

  try {
    object = await input.bucket.put(r2Key, input.bytes, {
      httpMetadata: {
        contentType: input.contentType,
        cacheControl: "private, max-age=0, no-store",
      },
      customMetadata: {
        sessionId: input.sessionId,
        userId: input.userId,
        sha256: sha256Hex,
        uploadedAt,
      },
      sha256,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        service: SERVICE_NAME,
        event: "r2_photo_upload_failed",
        sessionId: input.sessionId,
        message: error instanceof Error ? error.message : "Unknown R2 upload error",
      }),
    );

    return jsonResponse(
      {
        error: "photo_upload_failed",
        message: "Failed to store the photo.",
      },
      { status: 502 },
    );
  }

  if (!object) {
    return jsonResponse(
      {
        error: "photo_upload_failed",
        message: "Failed to store the photo.",
      },
      { status: 502 },
    );
  }

  const metadata: PhotoMetadata = {
    id: photoId,
    sessionId: input.sessionId,
    userId: input.userId,
    r2Key,
    contentType: input.contentType,
    sizeBytes: input.bytes.byteLength,
    sha256Hex,
    etag: object.etag,
    originalFilename: sanitizeFilename(input.originalFilename),
    uploadedAt,
  };

  try {
    await persistPhotoMetadata(input.db, metadata);
  } catch (error) {
    await deleteUploadedPhotoBestEffort(input.bucket, r2Key, input.sessionId, photoId);
    console.error(
      JSON.stringify({
        service: SERVICE_NAME,
        event: "photo_metadata_persist_failed",
        sessionId: input.sessionId,
        photoId,
        message: error instanceof Error ? error.message : "Unknown D1 photo metadata error",
      }),
    );

    return jsonResponse(
      {
        error: "photo_metadata_failed",
        message: "Failed to store photo metadata.",
      },
      { status: 500 },
    );
  }

  return metadata;
}

async function deleteUploadedPhotoBestEffort(
  bucket: R2Bucket,
  r2Key: string,
  sessionId: string,
  photoId: string,
): Promise<void> {
  try {
    await bucket.delete(r2Key);
  } catch (error) {
    console.error(
      JSON.stringify({
        service: SERVICE_NAME,
        event: "r2_photo_cleanup_failed",
        sessionId,
        photoId,
        message: error instanceof Error ? error.message : "Unknown R2 cleanup error",
      }),
    );
  }
}

function parseSessionRoute(pathname: string): {
  sessionId: string;
  action: "events" | "finish" | "photo" | "photos";
} | null {
  const match = pathname.match(/^\/sessions\/([^/]+)\/(events|finish|photo|photos)$/);
  if (!match) {
    return null;
  }

  return {
    sessionId: decodeURIComponent(match[1]),
    action: match[2] as "events" | "finish" | "photo" | "photos",
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

async function readResponseText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, MAX_OPENAI_ERROR_LOG_LENGTH);
  } catch (error) {
    return error instanceof Error ? `Could not read response body: ${error.message}` : "Could not read response body.";
  }
}

async function persistSessionEvents(
  db: D1Database,
  sessionId: string,
  inputs: SessionEventInput[],
): Promise<SessionEventRecord[] | Response> {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const records = await prepareSessionEventRecords(db, sessionId, inputs);
    if (records instanceof Response) {
      return records;
    }

    try {
      await db.batch(
        records.map((record) =>
          db.prepare(
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

      return records;
    } catch (error) {
      if (isSessionEventSequenceConflict(error)) {
        if (attempt < maxAttempts) {
          continue;
        }

        return jsonResponse(
          {
            error: "event_sequence_conflict",
            message: "Could not store session events. Please try again.",
          },
          { status: 409 },
        );
      }

      throw error;
    }
  }

  throw new Error("Could not store session events.");
}

async function prepareSessionEventRecords(
  db: D1Database,
  sessionId: string,
  inputs: SessionEventInput[],
): Promise<SessionEventRecord[] | Response> {
  const nextSequence = await getNextEventSequence(db, sessionId);
  const records: SessionEventRecord[] = [];

  for (const [index, input] of inputs.entries()) {
    const record = normalizeEventInput(input, sessionId, nextSequence + index);
    if (record instanceof Response) {
      return record;
    }
    records.push(record);
  }

  return records;
}

function isSessionEventSequenceConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("UNIQUE constraint failed: tutor_session_events.session_id, tutor_session_events.sequence") ||
    message.includes("SQLITE_CONSTRAINT_UNIQUE")
  );
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

function extractOpenAIOutputText(body: unknown): string | null {
  if (!isRecord(body)) {
    return null;
  }

  if (typeof body.output_text === "string" && body.output_text.trim()) {
    return body.output_text.trim();
  }

  const output = Array.isArray(body.output) ? body.output : [];
  const textParts: string[] = [];

  for (const outputItem of output) {
    if (!isRecord(outputItem)) {
      continue;
    }

    const content = Array.isArray(outputItem.content) ? outputItem.content : [];
    for (const contentItem of content) {
      if (!isRecord(contentItem)) {
        continue;
      }

      if (typeof contentItem.text === "string" && contentItem.text.trim()) {
        textParts.push(contentItem.text.trim());
      }
    }
  }

  return textParts.length > 0 ? textParts.join("\n").trim() : null;
}

function parseQuestionExtractionDecision(body: unknown): Omit<QuestionExtractionResult, "openAiRequestId"> | null {
  const text = extractOpenAIOutputText(body);
  if (!text) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  const extractedQuestion = stringField(parsed.extracted_question);
  const reason = stringField(parsed.reason);
  const blockers = Array.isArray(parsed.blockers)
    ? parsed.blockers.filter((blocker): blocker is string => typeof blocker === "string")
    : null;

  if (
    extractedQuestion === null ||
    typeof parsed.is_tutorable !== "boolean" ||
    typeof parsed.confidence !== "number" ||
    reason === null ||
    typeof parsed.needs_retake !== "boolean" ||
    blockers === null
  ) {
    return null;
  }

  return {
    extractedQuestion,
    isTutorable: parsed.is_tutorable,
    confidence: clampConfidence(parsed.confidence),
    reason,
    needsRetake: parsed.needs_retake,
    blockers,
  };
}

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value.trim() : null;
}

function clampConfidence(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

function normalizeImageContentType(value: string | null): string | null {
  const contentType = value?.split(";")[0]?.trim().toLowerCase() || null;
  return imageExtension(contentType) ? contentType : null;
}

function imageExtension(contentType: string | null | undefined): string | null {
  switch (contentType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/heic":
      return "heic";
    case "image/heif":
      return "heif";
    default:
      return null;
  }
}

function photoObjectKey(sessionId: string, photoId: string, contentType: string): string {
  const extension = imageExtension(contentType) || "bin";
  return `sessions/${sessionId}/photos/${photoId}.${extension}`;
}

function parseContentLength(value: string | null): number {
  if (!value) {
    return 0;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function photoTooLarge(): Response {
  return jsonResponse(
    {
      error: "photo_too_large",
      message: `Photo must be ${MAX_PHOTO_BYTES} bytes or less.`,
    },
    { status: 413 },
  );
}

function sanitizeFilename(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const withoutPath = value.split(/[\\/]/).at(-1)?.trim() || null;
  return withoutPath ? withoutPath.slice(0, 200) : null;
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
  return toHex(signature);
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
    "Access-Control-Allow-Headers":
      "Content-Type,Cf-Access-Jwt-Assertion,X-Tutor-Photo-Key,X-Tutor-Photo-Filename",
    "Access-Control-Expose-Headers": "X-Tutor-Session-Id,X-OpenAI-Request-Id,X-Tutor-Photo-Key",
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
