use keyring::Entry;
use rand::{rngs::OsRng, RngCore};
use reqwest::Client;
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};
use tar::Archive;
use tauri::{AppHandle, Manager};

const KEYRING_SERVICE: &str = "com.silverwalldiscs.steamtracker";
const KEYRING_USER: &str = "steam-rich-presence-refresh-token";
const APP_ID: u32 = 1_808_500;

struct BridgeInner {
    base_url: Option<String>,
    secret: String,
    client: Client,
    _child: Mutex<Option<Child>>,
    init_error: Option<String>,
}

impl Drop for BridgeInner {
    fn drop(&mut self) {
        if let Ok(slot) = self._child.get_mut() {
            if let Some(child) = slot.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[derive(Clone)]
pub struct RichPresenceBridge {
    inner: Arc<BridgeInner>,
}

impl RichPresenceBridge {
    pub fn start(app: &AppHandle) -> Self {
        let mut random = [0_u8; 32];
        OsRng.fill_bytes(&mut random);
        let secret = random.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        let client = Client::builder()
            .timeout(Duration::from_secs(25))
            .build()
            .unwrap_or_else(|_| Client::new());

        let (base_url, child, init_error) = match spawn_helper(app, &secret) {
            Ok((port, child)) => (Some(format!("http://127.0.0.1:{port}")), Some(child), None),
            Err(error) => (None, None, Some(error)),
        };

        Self {
            inner: Arc::new(BridgeInner {
                base_url,
                secret,
                client,
                _child: Mutex::new(child),
                init_error,
            }),
        }
    }

    fn request(&self, path: &str) -> reqwest::RequestBuilder {
        let url = format!(
            "{}{}",
            self.inner.base_url.as_deref().unwrap_or("http://127.0.0.1:1"),
            path
        );
        self.inner.client.post(url)
            .header("x-steamtracker-secret", &self.inner.secret)
    }

    async fn read_status(&self) -> Result<Value, String> {
        let base = self.inner.base_url.as_deref()
            .ok_or_else(|| self.inner.init_error.clone().unwrap_or_else(|| "El puente Steam no está disponible.".into()))?;
        let response = self.inner.client
            .get(format!("{base}/status"))
            .header("x-steamtracker-secret", &self.inner.secret)
            .send().await
            .map_err(|error| format!("No se pudo consultar el puente Steam: {error}"))?
            .error_for_status()
            .map_err(|error| format!("El puente Steam respondió con error: {error}"))?;
        let mut value: Value = response.json().await
            .map_err(|error| format!("Respuesta inválida del puente Steam: {error}"))?;

        if let Some(token) = value.get("refreshToken").and_then(Value::as_str) {
            if !token.is_empty() {
                save_refresh_token(token)?;
            }
        }
        if let Some(object) = value.as_object_mut() {
            object.remove("refreshToken");
        }
        Ok(value)
    }

    pub async fn start_login(&self) -> Result<Value, String> {
        let base = self.inner.base_url.as_deref()
            .ok_or_else(|| self.inner.init_error.clone().unwrap_or_else(|| {
                "El puente Steam no está disponible.".to_string()
            }))?;
        let response = self.inner.client
            .post(format!("{base}/login/start"))
            .header("x-steamtracker-secret", &self.inner.secret)
            .json(&json!({}))
            .send().await
            .map_err(|error| format!("No se pudo iniciar el inicio de sesión Steam: {error}"))?
            .error_for_status()
            .map_err(|error| format!("Steam rechazó el inicio de sesión: {error}"))?;
        response.json().await.map_err(|error| format!("Respuesta QR inválida: {error}"))
    }

    pub async fn status(&self) -> Result<Value, String> {
        self.read_status().await
    }

    pub async fn restore_saved_session(&self) {
        let Ok(token) = read_refresh_token() else { return };
        if self.inner.base_url.is_none() { return; }

        let _ = self.request("/login/restore")
            .json(&json!({ "refreshToken": token }))
            .send().await;
    }

    pub async fn presence(&self, steam_ids: Vec<String>) -> Result<Value, String> {
        let ids: Vec<String> = steam_ids.into_iter()
            .filter(|id| id.len() == 17 && id.chars().all(|c| c.is_ascii_digit()))
            .take(50)
            .collect();
        if ids.is_empty() {
            return Ok(json!({ "appId": APP_ID, "users": {} }));
        }

        if self.inner.base_url.is_none() {
            return Err(self.inner.init_error.clone().unwrap_or_else(|| {
                "El runtime Rich Presence no está disponible. Reinstala SteamTracker.".into()
            }));
        }
        let response = self.request("/presence")
            .json(&json!({ "appId": APP_ID, "steamIds": ids }))
            .send().await
            .map_err(|error| format!("No se pudo consultar Rich Presence: {error}"))?
            .error_for_status()
            .map_err(|error| format!("Steam Rich Presence respondió con error: {error}"))?;
        response.json().await
            .map_err(|error| format!("Respuesta Rich Presence inválida: {error}"))
    }

    pub async fn logout(&self) -> Result<(), String> {
        if self.inner.base_url.is_some() {
            let _ = self.request("/logout").json(&json!({})).send().await;
        }
        delete_refresh_token()
    }
}

fn spawn_helper(app: &AppHandle, secret: &str) -> Result<(u16, Child), String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let source_script = manifest_dir.join("../rich-presence-helper/index.cjs");
    let source_node_modules = manifest_dir.join("../rich-presence-helper/node_modules");
    let resource_dir = app.path().resource_dir()
        .map_err(|error| format!("No se pudo resolver la carpeta de recursos: {error}"))?;
    let bundled_dir = resource_dir.join("rich-presence-helper");

    let bundled_node = bundled_dir.join("node.exe");
    let bundled_script = bundled_dir.join("index.cjs");
    let bundled_archive = bundled_dir.join("node_modules.tar");
    let has_node = bundled_node.is_file();
    let has_archive = bundled_archive.is_file();
    let has_script = bundled_script.is_file();

    let (node, script_path, runtime_dir) = if has_node && has_archive && has_script {
        let app_data = app.path().app_data_dir()
            .map_err(|error| format!("No se pudo resolver la carpeta de datos: {error}"))?;
        let runtime_dir = app_data.join("rich-presence-runtime");
        fs::create_dir_all(&runtime_dir)
            .map_err(|error| format!("No se pudo preparar el entorno Rich Presence: {error}"))?;

        let script_path = runtime_dir.join("index.cjs");
        fs::copy(&bundled_script, &script_path)
            .map_err(|error| format!("No se pudo copiar el puente Rich Presence: {error}"))?;

        let modules_dir = runtime_dir.join("node_modules");
        let ready_marker = runtime_dir.join(".dependencies-ready");
        let modules_complete = ready_marker.is_file()
            && modules_dir.join("steam-session/package.json").is_file()
            && modules_dir.join("steam-user/package.json").is_file();

        if !modules_complete {
            // Older builds could leave an empty or partially extracted node_modules folder.
            // Clean it before extracting so a stale directory is never mistaken for a valid install.
            if modules_dir.exists() {
                fs::remove_dir_all(&modules_dir)
                    .map_err(|error| format!("No se pudo limpiar una instalación Rich Presence incompleta: {error}"))?;
            }

            let archive_file = fs::File::open(&bundled_archive)
                .map_err(|error| format!("No se pudo abrir las dependencias Rich Presence: {error}"))?;
            let mut archive = Archive::new(archive_file);
            archive.unpack(&runtime_dir)
                .map_err(|error| format!("No se pudieron instalar las dependencias Rich Presence: {error}"))?;

            let steam_session_ready = modules_dir.join("steam-session/package.json").is_file();
            let steam_user_ready = modules_dir.join("steam-user/package.json").is_file();
            if !steam_session_ready || !steam_user_ready {
                return Err(format!(
                    "La extracción Rich Presence quedó incompleta (steam-session: {}, steam-user: {}). Reinstala SteamTracker.",
                    steam_session_ready, steam_user_ready
                ));
            }

            fs::write(&ready_marker, b"steam-session@1.9.4;steam-user@5.3.0")
                .map_err(|error| format!("No se pudo marcar la instalación Rich Presence como lista: {error}"))?;
        }

        (bundled_node, script_path, runtime_dir)
    } else if source_script.is_file() && source_node_modules.is_dir() {
        (PathBuf::from("node"), source_script, manifest_dir.join("../rich-presence-helper"))
    } else {
        return Err(format!(
            "No se encontró el runtime Rich Presence en {} (node.exe: {}, node_modules.tar: {}, index.cjs: {}). Reinstala SteamTracker.",
            bundled_dir.display(),
            has_node,
            has_archive,
            has_script
        ));
    };

    let mut child = Command::new(node)
        .arg(script_path)
        .current_dir(runtime_dir)
        .env("STEAMTRACKER_BRIDGE_SECRET", secret)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("No se pudo iniciar el puente Rich Presence: {error}"))?;

    let stdout = child.stdout.take()
        .ok_or_else(|| "No se pudo leer el inicio del puente Rich Presence.".to_string())?;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    reader.read_line(&mut line)
        .map_err(|error| format!("No se pudo iniciar el puente Rich Presence: {error}"))?;

    if line.trim().is_empty() {
        let mut child = child;
        let stderr = child.stderr.take().map(|mut pipe| {
            use std::io::Read;
            let mut message = String::new();
            let _ = pipe.read_to_string(&mut message);
            message
        }).unwrap_or_default();
        let _ = child.kill();
        let _ = child.wait();
        return Err(if stderr.trim().is_empty() {
            "El runtime Rich Presence terminó antes de iniciar el servidor local.".into()
        } else {
            format!("El runtime Rich Presence no pudo iniciar: {}", stderr.trim())
        });
    }

    let ready: Value = serde_json::from_str(&line)
        .map_err(|_| "El puente Rich Presence no devolvió una confirmación válida.".to_string())?;
    let port = ready.get("port").and_then(Value::as_u64)
        .filter(|port| *port > 0 && *port <= u16::MAX as u64)
        .ok_or_else(|| "El puente Rich Presence no informó un puerto válido.".to_string())? as u16;

    drop(reader);
    Ok((port, child))
}

fn token_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|error| format!("No se pudo abrir el almacén seguro de Steam: {error}"))
}

fn save_refresh_token(token: &str) -> Result<(), String> {
    token_entry()?.set_password(token)
        .map_err(|error| format!("No se pudo guardar la sesión Steam de forma segura: {error}"))
}

fn read_refresh_token() -> Result<String, String> {
    token_entry()?.get_password()
        .map_err(|_| "No hay una sesión Steam guardada.".into())
}

fn delete_refresh_token() -> Result<(), String> {
    match token_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("No se pudo borrar la sesión Steam: {error}")),
    }
}

#[tauri::command]
pub async fn rich_presence_start_login(
    bridge: tauri::State<'_, RichPresenceBridge>,
) -> Result<Value, String> {
    bridge.start_login().await
}

#[tauri::command]
pub async fn rich_presence_status(
    bridge: tauri::State<'_, RichPresenceBridge>,
) -> Result<Value, String> {
    bridge.status().await
}

#[tauri::command]
pub async fn rich_presence_query(
    steam_ids: Vec<String>,
    bridge: tauri::State<'_, RichPresenceBridge>,
) -> Result<Value, String> {
    let status = bridge.status().await?;
    if status.get("phase").and_then(Value::as_str) != Some("connected") {
        return Err("Conecta tu cuenta Steam para consultar Rich Presence.".into());
    }
    bridge.presence(steam_ids).await
}

#[tauri::command]
pub async fn rich_presence_logout(
    bridge: tauri::State<'_, RichPresenceBridge>,
) -> Result<(), String> {
    bridge.logout().await
}
