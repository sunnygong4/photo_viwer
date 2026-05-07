import Foundation

// ── API errors ────────────────────────────────────────────────────────────────

enum APIError: LocalizedError {
    case unauthorized
    case notFound
    case httpError(Int)
    case badURL
    case unknown

    var errorDescription: String? {
        switch self {
        case .unauthorized:     return "Invalid token — check Settings."
        case .notFound:         return "File not found on server."
        case .httpError(let c): return "Server returned HTTP \(c)."
        case .badURL:           return "Invalid server URL."
        case .unknown:          return "Unknown network error."
        }
    }
}

// ── API client ────────────────────────────────────────────────────────────────
// Uses the same X-sCloud-Token header that the desktop Electron app uses.
// No login form needed — just configure the server URL + token in Settings.

@MainActor
class APIClient: ObservableObject {
    @Published var baseURL: URL
    @Published var token: String

    // Shared singleton — inject as @EnvironmentObject from the App root.
    static let shared = APIClient()

    /// URLSession with a 50 MB disk cache so thumbnails survive between launches.
    private let session: URLSession = {
        let cache = URLCache(memoryCapacity: 20 * 1_024 * 1_024,
                            diskCapacity:   50 * 1_024 * 1_024)
        let config = URLSessionConfiguration.default
        config.urlCache = cache
        config.timeoutIntervalForRequest = 30
        return URLSession(configuration: config)
    }()

    init() {
        let savedURL   = UserDefaults.standard.string(forKey: "serverURL")
                         ?? "https://photos.sunnygong.com"
        let savedToken = UserDefaults.standard.string(forKey: "scloudToken")
                         ?? "scloud-desktop-v1-a9f3c2e8b7d4"
        baseURL = URL(string: savedURL) ?? URL(string: "https://photos.sunnygong.com")!
        token   = savedToken
    }

    /// Persist a new server URL + token (called from SettingsView).
    func save(urlString: String, newToken: String) throws {
        guard let url = URL(string: urlString), url.scheme != nil else { throw APIError.badURL }
        baseURL = url
        token   = newToken
        UserDefaults.standard.set(urlString, forKey: "serverURL")
        UserDefaults.standard.set(newToken,  forKey: "scloudToken")
    }

    // ── Requests ──────────────────────────────────────────────────────────────

    private func request(_ url: URL) -> URLRequest {
        var req = URLRequest(url: url)
        req.setValue(token, forHTTPHeaderField: "X-sCloud-Token")
        return req
    }

    private func get(_ path: String) throws -> URLRequest {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw APIError.badURL
        }
        return request(url)
    }

    private func checkResponse(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { throw APIError.unknown }
        switch http.statusCode {
        case 200...299: return
        case 401, 403:  throw APIError.unauthorized
        case 404:       throw APIError.notFound
        default:        throw APIError.httpError(http.statusCode)
        }
    }

    // ── Public endpoints ──────────────────────────────────────────────────────

    func fetchTree() async throws -> PhotoTree {
        let (data, res) = try await session.data(for: get("/api/tree"))
        try checkResponse(res)
        return try JSONDecoder().decode(PhotoTree.self, from: data)
    }

    /// Load filenames for a given day folder (or flat month if day is nil).
    func fetchPhotos(month: String, day: String?) async throws -> [String] {
        if let day {
            let (data, res) = try await session.data(for: get("/api/folders/\(month)/\(day)"))
            try checkResponse(res)
            return try JSONDecoder().decode([String].self, from: data)
        } else {
            let (data, res) = try await session.data(for: get("/api/folders/\(month)"))
            try checkResponse(res)
            let folder = try JSONDecoder().decode(MonthFolderResponse.self, from: data)
            return folder.files ?? []
        }
    }

    /// Quick connectivity + auth check — called by SettingsView.
    func testConnection() async throws {
        let _ = try await fetchTree()
    }
}
