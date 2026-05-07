# sCloud iOS

Native SwiftUI photo viewer for iPhone/iPad. Connects to the same
`photos.sunnygong.com` server as the web + Electron apps.

## Requirements

- macOS 14+ with Xcode 15+
- iOS 16+ deployment target
- An sCloud server running with `DESKTOP_TOKEN` set

## Setup in Xcode

1. Open Xcode → **File → New → Project → App**
2. Set:
   - Product Name: `sCloud`
   - Bundle ID: `com.sunnygong.scloud`
   - Interface: SwiftUI
   - Language: Swift
   - Deployment target: iOS 16.0
3. Delete the generated `ContentView.swift`
4. In the project navigator, **drag all `.swift` files** from `sCloud/` into Xcode:
   ```
   App/        sCloudApp.swift, ContentView.swift
   Models/     PhotoModels.swift
   Networking/ APIClient.swift
   Views/      Gallery/*, Detail/*, Settings/*
   ```
5. Replace the generated `Info.plist` content with the one in `sCloud/Info.plist`

## Auth

The app uses the `X-sCloud-Token` header (same as the Electron desktop app),
not the login form. The default token is `scloud-desktop-v1-a9f3c2e8b7d4`.

If your server has `DESKTOP_TOKEN` overridden in `.env`, update it in Settings.

## Run on a real device

To install on your iPhone without a paid Apple Developer account:
- Free provisioning: connect iPhone, pick your personal team in
  Xcode → Signing & Capabilities. Valid for 7 days, re-sign to refresh.
- Paid ($99/yr): sign normally, install via TestFlight or direct install.

## Features (v1)

- Timeline gallery — months → days → thumbnails
- Lazy loading per day section (mirrors the web app)
- Pinch-to-zoom + double-tap in full-screen viewer
- Horizontal swipe between photos
- Share sheet (saves full-res to Photos, AirDrop, etc.)
- Settings screen to configure server URL + token
- Manual rescan (↻ button) to bust the 1h server cache
- 50 MB disk thumbnail cache (survives app restarts)
- 3 columns on iPhone, 5 on iPad

## Planned (v2)

- Favourites / local bookmark list
- EXIF info panel (tap info button in detail view)
- Offline mode — mark albums for local sync
- Collections tab (non-date folders)
