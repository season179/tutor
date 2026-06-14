import { requireNativeModule } from 'expo';

type TutorAudioRouteModule = {
  setSpeakerEnabled(enabled: boolean): Promise<void>;
};

const TutorAudioRoute = requireNativeModule<TutorAudioRouteModule>('TutorAudioRoute');

export function setSpeakerEnabled(enabled: boolean): Promise<void> {
  return TutorAudioRoute.setSpeakerEnabled(enabled);
}
