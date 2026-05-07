import SwiftUI

/// Full-screen photo viewer: horizontal swipe between photos, pinch to zoom,
/// double-tap to zoom, share sheet, and a close button.
struct PhotoDetailView: View {
    let photos: [PhotoRef]
    let startIndex: Int

    @EnvironmentObject var api: APIClient
    @Environment(\.dismiss) private var dismiss

    @State private var currentIndex: Int
    @State private var showChrome = true   // nav bar / close button visibility

    init(photos: [PhotoRef], startIndex: Int) {
        self.photos = photos
        self.startIndex = startIndex
        _currentIndex = State(initialValue: startIndex)
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.black.ignoresSafeArea()

            // Paging swipe
            TabView(selection: $currentIndex) {
                ForEach(Array(photos.enumerated()), id: \.offset) { idx, photo in
                    PhotoPageView(photo: photo)
                        .environmentObject(api)
                        .tag(idx)
                        .onTapGesture {
                            withAnimation(.easeInOut(duration: 0.18)) {
                                showChrome.toggle()
                            }
                        }
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .ignoresSafeArea()

            // Chrome overlay
            if showChrome {
                VStack {
                    HStack {
                        Button { dismiss() } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 18, weight: .semibold))
                                .foregroundStyle(.white)
                                .padding(10)
                                .background(.ultraThinMaterial.opacity(0.8))
                                .clipShape(Circle())
                        }
                        .padding(.leading, 16)

                        Spacer()

                        // Counter
                        Text("\(currentIndex + 1) / \(photos.count)")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(.ultraThinMaterial.opacity(0.8))
                            .clipShape(Capsule())

                        Spacer()

                        ShareButton(photo: photos[currentIndex])
                            .environmentObject(api)
                            .padding(.trailing, 16)
                    }
                    .padding(.top, 12)

                    Spacer()

                    // Filename label
                    Text(photos[currentIndex].filename)
                        .font(.system(size: 12))
                        .foregroundStyle(.white.opacity(0.7))
                        .padding(.bottom, 20)
                }
                .transition(.opacity)
            }
        }
        .preferredColorScheme(.dark)
        .statusBarHidden(!showChrome)
    }
}

// ── One page: loads the full-res image, shows a thumb placeholder while loading ─

private struct PhotoPageView: View {
    let photo: PhotoRef
    @EnvironmentObject var api: APIClient
    @State private var fullImage: UIImage?
    @State private var isLoading = true

    var body: some View {
        GeometryReader { geo in
            ZStack {
                Color.black

                // Placeholder thumb while full-res loads
                if fullImage == nil {
                    AsyncImage(url: photo.thumbURL(base: api.baseURL, width: 800)) { phase in
                        if case .success(let img) = phase {
                            img.resizable().scaledToFit()
                        }
                    }
                    .opacity(0.5)
                }

                if let img = fullImage {
                    ZoomableImageView(image: img)
                        .frame(width: geo.size.width, height: geo.size.height)
                }

                if isLoading {
                    ProgressView()
                        .tint(.white)
                }
            }
        }
        .task {
            await loadFullRes()
        }
    }

    private func loadFullRes() async {
        let url = photo.photoURL(base: api.baseURL)
        var req = URLRequest(url: url)
        req.setValue(api.token, forHTTPHeaderField: "X-sCloud-Token")
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            if let img = UIImage(data: data) {
                fullImage = img
            }
        } catch { }
        isLoading = false
    }
}

// ── Share button ──────────────────────────────────────────────────────────────

private struct ShareButton: View {
    let photo: PhotoRef
    @EnvironmentObject var api: APIClient
    @State private var imageToShare: UIImage?
    @State private var showShare = false
    @State private var isLoading = false

    var body: some View {
        Button {
            Task { await fetchAndShare() }
        } label: {
            if isLoading {
                ProgressView().tint(.white)
                    .frame(width: 20, height: 20)
            } else {
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(10)
                    .background(.ultraThinMaterial.opacity(0.8))
                    .clipShape(Circle())
            }
        }
        .sheet(isPresented: $showShare) {
            if let img = imageToShare {
                ShareSheet(items: [img])
            }
        }
    }

    private func fetchAndShare() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        let url = photo.photoURL(base: api.baseURL)
        var req = URLRequest(url: url)
        req.setValue(api.token, forHTTPHeaderField: "X-sCloud-Token")
        if let (data, _) = try? await URLSession.shared.data(for: req),
           let img = UIImage(data: data) {
            imageToShare = img
            showShare = true
        }
    }
}

// ── UIActivityViewController wrapper ─────────────────────────────────────────

struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}
