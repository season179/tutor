import { setSpeakerEnabled } from 'tutor-audio-route';

export function setSpeakerOutputEnabled(enabled: boolean): Promise<void> {
  return setSpeakerEnabled(enabled);
}
