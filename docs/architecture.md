# Architecture and monitoring model

## Target types

SteamTracker supports multiple independent targets. The target type controls which data sources are expected, not whether the profile can be added.

- **Steam friend**: basic Web API monitoring plus an attempt to read friend Rich Presence through a dedicated Steam integration when available.
- **Public profile / non-friend**: basic Web API monitoring only. Rich Presence may be unavailable; Steamworks documents a limited request path for users in the same lobby or game server, so the app must not assume arbitrary non-friends can be queried.

The first-use setup can contain both a Steam friend and a public trader profile. The trader can be followed without adding them as a Steam friend.

## Implemented in the early MVP

- Tauri 2 desktop shell with a Windows system-tray menu.
- Closing the main window hides it instead of exiting the background process.
- Steam Web API key is stored via the OS credential store (Windows Credential Manager on Windows).
- Add profiles by Steam ID64, custom vanity name, or Steam Community profile URL.
- Store the tracked profile list locally in the app data directory.
- Poll GetPlayerSummaries every 30 seconds and detect online/offline changes, game start/end, and game switches.
- Send native notifications for detected transitions and keep a short in-window event list.

## Data sources and privacy

### Basic presence

Use Steam Web API ISteamUser/GetPlayerSummaries to read public persona state and current game information. Resolve vanity profile URLs with ISteamUser/ResolveVanityURL where needed.

This data is subject to Steam profile and game-details privacy. A missing player or game field must not be interpreted as proof that the person is offline or not playing.

### Rich Presence (experimental, not implemented yet)

Steamworks ISteamFriends exposes Rich Presence key/value methods, including GetFriendRichPresence, GetFriendRichPresenceKeyCount, GetFriendRichPresenceKeyByIndex, and RequestFriendRichPresence.

The public Web API path implemented in the MVP does not return the full Rich Presence key/value data. Any Steamworks-based provider must be tested with a real Steam client session and must not require Steam account passwords or automate a user's login.

For ARC Raiders, first capture the actual keys and values that Steam exposes for a real friend session. Only then add a parser that classifies observed values into user-facing states such as:

- In Speranza
- In Queue
- In Round

Do not hard-code guesses about the game's internal keys or values. Preserve unknown values for diagnostics, with sensitive data kept local.

## Event model

Current transitions:

- WentOnline
- WentOffline
- GameStarted
- GameEnded
- GameChanged

Planned transition:

- RichPresenceChanged

Emit a notification only when a meaningful transition occurs. The first successful poll is used as a baseline and does not generate a burst of notifications.

## Remaining work

1. Run the Windows CI build and fix any compiler issues it reveals.
2. Test the Web API flow with a real friend profile and a public non-friend trader profile.
3. Investigate a safe Steamworks Rich Presence provider and verify ARC Raiders' raw values.
4. Add per-profile notification preferences, configurable polling, and notification permission settings.
5. Add SQLite event history, startup-on-login, installer packaging, and polished tray interactions.