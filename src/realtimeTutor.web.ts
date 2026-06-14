import type { StartTutorRealtimeSessionInput, TutorRealtimeSession } from './realtimeTutor';

export {
  type StartTutorRealtimeSessionInput,
  type TutorRealtimeSession,
  type TutorTranscriptEntry,
} from './realtimeTutor';

export async function startTutorRealtimeSession(
  _input: StartTutorRealtimeSessionInput,
): Promise<TutorRealtimeSession> {
  throw new Error('Realtime tutoring requires a native development build.');
}
