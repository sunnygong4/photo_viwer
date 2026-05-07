import SwiftUI

@main
struct sCloudApp: App {
    @StateObject private var api = APIClient.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(api)
        }
    }
}
