import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var api: APIClient
    @Environment(\.dismiss) private var dismiss

    @State private var urlText   = ""
    @State private var tokenText = ""
    @State private var status: TestStatus = .idle

    enum TestStatus {
        case idle, testing, ok, error(String)
        var color: Color {
            switch self {
            case .ok:    return .green
            case .error: return .red
            default:     return .secondary
            }
        }
    }

    var body: some View {
        Form {
            Section {
                LabeledContent("Server URL") {
                    TextField("https://photos.example.com", text: $urlText)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .multilineTextAlignment(.trailing)
                }
                LabeledContent("Token") {
                    SecureField("scloud-desktop-v1-…", text: $tokenText)
                        .multilineTextAlignment(.trailing)
                }
            } header: {
                Text("Connection")
            } footer: {
                Text("The token is the DESKTOP_TOKEN set on your server. Default: scloud-desktop-v1-a9f3c2e8b7d4")
            }

            Section {
                Button("Test Connection") {
                    Task { await testConnection() }
                }
                .disabled(urlText.isEmpty || tokenText.isEmpty || status == .testing)

                switch status {
                case .testing:
                    HStack {
                        ProgressView().scaleEffect(0.8)
                        Text("Connecting…").foregroundStyle(.secondary)
                    }
                case .ok:
                    Label("Connected successfully", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                case .error(let msg):
                    Label(msg, systemImage: "xmark.circle.fill")
                        .foregroundStyle(.red)
                case .idle:
                    EmptyView()
                }
            }

            Section {
                Button("Save & Apply") {
                    save()
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .disabled(urlText.isEmpty || tokenText.isEmpty)
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            urlText   = api.baseURL.absoluteString
            tokenText = api.token
        }
    }

    private func testConnection() async {
        status = .testing
        // Temporarily apply the new values for the test
        let orig = (api.baseURL, api.token)
        try? api.save(urlString: urlText, newToken: tokenText)
        do {
            try await api.testConnection()
            status = .ok
        } catch {
            status = .error(error.localizedDescription)
            // Restore original on failure
            try? api.save(urlString: orig.0.absoluteString, newToken: orig.1)
        }
    }

    private func save() {
        try? api.save(urlString: urlText, newToken: tokenText)
    }
}
