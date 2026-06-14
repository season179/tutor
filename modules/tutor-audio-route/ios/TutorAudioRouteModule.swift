import AVFoundation
import ExpoModulesCore

public class TutorAudioRouteModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TutorAudioRoute")

    AsyncFunction("setSpeakerEnabled") { (enabled: Bool) in
      let session = AVAudioSession.sharedInstance()
      let options: AVAudioSession.CategoryOptions
      if enabled {
        options = [.defaultToSpeaker, .allowBluetoothHFP]
      } else {
        options = [.allowBluetoothHFP]
      }

      try session.setCategory(.playAndRecord, mode: .voiceChat, options: options)
      try session.overrideOutputAudioPort(enabled ? .speaker : .none)
      try session.setActive(true)
    }
    .runOnQueue(.main)
  }
}
