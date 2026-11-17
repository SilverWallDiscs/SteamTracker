import { useEffect, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

type TargetType = "friend" | "public";
type TrackedTarget = {
  steamId: string;
  displayName: string;
  profileUrl: string;
  targetType: TargetType;
  addedAt: number;
};
type PlayerSnapshot = {
  steamId: string;
  displayName: string;
  avatarUrl?: string;
  personaState: number;
  personaLabel: string;
  isOnline: boolean;
  gameId?: string;
  gameName?: string;
  observedAt: number;
};
type SteamEvent = {
  steamId: string;
  title: string;
  message: string;
  eventType: string;
};

function App() {
  const [apiKeyExists, setApiKeyExists] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [targets, setTargets] = useState<TrackedTarget[]>([]);
  const [snapshots, setSnapshots] = useState<PlayerSnapshot[]>([]);
  const [profileInput, setProfileInput] = useState("");
  const [alias, setAlias] = useState("");
  const [targetType, setTargetType] = useState<TargetType>("friend");
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState(false);
  const [addingTarget, setAddingTarget] = useState(false);
  const [error, setError] = useState("");
  const [recentEvents, setRecentEvents] = useState<SteamEvent[]>([]);

  async function reloadData() {
    try {
      const [hasKey, savedTargets, currentSnapshots] = await Promise.all([
        invoke<boolean>("has_api_key"),
        invoke<TrackedTarget[]>("get_targets"),
        invoke<PlayerSnapshot[]>("get_snapshots"),
      ]);
      setApiKeyExists(hasKey);
      setTargets(savedTargets);
      setSnapshots(currentSnapshots);
    } catch (cause) {
      setError("No se pudo conectar con el monitor: " + String(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;
    void reloadData();

    listen<SteamEvent>("steamtracker:event", ({ payload }) => {
      setRecentEvents((current) => [payload, ...current].slice(0, 5));
      void reloadData();
      void (async () => {
        try {
          let permitted = await isPermissionGranted();
          if (!permitted) permitted = (await requestPermission()) === "granted";
          if (permitted) sendNotification({ title: payload.title, body: payload.message });
        } catch (cause) {
          console.error("No se pudo mostrar la notificación:", cause);
        }
      })();
    }).then((stopListening) => {
      if (mounted) unlisten = stopListening;
      else stopListening();
    });

    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  async function handleSaveKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSavingKey(true);
    try {
      await invoke("save_api_key", { apiKey: apiKeyInput.trim() });
      setApiKeyExists(true);
      setApiKeyInput("");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSavingKey(false);
    }
  }

  async function handleAddTarget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setAddingTarget(true);
    try {
      await invoke<TrackedTarget>("add_target", {
        profile: profileInput.trim(),
        targetType,
        alias: alias.trim() || null,
      });
      setProfileInput("");
      setAlias("");
      await reloadData();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setAddingTarget(false);
    }
  }

  async function handleRemoveTarget(steamId: string) {
    setError("");
    try {
      await invoke("remove_target", { steamId });
      await reloadData();
    } catch (cause) {
      setError(String(cause));
    }
  }

  const onlineCount = snapshots.filter((snapshot) => snapshot.isOnline).length;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">S</div>
          <div>
            <div className="brand-name">SteamTracker</div>
            <div className="brand-caption">STEAM PRESENCE MONITOR</div>
          </div>
        </div>
        <div className="connection-state">
          <span className={apiKeyExists ? "state-dot active" : "state-dot"} />
          <span>{apiKeyExists ? "MONITOR CONFIGURADO" : "FALTA CONFIGURACIÓN"}</span>
        </div>
      </header>

      <section className="intro">
        <div className="eyebrow">DESKTOP COMPANION</div>
        <h1>Enterate cuando<br /><span>cambia su actividad.</span></h1>
        <p>
          Sigue perfiles de Steam desde el escritorio. Recibe avisos cuando alguien
          se conecta, inicia un juego o cambia su actividad, incluso con la ventana
          minimizada en el área de notificación.
        </p>
      </section>

      {!apiKeyExists && (
        <section className="setup-panel key-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">PASO 01</div>
              <h2>Conecta Steam Web API</h2>
            </div>
            <span className="count-pill">UNA SOLA VEZ</span>
          </div>
          <p className="panel-description">
            La API Key se guarda en Windows Credential Manager. SteamTracker no necesita
            tu contraseña de Steam.
          </p>
          <form className="inline-form key-form" onSubmit={handleSaveKey}>
            <input
              aria-label="Steam Web API Key"
              type="password"
              value={apiKeyInput}
              onChange={(event) => setApiKeyInput(event.target.value)}
              placeholder="Pega tu Steam Web API Key"
              autoComplete="off"
              required
            />
            <button type="submit" disabled={savingKey || !apiKeyInput.trim()}>
              {savingKey ? "Guardando..." : "Guardar API Key"}
            </button>
          </form>
          <a className="subtle-link" href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noreferrer">
            Obtener una API Key en Steam
          </a>
        </section>
      )}

      <section className="setup-panel">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">{apiKeyExists ? "TU MONITOR" : "PASO 02"}</div>
            <h2>Perfiles seguidos</h2>
          </div>
          <span className="count-pill">{targets.length} PERFILES</span>
        </div>

        {apiKeyExists && (
          <form className="add-form" onSubmit={handleAddTarget}>
            <div className="form-row">
              <label className="field grow">
                <span>Perfil, URL o Steam ID64</span>
                <input
                  value={profileInput}
                  onChange={(event) => setProfileInput(event.target.value)}
                  placeholder="https://steamcommunity.com/id/..."
                  required
                />
              </label>
              <label className="field">
                <span>Tipo de perfil</span>
                <select value={targetType} onChange={(event) => setTargetType(event.target.value as TargetType)}>
                  <option value="friend">Amiga / amigo</option>
                  <option value="public">Trader / perfil público</option>
                </select>
              </label>
            </div>
            <div className="form-row bottom-row">
              <label className="field grow">
                <span>Nombre personalizado (opcional)</span>
                <input
                  value={alias}
                  onChange={(event) => setAlias(event.target.value)}
                  placeholder="Ej. Trader"
                />
              </label>
              <button type="submit" disabled={addingTarget || !profileInput.trim()}>
                {addingTarget ? "Agregando..." : "＋ Agregar perfil"}
              </button>
            </div>
            <p className="form-note">
              El tipo de perfil no limita el seguimiento básico. Rich Presence avanzado se intentará
              únicamente cuando Steam permita consultar esos datos.
            </p>
          </form>
        )}

        {loading ? (
          <div className="empty-state"><p>Cargando perfiles...</p></div>
        ) : targets.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">◎</div>
            <h3>{apiKeyExists ? "Aún no sigues a nadie" : "Configura tu API Key para comenzar"}</h3>
            <p>
              Puedes seguir a tu amiga como contacto de Steam y añadir al trader como perfil público,
              aunque no esté en tu lista de amigos.
            </p>
          </div>
        ) : (
          <div className="target-list">
            {targets.map((target) => {
              const snapshot = snapshots.find((item) => item.steamId === target.steamId);
              return (
                <article className="target-row" key={target.steamId}>
                  <div className="avatar">
                    {snapshot?.avatarUrl ? <img src={snapshot.avatarUrl} alt="" /> : <span>{target.displayName.slice(0, 1).toUpperCase()}</span>}
                  </div>
                  <div className="target-main">
                    <div className="target-name">{target.displayName}</div>
                    <div className="target-meta">
                      {target.targetType === "friend" ? "AMIGO DE STEAM" : "PERFIL PÚBLICO"} · {target.steamId}
                    </div>
                  </div>
                  <div className="target-presence">
                    {snapshot ? (
                      <>
                        <span className={snapshot.isOnline ? "presence online" : "presence"}>
                          <span />{snapshot.personaLabel}
                        </span>
                        <span className="game-name">{snapshot.gameName ?? (snapshot.isOnline ? "No muestra un juego" : "Sin actividad")}</span>
                      </>
                    ) : (
                      <span className="waiting-label">Esperando primera lectura</span>
                    )}
                  </div>
                  <button className="remove-button" type="button" onClick={() => void handleRemoveTarget(target.steamId)} aria-label={"Quitar a " + target.displayName}>
                    ×
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {error && <div className="error-banner">{error}</div>}

      <section className="summary-strip">
        <div><strong>{targets.length}</strong><span>PERFILES SEGUIDOS</span></div>
        <div><strong>{onlineCount}</strong><span>EN LÍNEA</span></div>
        <div><strong>30s</strong><span>INTERVALO DE CONSULTA</span></div>
      </section>

      <section className="capability-grid">
        <article className="capability-card">
          <div className="card-kicker">01 / SEGUIMIENTO BÁSICO</div>
          <h3>Actividad de Steam</h3>
          <p>
            Estado online, offline, juego actual y cambios de actividad mediante
            Steam Web API, sujeto a la privacidad del perfil.
          </p>
          <span className="status-label">IMPLEMENTADO EN EL MONITOR</span>
        </article>
        <article className="capability-card accent-card">
          <div className="card-kicker">02 / MÓDULO EXPERIMENTAL</div>
          <h3>ARC Raiders Rich Presence</h3>
          <p>
            Capturar los valores extendidos publicados por Steam y validarlos antes
            de activar avisos de Speranza, Queue e In Round.
          </p>
          <span className="status-label">PENDIENTE DE PRUEBA REAL</span>
        </article>
      </section>

      {recentEvents.length > 0 && (
        <section className="recent-events">
          <div className="eyebrow">ÚLTIMOS AVISOS</div>
          {recentEvents.map((event, index) => (
            <div className="event-row" key={event.steamId + event.eventType + index}>
              <span>{event.title}</span>
              <p>{event.message}</p>
            </div>
          ))}
        </section>
      )}

      <footer>
        <span>STEAMTRACKER <span className="footer-separator">/</span> EARLY BUILD</span>
        <span>En línea: {loading ? "consultando..." : onlineCount + " de " + targets.length}</span>
      </footer>
    </main>
  );
}

export default App;