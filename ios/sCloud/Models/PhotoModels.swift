import Foundation

// ── /api/tree response ────────────────────────────────────────────────────────

struct PhotoTree: Codable {
    let timeline: [MonthGroup]
    let collections: [CollectionGroup]
    let totalPhotos: Int
}

struct MonthGroup: Codable, Identifiable {
    let month: String       // "2026.05.x"
    let year: Int
    let monthNum: Int
    let monthName: String
    let days: [DayGroup]

    var id: String { month }
    var totalCount: Int { days.reduce(0) { $0 + $1.count } }
}

struct DayGroup: Codable, Identifiable {
    let day: String?        // "2026.05.04" or nil for flat months
    let count: Int

    var id: String { day ?? "flat" }

    /// Human-readable label: "4" from "2026.05.04"
    var shortLabel: String? {
        guard let day else { return nil }
        let parts = day.split(separator: ".")
        guard parts.count == 3, let d = Int(parts[2]) else { return day }
        return "\(d)"
    }
}

struct CollectionGroup: Codable, Identifiable {
    let name: String
    let groups: [CollectionSubgroup]
    var id: String { name }
}

struct CollectionSubgroup: Codable, Identifiable {
    let subfolder: String?
    let count: Int
    var id: String { subfolder ?? "root" }
}

// ── /api/folders/:month response ─────────────────────────────────────────────

struct MonthFolderResponse: Codable {
    let type: String
    let files: [String]?
    let items: [SubfolderInfo]?
}

struct SubfolderInfo: Codable, Identifiable {
    let name: String
    let count: Int
    var id: String { name }
}

// ── Flat photo reference used throughout the app ──────────────────────────────

struct PhotoRef: Identifiable, Hashable {
    let month: String
    let day: String?        // nil for flat months
    let filename: String

    var id: String { "\(month)/\(day ?? "_")/\(filename)" }

    func thumbURL(base: URL, width: Int = 400) -> URL {
        var components = URLComponents()
        if let day {
            components.path = "/api/thumb/\(month)/\(day)/\(filename)"
        } else {
            components.path = "/api/thumb/\(month)/\(filename)"
        }
        components.queryItems = [
            URLQueryItem(name: "w", value: "\(width)"),
            URLQueryItem(name: "q", value: "60"),
        ]
        return components.url(relativeTo: base)!.absoluteURL
    }

    func photoURL(base: URL) -> URL {
        if let day {
            return base.appendingPathComponent("/api/photo/\(month)/\(day)/\(filename)")
        } else {
            return base.appendingPathComponent("/api/photo/\(month)/\(filename)")
        }
    }
}
