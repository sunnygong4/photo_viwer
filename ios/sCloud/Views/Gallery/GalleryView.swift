import SwiftUI

// ── View model ────────────────────────────────────────────────────────────────

@MainActor
class GalleryViewModel: ObservableObject {
    @Published var tree: PhotoTree?
    @Published var isLoading = false
    @Published var error: String?

    func load(api: APIClient, refresh: Bool = false) async {
        guard !isLoading else { return }
        isLoading = true
        error = nil
        defer { isLoading = false }
        do {
            let url = refresh
                ? URLComponents(url: api.baseURL.appendingPathComponent("/api/tree"),
                                resolvingAgainstBaseURL: false)
                    .map { var c = $0; c.queryItems = [URLQueryItem(name: "refresh", value: "1")]; return c.url! }
                    ?? api.baseURL.appendingPathComponent("/api/tree")
                : api.baseURL.appendingPathComponent("/api/tree")
            // Use the regular fetchTree (already wired). For refresh we bust via url — but
            // the simplest approach: just always call fetchTree and let the server TTL handle it.
            // For a forced rescan we want ?refresh=1; fetchTree doesn't take that param, so:
            if refresh {
                var req = URLRequest(url: url)
                req.setValue(api.token, forHTTPHeaderField: "X-sCloud-Token")
                let (data, res) = try await URLSession.shared.data(for: req)
                guard let http = res as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                    throw APIError.httpError((res as? HTTPURLResponse)?.statusCode ?? 0)
                }
                tree = try JSONDecoder().decode(PhotoTree.self, from: data)
            } else {
                tree = try await api.fetchTree()
            }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// ── Main gallery view ─────────────────────────────────────────────────────────

struct GalleryView: View {
    @StateObject private var vm = GalleryViewModel()
    @EnvironmentObject var api: APIClient

    // Lightbox state
    @State private var lightboxPhotos: [PhotoRef] = []
    @State private var lightboxIndex: Int = 0
    @State private var showLightbox = false

    // Column count
    @Environment(\.horizontalSizeClass) private var hSizeClass
    private var columnCount: Int { hSizeClass == .regular ? 5 : 3 }

    var body: some View {
        NavigationStack {
            Group {
                if let tree = vm.tree {
                    galleryContent(tree: tree)
                } else if vm.isLoading {
                    ProgressView("Loading library…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let err = vm.error {
                    errorView(message: err)
                }
            }
            .navigationTitle("sCloud")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .navigationBarTrailing) {
                    if vm.isLoading {
                        ProgressView().scaleEffect(0.7)
                    }
                    Button {
                        Task { await vm.load(api: api, refresh: true) }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(vm.isLoading)

                    NavigationLink {
                        SettingsView()
                    } label: {
                        Image(systemName: "gear")
                    }
                }
            }
            .task { await vm.load(api: api) }
        }
        .fullScreenCover(isPresented: $showLightbox) {
            PhotoDetailView(photos: lightboxPhotos, startIndex: lightboxIndex)
                .environmentObject(api)
        }
    }

    // ── Gallery scroll content ────────────────────────────────────────────────

    private func galleryContent(tree: PhotoTree) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                ForEach(tree.timeline) { month in
                    Section {
                        ForEach(month.days) { day in
                            DaySectionView(
                                month: month.month,
                                monthName: month.monthName,
                                day: day,
                                columnCount: columnCount
                            ) { photos, index in
                                lightboxPhotos = photos
                                lightboxIndex  = index
                                showLightbox   = true
                            }
                        }
                    } header: {
                        MonthHeaderView(month: month)
                    }
                }
            }
        }
        .background(Color(uiColor: .systemBackground))
    }

    private func errorView(message: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 44))
                .foregroundStyle(.secondary)
            Text(message)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Button("Retry") {
                Task { await vm.load(api: api) }
            }
            .buttonStyle(.borderedProminent)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
