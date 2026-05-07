import SwiftUI

/// A single thumbnail cell. Uses AsyncImage backed by URLSession's URLCache
/// (50 MB disk cache configured in APIClient).
struct ThumbnailView: View {
    let photo: PhotoRef
    @EnvironmentObject var api: APIClient

    var body: some View {
        GeometryReader { geo in
            let size = geo.size.width
            let url  = photo.thumbURL(base: api.baseURL, width: Int(size * UIScreen.main.scale))

            AsyncImage(url: url, transaction: Transaction(animation: .easeIn(duration: 0.15))) { phase in
                switch phase {
                case .empty:
                    Color(uiColor: .systemGray5)
                case .success(let image):
                    image
                        .resizable()
                        .scaledToFill()
                        .frame(width: size, height: size)
                        .clipped()
                case .failure:
                    Color(uiColor: .systemGray4)
                        .overlay {
                            Image(systemName: "photo")
                                .foregroundStyle(.secondary)
                        }
                @unknown default:
                    Color(uiColor: .systemGray5)
                }
            }
            .frame(width: size, height: size)
        }
        .aspectRatio(1, contentMode: .fill)
    }
}
