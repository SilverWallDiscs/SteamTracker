# Architecture and validation notes

## Basic Steam presence

The Rust monitor uses Steam Web API methods to resolve profile vanity URLs and fetch player summaries. It polls tracked Steam IDs every 30 seconds and detects transitions for persona online/offline state and current game. The tracked target list is stored under the application's local data directory.

The Steam Web API key is stored using the OS credential store (Windows Credential Manager on Windows). A target can be a Steam friend or a public non-friend profile; basic monitoring is subject to that profile's privacy settings.

## Rich Presence for ARC Raiders

The frontend authenticates a separate local Steam client session using `steam-session` QR login. The user approves the login inside Steam Mobile with Steam Guard. The resulting refresh token is stored in the OS credential store; no Steam password is requested or persisted.

The helper uses `steam-user` and the Steam client protocol to request Rich Presence for ARC Raiders App ID `1808500`. Its `requestRichPresence(appID, steamIDs, callback)` method can query users who are not on the local friends list. Raw key/value data and the localized string are returned to the UI.

The initial UI classifier recognizes words resembling:

- `In Speranza`
- `In Queue`
- `In Round`

The classifier is deliberately heuristic. The exact ARC Raiders Rich Presence keys and values have not yet been verified against the user's live sessions. The raw response panel is included so the states can be confirmed and the parser refined from observed data rather than guesses.

## Local bridge and security

- Helper HTTP server binds only to `127.0.0.1`.
- Each app launch creates a cryptographically random bridge secret.
- Requests include that secret in a header and are rejected otherwise.
- Steam refresh tokens are stored using the operating system's credential store.
- Node runtime and dependencies are bundled with the Windows installer.
- The Rust process extracts the dependency archive into app-local data on first launch and starts the bundled Node executable.

## Windows lifecycle

The Tauri window hides when closed, leaving the monitor active in the system tray. Left-click the tray icon or choose Open from the menu to show the window; choose Quit to terminate the app.

## Validation checklist

1. Install the Windows build and add a Steam Web API key.
2. Add the Steam friend and the public trader by profile URL or SteamID64.
3. Connect the local Steam session with the QR code and approve it inside Steam Mobile.
4. Observe each profile while launching ARC Raiders and moving between Speranza, Queue, and a round.
5. Use “Ver datos Rich Presence recibidos” to inspect the exact keys and values returned by Steam.
6. Refine the classifier if the raw values differ from the initial text heuristics.
