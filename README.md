# SteamTracker

A Windows desktop companion for monitoring Steam profiles and sending native notifications from the system tray.

## Current features

- Track multiple Steam profiles, including friends and public non-friend profiles.
- Add a target with a SteamID64, custom vanity URL, or Steam Community profile URL.
- Detect online/offline transitions, game start/end, and game changes through Steam Web API.
- Authenticate a Steam client session with a QR code and Steam Guard confirmation.
- Query Steam Rich Presence for ARC Raiders (App ID `1808500`) using `steam-user`, including profiles that are not on your friends list.
- Display the raw Rich Presence map and localized text so the ARC Raiders state parser can be validated against real data.
- Recognize initial text patterns for `In Speranza`, `In Queue`, and `In Round`; these labels are experimental until tested against real ARC Raiders sessions.
- Keep the app in the system tray and send Windows desktop notifications.
- Store the Steam Web API key and Rich Presence refresh token in the OS credential store.

## Security and privacy

SteamTracker never asks for or stores your Steam password. QR login is confirmed inside Steam Mobile. The Steam refresh token is stored using Windows Credential Manager. The local Rich Presence bridge binds only to loopback and requires a random per-run secret.

Target activity and history are not uploaded to a SteamTracker server. Basic Web API data remains subject to each target's Steam privacy settings. Rich Presence is requested through the authenticated local Steam client session.

## Windows installer

GitHub Actions builds a Windows NSIS installer and bundles the Node runtime and helper dependencies, so Node.js does not need to be installed separately.

Open the latest successful build in [GitHub Actions](https://github.com/SilverWallDiscs/SteamTracker/actions), then download the `SteamTracker-Windows-x64` artifact.

## Development

Prerequisites: Rust, Node.js (LTS), and the Tauri 2 Windows build prerequisites.

```bash
npm install
npm install --prefix rich-presence-helper
npm run tauri dev
```

See [docs/architecture.md](docs/architecture.md) for implementation boundaries and validation notes.
