use keyring::Entry;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

const KEYRING_SERVICE: &str = "com.silverwalldiscs.steamtracker";
const KEYRING_USER: &str = "steam-web-api-key";
const POLL_INTERVAL: Duration = Duration::from_secs(30);
const PLAYER_SUMMARIES_URL: &str =
    "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/";
const RESOLVE_VANITY_URL: &str =
    "https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedTarget {
    pub steam_id: String,
    pub display_name: String,
    pub profile_url: String,
    pub target_type: String,
    pub added_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSnapshot {
    pub steam_id: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub persona_state: u8,
    pub persona_label: String,
    pub is_online: bool,
    pub game_id: Option<String>,
    pub game_name: Option<String>,
    pub observed_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SteamEvent {
    steam_id: String,
    title: String,
    message: String,
    event_type: String,
}

#[derive(Default)]
pub struct MonitorState {
    snapshots: Mutex<HashMap<String, PlayerSnapshot>>,
}

#[derive(Deserialize)]
struct SummariesEnvelope {
    response: SummariesResponse,
}

#[derive(Default, Deserialize)]
struct SummariesResponse {
    #[serde(default)]
    players: Vec<PlayerSummaryRaw>,
}

#[derive(Clone, Deserialize)]
struct PlayerSummaryRaw {
    steamid: String,
    #[serde(default)]
    personaname: String,
    #[serde(default)]
    profileurl: String,
    avatarfull: Option<String>,
    #[serde(default)]
    personastate: u8,
    gameid: Option<String>,
    gameextrainfo: Option<String>,
}

#[derive(Deserialize)]
struct ResolveEnvelope {
    response: ResolveResponse,
}

#[derive(Deserialize)]
struct ResolveResponse {
    success: u8,
    steamid: Option<String>,
    message: Option<String>,
}

fn api_key_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|error| format!("No se pudo abrir Windows Credential Manager: {error}"))
}

fn read_api_key() -> Result<String, String> {
    api_key_entry()?
        .get_password()
        .map_err(|_| "Primero configura tu Steam Web API Key.".to_string())
}

#[tauri::command]
pub fn save_api_key(api_key: String) -> Result<(), String> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return Err("La API Key no puede estar vacía.".into());
    }

    api_key_entry()?
        .set_password(trimmed)
        .map_err(|error| format!("No se pudo guardar la API Key: {error}"))
}

#[tauri::command]
pub fn has_api_key() -> bool {
    read_api_key().is_ok()
}

fn targets_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("No se pudo resolver la carpeta de datos: {error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("No se pudo crear la carpeta de datos: {error}"))?;
    Ok(directory.join("targets.json"))
}

fn load_targets(app: &AppHandle) -> Result<Vec<TrackedTarget>, String> {
    let path = targets_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(path)
        .map_err(|error| format!("No se pudo leer la lista de perfiles: {error}"))?;
    serde_json::from_str(&content)
        .map_err(|error| format!("La lista local de perfiles no es válida: {error}"))
}

fn save_targets(app: &AppHandle, targets: &[TrackedTarget]) -> Result<(), String> {
    let path = targets_path(app)?;
    let content = serde_json::to_string_pretty(targets)
        .map_err(|error| format!("No se pudo serializar la lista de perfiles: {error}"))?;
    fs::write(path, content)
        .map_err(|error| format!("No se pudo guardar la lista de perfiles: {error}"))
}

#[tauri::command]
pub fn get_targets(app: AppHandle) -> Result<Vec<TrackedTarget>, String> {
    load_targets(&app)
}

#[tauri::command]
pub fn get_snapshots(state: State<'_, MonitorState>) -> Result<Vec<PlayerSnapshot>, String> {
    let snapshots = state
        .snapshots
        .lock()
        .map_err(|_| "No se pudo consultar el estado del monitor.".to_string())?;
    Ok(snapshots.values().cloned().collect())
}

fn extract_profile_identifier(input: &str) -> Result<ProfileIdentifier, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("Introduce un Steam ID o una URL de perfil.".into());
    }
    let input = input.split('?').next().unwrap_or(input);
    let input = input.split('#').next().unwrap_or(input);
    let input = input.trim_end_matches('/');

    if input.chars().all(|character| character.is_ascii_digit()) && input.len() == 17 {
        return Ok(ProfileIdentifier::SteamId(input.to_string()));
    }

    let parts: Vec<&str> = input
        .trim_end_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();

    if let Some(index) = parts.iter().position(|part| *part == "profiles") {
        if let Some(id) = parts.get(index + 1) {
            if id.len() == 17 && id.chars().all(|character| character.is_ascii_digit()) {
                return Ok(ProfileIdentifier::SteamId((*id).to_string()));
            }
            return Err("La URL /profiles/ no contiene un Steam ID64 válido.".into());
        }
    }

    if let Some(index) = parts.iter().position(|part| *part == "id") {
        if let Some(vanity) = parts.get(index + 1) {
            return Ok(ProfileIdentifier::Vanity((*vanity).to_string()));
        }
    }

    if input.contains("://") || input.contains("steamcommunity.com") {
        return Err("La URL no parece ser un perfil válido de Steam.".into());
    }

    Ok(ProfileIdentifier::Vanity(input.to_string()))
}

enum ProfileIdentifier {
    SteamId(String),
    Vanity(String),
}

async fn resolve_steam_id(
    client: &Client,
    api_key: &str,
    input: &str,
) -> Result<String, String> {
    match extract_profile_identifier(input)? {
        ProfileIdentifier::SteamId(id) => Ok(id),
        ProfileIdentifier::Vanity(vanity) => {
            let response = client
                .get(RESOLVE_VANITY_URL)
                .query(&[("key", api_key), ("vanityurl", vanity.as_str())])
                .send()
                .await
                .map_err(|_| "No se pudo conectar con Steam.".to_string())?;
            let status = response.status();
            if !status.is_success() {
                return Err(format!("Steam respondió con HTTP {status}."));
            }
            let response = response
                .json::<ResolveEnvelope>()
                .await
                .map_err(|_| "Steam devolvió una respuesta inválida.".to_string())?;

            if response.response.success != 1 {
                return Err(response
                    .response
                    .message
                    .unwrap_or_else(|| "Steam no pudo encontrar ese perfil.".into()));
            }

            response
                .response
                .steamid
                .ok_or_else(|| "Steam no devolvió el Steam ID64.".into())
        }
    }
}

async fn fetch_summaries(
    client: &Client,
    api_key: &str,
    steam_ids: &[String],
) -> Result<Vec<PlayerSummaryRaw>, String> {
    if steam_ids.is_empty() {
        return Ok(Vec::new());
    }

    let joined_ids = steam_ids.join(",");
    let response = client
        .get(PLAYER_SUMMARIES_URL)
        .query(&[("key", api_key), ("steamids", joined_ids.as_str())])
        .send()
        .await
        .map_err(|_| "No se pudo conectar con Steam.".to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Steam respondió con HTTP {status}."));
    }
    let response = response
        .json::<SummariesEnvelope>()
        .await
        .map_err(|_| "Steam devolvió una respuesta inválida.".to_string())?;

    Ok(response.response.players)
}

#[tauri::command]
pub async fn add_target(
    app: AppHandle,
    profile: String,
    target_type: String,
    alias: Option<String>,
) -> Result<TrackedTarget, String> {
    if target_type != "friend" && target_type != "public" {
        return Err("El tipo de perfil no es válido.".into());
    }

    let api_key = read_api_key()?;
    let client = Client::builder()
        .user_agent("SteamTracker/0.1.0")
        .build()
        .map_err(|error| format!("No se pudo iniciar el cliente HTTP: {error}"))?;

    let steam_id = resolve_steam_id(&client, &api_key, &profile).await?;
    let existing = load_targets(&app)?;
    if let Some(target) = existing.iter().find(|target| target.steam_id == steam_id) {
        return Ok(target.clone());
    }

    let summary = fetch_summaries(&client, &api_key, std::slice::from_ref(&steam_id))
        .await?
        .into_iter()
        .next();

    let display_name = alias
        .filter(|value| !value.trim().is_empty())
        .or_else(|| summary.as_ref().map(|player| player.personaname.clone()))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("Steam user {}", &steam_id[steam_id.len().saturating_sub(5)..]));

    let target = TrackedTarget {
        steam_id: steam_id.clone(),
        display_name,
        profile_url: format!("https://steamcommunity.com/profiles/{steam_id}/"),
        target_type,
        added_at: now_unix(),
    };

    let mut targets = existing;
    targets.push(target.clone());
    save_targets(&app, &targets)?;
    Ok(target)
}

#[tauri::command]
pub fn remove_target(app: AppHandle, steam_id: String) -> Result<(), String> {
    let mut targets = load_targets(&app)?;
    targets.retain(|target| target.steam_id != steam_id);
    save_targets(&app, &targets)?;

    if let Some(state) = app.try_state::<MonitorState>() {
        if let Ok(mut snapshots) = state.snapshots.lock() {
            snapshots.remove(&steam_id);
        }
    }

    Ok(())
}

pub async fn monitor_loop(app: AppHandle) {
    let client = Client::builder()
        .user_agent("SteamTracker/0.1.0")
        .build()
        .unwrap_or_else(|_| Client::new());

    loop {
        let _ = monitor_once(&app, &client).await;
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

async fn monitor_once(app: &AppHandle, client: &Client) -> Result<(), String> {
    let api_key = match read_api_key() {
        Ok(key) => key,
        Err(_) => return Ok(()),
    };
    let targets = load_targets(app)?;
    if targets.is_empty() {
        return Ok(());
    }

    let ids: Vec<String> = targets.iter().map(|target| target.steam_id.clone()).collect();
    let summaries = fetch_summaries(client, &api_key, &ids).await?;
    let target_names: HashMap<String, String> = targets
        .iter()
        .map(|target| (target.steam_id.clone(), target.display_name.clone()))
        .collect();

    let state = app.state::<MonitorState>();
    let mut snapshots = state
        .snapshots
        .lock()
        .map_err(|_| "No se pudo actualizar el estado del monitor.".to_string())?;

    for raw in summaries {
        let steam_id = raw.steamid.clone();
        let custom_name = target_names.get(&steam_id).cloned();
        let current = PlayerSnapshot {
            steam_id: steam_id.clone(),
            display_name: custom_name.unwrap_or_else(|| raw.personaname.clone()),
            avatar_url: raw.avatarfull.clone(),
            persona_state: raw.personastate,
            persona_label: persona_label(raw.personastate).to_string(),
            is_online: raw.personastate != 0,
            game_id: raw.gameid.clone(),
            game_name: raw.gameextrainfo.clone(),
            observed_at: now_unix(),
        };

        if let Some(previous) = snapshots.get(&steam_id) {
            let display_name = current.display_name.clone();
            let mut events = Vec::new();

            if previous.is_online != current.is_online {
                let (title, message, event_type) = if current.is_online {
                    ("Steam: conectado", format!("{display_name} está conectado."), "went_online")
                } else {
                    ("Steam: desconectado", format!("{display_name} se desconectó."), "went_offline")
                };
                events.push(make_event(&steam_id, title, message, event_type));
            }

            match (&previous.game_name, &current.game_name) {
                (None, Some(game)) => events.push(make_event(
                    &steam_id,
                    "Juego iniciado",
                    format!("{display_name} empezó a jugar {game}."),
                    "game_started",
                )),
                (Some(game), None) => events.push(make_event(
                    &steam_id,
                    "Juego terminado",
                    format!("{display_name} dejó de jugar {game}."),
                    "game_ended",
                )),
                (Some(old_game), Some(new_game)) if old_game != new_game => {
                    events.push(make_event(
                        &steam_id,
                        "Cambio de juego",
                        format!("{display_name} cambió de {old_game} a {new_game}."),
                        "game_changed",
                    ));
                }
                _ => {}
            }

            for event in events {
                let _ = app.emit("steamtracker:event", event);
            }
        }

        snapshots.insert(steam_id, current);
    }

    Ok(())
}

fn make_event(steam_id: &str, title: &str, message: String, event_type: &str) -> SteamEvent {
    SteamEvent {
        steam_id: steam_id.to_string(),
        title: title.to_string(),
        message,
        event_type: event_type.to_string(),
    }
}

fn persona_label(state: u8) -> &'static str {
    match state {
        0 => "Offline",
        1 => "Online",
        2 => "Ocupado",
        3 => "Ausente",
        4 => "Durmiendo",
        5 => "Busca intercambiar",
        6 => "Busca jugar",
        _ => "Desconocido",
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_steam_id64() {
        let parsed = extract_profile_identifier("76561198000000000").unwrap();
        match parsed {
            ProfileIdentifier::SteamId(value) => assert_eq!(value, "76561198000000000"),
            ProfileIdentifier::Vanity(_) => panic!("Expected a Steam ID64"),
        }
    }

    #[test]
    fn extracts_a_vanity_name_from_profile_url() {
        let parsed = extract_profile_identifier(
            "https://steamcommunity.com/id/example-trader/"
        ).unwrap();
        match parsed {
            ProfileIdentifier::Vanity(value) => assert_eq!(value, "example-trader"),
            ProfileIdentifier::SteamId(_) => panic!("Expected a vanity name"),
        }
    }

    #[test]
    fn extracts_a_steam_id_from_profile_url_with_query() {
        let parsed = extract_profile_identifier(
            "https://steamcommunity.com/profiles/76561198000000000/?some=thing"
        ).unwrap();
        match parsed {
            ProfileIdentifier::SteamId(value) => assert_eq!(value, "76561198000000000"),
            ProfileIdentifier::Vanity(_) => panic!("Expected a Steam ID64"),
        }
    }

    #[test]
    fn maps_persona_states_to_labels() {
        assert_eq!(persona_label(0), "Offline");
        assert_eq!(persona_label(1), "Online");
        assert_eq!(persona_label(2), "Ocupado");
    }
}
