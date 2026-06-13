import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const DEFAULT_MODEL = "gpt-realtime-2";
const DEFAULT_VOICE = "marin";
const SERVICE_NAME = "tutor-backend";

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
          realtimeModel: env.OPENAI_REALTIME_MODEL || DEFAULT_MODEL,
          realtimeVoice: env.OPENAI_REALTIME_VOICE || DEFAULT_VOICE,
        },
        { headers: corsHeaders(request, env) },
      );
    }

    if (url.pathname === "/session" && request.method === "POST") {
      return withCors(await createRealtimeSession(request, env), request, env);
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

  const formData = new FormData();
  formData.set("sdp", offerSdp);
  formData.set("session", JSON.stringify(realtimeSessionConfig(env)));

  const openAiResponse = await fetch(OPENAI_REALTIME_CALLS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiApiKey}`,
      "OpenAI-Safety-Identifier": await safetyIdentifier(access.email, salt),
    },
    body: formData,
  });

  if (!openAiResponse.ok) {
    const requestId = openAiResponse.headers.get("x-request-id");
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

  return new Response(openAiResponse.body, {
    status: 200,
    headers: {
      "Content-Type": "application/sdp",
      ...cacheControlHeaders(),
    },
  });
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
  return value.length > 0 && value.length <= 256_000 && /\nm=/.test(value) && /\na=/.test(value);
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
    "Access-Control-Allow-Headers": "Content-Type,Cf-Access-Jwt-Assertion",
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
