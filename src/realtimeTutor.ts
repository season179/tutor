import type { TutorAccess } from './tutorBackend';

export type TutorTranscriptEntry = {
  id: string;
  role: 'student' | 'assistant' | 'system';
  text: string;
};

export type TutorRealtimeSession = {
  sessionId: string;
  photoR2Key: string | null;
  sendText: (text: string) => void;
  setMuted: (muted: boolean) => void;
  end: (status?: 'ended' | 'failed' | 'cancelled', errorSummary?: string) => Promise<void>;
};

export type StartTutorRealtimeSessionInput = {
  backendUrl: string;
  access: TutorAccess;
  photoUri: string;
  photoContentType: string;
  photoWidth: number;
  photoHeight: number;
  onStatus: (status: string) => void;
  onTranscript: (entry: TutorTranscriptEntry) => void;
  onAssistantDelta: (delta: string) => void;
  onError: (message: string) => void;
};

export async function startTutorRealtimeSession(
  _input: StartTutorRealtimeSessionInput,
): Promise<TutorRealtimeSession> {
  throw new Error('Realtime tutoring requires a native development build.');
}
