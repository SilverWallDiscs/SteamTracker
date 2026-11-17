# Architecture and monitoring model

## Target types

SteamTracker supports multiple independent targets. The target type controls which data sources are expected, not whether the profile can be added.

- **Steam friend**: basic Web API monitoring plus an attempt to read friend Rich Presence through a dedicated Steam integration when available.
- **Public profile / non-friend**: basic Web API monitoring only. Rich Presence may be unavailable; Steamworks documents a limited request path for users in the same lobby or game server, so the app must not assume arbitrary non-friends can be queried.

The trader profile described for the first use case belongs in the second category. It should still be possible to follow its public online/game activity without adding it as a friend.

## Data sources

### Basic presence

Use Steam Web API ISteamUser/GetPlayerSummaries to read the public persona state and current game information. Resolve vanity profile URLs with ISteamUser/ResolveVanityURL where needed.

This data is subject to profile and game-details privacy. A missing game field must not be interpreted as proof that the person is offline.

### Rich Presence (experimental)

Steamworks ISteamFriends exposes Rich Presence key/value methods, including GetFriendRichPresence, GetFriendRichPresenceKeyCount, GetFriendRichPresenceKeyByIndex, and RequestFriendRichPresence.

The implementation must be isolated behind a provider interface. Do not assume that a regular Web API key is sufficient to retrieve these values, and do not require Steam account passwords or automate a user's login.

For ARC Raiders, first capture the actual keys and values that Steam exposes for a real friend session. Only then add a parser that classifies observed values into user-facing states such as:

- In Speranza
- In Queue
- In Round

Do not hard-code guesses about the game's internal keys or values. Preserve unknown values for diagnostics, with sensitive data kept local.

## Event model

Normalize observations into transitions:

- WentOnline
- WentOffline
- GameStarted
- GameEnded
- GameChanged
- RichPresenceChanged

Emit a notification only when a meaningful transition occurs. Polling the same state repeatedly must not generate duplicate notifications. Support per-target and per-event notification preferences.

## Windows experience

- Main window can be hidden while monitoring continues.
- System tray menu provides Open and Quit.
- Native Windows notifications are used for enabled events.
- Closing the window should eventually hide it to the tray rather than stop monitoring (to be implemented).

## Local storage and secrets

- Store tracked Steam IDs, display preferences, polling settings, and event history locally.
- Store the Steam Web API key using Windows Credential Manager, not in source control or plain-text logs.
- Never request or store Steam account passwords.
- Do not upload target activity or history to a remote service.

## Initial implementation order

1. Establish the Tauri desktop shell and tray.
2. Implement target/profile resolution and basic Web API polling.
3. Add local event transition detection and notification preferences.
4. Prototype the Rich Presence provider with a real Steam friend session.
5. Verify ARC Raiders' raw presence values before enabling the three game-specific notifications.
6. Add SQLite history, settings, startup-on-login, and packaging.