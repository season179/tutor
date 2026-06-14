import { File, UploadType, type UploadResult } from 'expo-file-system';

export type TutorAccess = {
  cookieHeader: string;
};

export type TutorPhotoUpload = {
  r2Key: string;
};

export type TutorBackendSession = {
  answerSdp: string;
  sessionId: string;
  openAiRequestId: string | null;
};

export class TutorBackendError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TutorBackendError';
  }
}

export function extractAccessCookie(cookieText: string): TutorAccess | null {
  const cookie = cookieText
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('CF_Authorization='));

  return cookie ? { cookieHeader: cookie } : null;
}

export async function createBackendRealtimeSession(params: {
  backendUrl: string;
  access: TutorAccess;
  offerSdp: string;
}): Promise<TutorBackendSession> {
  const response = await fetch(`${params.backendUrl}/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/sdp',
      Cookie: params.access.cookieHeader,
    },
    body: params.offerSdp,
  });

  if (!response.ok) {
    throw new TutorBackendError(await responseErrorMessage(response), response.status);
  }

  const answerSdp = await response.text();
  const sessionId = response.headers.get('x-tutor-session-id');
  if (!sessionId) {
    throw new TutorBackendError('Backend did not return a tutor session id.');
  }

  return {
    answerSdp,
    sessionId,
    openAiRequestId: response.headers.get('x-openai-request-id'),
  };
}

export async function uploadSessionPhoto(params: {
  backendUrl: string;
  access: TutorAccess;
  sessionId: string;
  photoUri: string;
  contentType: string;
}): Promise<TutorPhotoUpload> {
  const file = new File(params.photoUri);
  const result = await file.upload(`${params.backendUrl}/sessions/${params.sessionId}/photo`, {
    httpMethod: 'POST',
    uploadType: UploadType.BINARY_CONTENT,
    mimeType: params.contentType,
    headers: {
      'Content-Type': params.contentType,
      Cookie: params.access.cookieHeader,
      'X-Tutor-Photo-Filename': file.name || 'question-photo.jpg',
    },
  });

  if (result.status < 200 || result.status >= 300) {
    throw new TutorBackendError(uploadErrorMessage(result), result.status);
  }

  const body = safeParseJson(result.body) as { photo?: { r2Key?: string } } | null;
  const r2Key = body?.photo?.r2Key || responseHeader(result.headers, 'x-tutor-photo-key');
  if (!r2Key) {
    throw new TutorBackendError('Backend did not return a photo key.');
  }

  return { r2Key };
}

export async function appendTutorEvents(params: {
  backendUrl: string;
  access: TutorAccess;
  sessionId: string;
  events: Array<Record<string, unknown>>;
}): Promise<void> {
  const response = await fetch(`${params.backendUrl}/sessions/${params.sessionId}/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: params.access.cookieHeader,
    },
    body: JSON.stringify({ events: params.events }),
  });

  if (!response.ok) {
    throw new TutorBackendError(await responseErrorMessage(response), response.status);
  }
}

export async function finishTutorSession(params: {
  backendUrl: string;
  access: TutorAccess;
  sessionId: string;
  status?: 'ended' | 'failed' | 'cancelled';
  errorSummary?: string;
}): Promise<void> {
  const response = await fetch(`${params.backendUrl}/sessions/${params.sessionId}/finish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: params.access.cookieHeader,
    },
    body: JSON.stringify({
      status: params.status || 'ended',
      errorSummary: params.errorSummary,
    }),
  });

  if (!response.ok) {
    throw new TutorBackendError(await responseErrorMessage(response), response.status);
  }
}

async function responseErrorMessage(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      const body = (await response.json()) as { message?: unknown; error?: unknown };
      if (typeof body.message === 'string') {
        return body.message;
      }
      if (typeof body.error === 'string') {
        return body.error;
      }
    } catch {
      // Fall through to status text.
    }
  }

  return response.statusText || `Request failed with status ${response.status}.`;
}

function uploadErrorMessage(result: UploadResult): string {
  const body = safeParseJson(result.body) as { message?: unknown; error?: unknown } | null;
  if (typeof body?.message === 'string') {
    return body.message;
  }
  if (typeof body?.error === 'string') {
    return body.error;
  }
  return `Upload failed with status ${result.status}.`;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function responseHeader(headers: Record<string, string>, name: string): string | undefined {
  const normalizedName = name.toLowerCase();
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === normalizedName);
  return match?.[1];
}
