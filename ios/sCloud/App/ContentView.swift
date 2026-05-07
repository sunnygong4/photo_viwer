import SwiftUI

/// Root router — just goes straight to the gallery.
/// Auth is handled via X-sCloud-Token; if it fails, SettingsView shows the error.
struct ContentView: View {
    var body: some View {
        GalleryView()
    }
}
