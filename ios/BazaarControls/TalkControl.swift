import AppIntents
import SwiftUI
import WidgetKit

/// iOS 18 Control (Control Center / Lock Screen / Action Button) that runs the shared intent.
struct TalkControl: ControlWidget {
    static let kind = "com.sciscribe.bazaar.controls.talk"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: TalkControl.kind) {
            ControlWidgetButton(action: TalkToBazaarIntent()) {
                Label("Talk to Bazaar", systemImage: "waveform")
            }
        }
        .displayName("Talk to Bazaar")
        .description("Start a voice session with Bazaar.")
    }
}
