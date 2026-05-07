import SwiftUI

/// Lazily loads the photo filenames for one day (or flat month) and renders a grid.
struct DaySectionView: View {
    let month: String
    let monthName: String
    let day: DayGroup
    let columnCount: Int
    let onTap: ([PhotoRef], Int) -> Void

    @EnvironmentObject var api: APIClient
    @State private var filenames: [String] = []
    @State private var loaded = false

    private var columns: [GridItem] {
        Array(repeating: GridItem(.flexible(), spacing: 2), count: columnCount)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Day label
            if let label = day.shortLabel {
                HStack(spacing: 4) {
                    Text("\(monthName) \(label)")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                    Text("· \(day.count)")
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 12)
                .padding(.top, 10)
                .padding(.bottom, 4)
            }

            // Photo grid
            LazyVGrid(columns: columns, spacing: 2) {
                ForEach(Array(filenames.enumerated()), id: \.offset) { idx, filename in
                    let photo = PhotoRef(month: month, day: day.day, filename: filename)
                    ThumbnailView(photo: photo)
                        .onTapGesture {
                            let allPhotos = filenames.map { PhotoRef(month: month, day: day.day, filename: $0) }
                            onTap(allPhotos, idx)
                        }
                }

                // Placeholder cells while loading (reserve space, avoid layout jump)
                if !loaded {
                    ForEach(0..<day.count, id: \.self) { _ in
                        Color(uiColor: .systemGray5)
                            .aspectRatio(1, contentMode: .fill)
                    }
                }
            }
            .padding(.horizontal, 2)
        }
        .task(id: "\(month)/\(day.id)") {
            guard !loaded else { return }
            do {
                filenames = try await api.fetchPhotos(month: month, day: day.day)
                loaded = true
            } catch {
                // Silently fail — placeholders remain
            }
        }
    }
}
