# SteamTracker

A lightweight Windows desktop companion that tracks Steam presence and sends native desktop notifications from the system tray.

## Goals

- Track multiple Steam profiles, including friends and public profiles that are not on the local friends list.
- Detect online/offline changes and game start, game end, and game switches.
- Offer an experimental Rich Presence path for friends, with ARC Raiders state parsing kept separate from the generic Steam monitor.
- Run quietly from the Windows system tray and notify only about events the user enables.
- Keep credentials and local tracking history on the user's machine.

## Important Steam limitation

The public Steam Web API can provide basic profile and game activity when the target's privacy settings allow it. It does **not** expose the full friend Rich Presence key/value data needed to reliably identify details such as `Speranza`, `In Queue`, or `In Round`.

Steamworks exposes `ISteamFriends::GetFriendRichPresence` for Rich Presence data and `RequestFriendRichPresence` for requesting it. Access to a non-friend is conditional (for example, when both users are in the same lobby or game server). SteamTracker will treat this as an experimental integration and will not claim ARC Raiders states are supported until the raw values have been verified against a real session.

## Project status

Early MVP. The app shell, system tray, secure API-key storage, profile management, Steam Web API polling, state transitions, and notification event pipeline are in place. The Windows CI workflow is included; the Rich Presence bridge and ARC Raiders-specific state parsing remain experimental work.

## Planned stack

- Rust for monitoring and state transitions.
- Tauri 2 for the Windows desktop shell and system tray.
- React + TypeScript for the interface.
- SQLite for local event history and settings metadata.
- Windows Credential Manager for the Steam Web API key.

## Development

Prerequisites: Rust, Node.js (LTS), and the Tauri 2 Windows build prerequisites.

```bash
npm install
npm run tauri dev
```

See [`docs/architecture.md`](docs/architecture.md) for the monitoring model and implementation boundaries.