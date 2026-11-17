import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import QRCode from "qrcode";
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
type BridgeStatus = {
  phase: string;
  accountName?: string | null;
  steamId?: string | null;
  qrUrl?: string | null;
  lastError?: string | null;
};
type RichUser = {
  richPresence?: Record<string, string>;
  localizedString?: string | null;
};
type RichResponse = {
  appId: number;
  users: Record<string, RichUser>;
};
type RichPresenceView = RichUser & {
  stateLabel: string;
  observedAt: number;
};

function classifyPresence(presence: RichUser): string {
  const raw = [
    presence.localizedString || "",
    ...Object.entries(presence.richPresence || {}).flatMap(([key, value]) => [key, value]),
  ].join(" ").toLocaleLowerCase();

  if (raw.includes("speranza")) return "In Speranza";
  if (/(\bqueue\b|matchmaking|searching for match|waiting for players)/i.test(raw)) return "In Queue";
  if (/(\bin round\b|in raid|in expedition|round started|active round)/i.test(raw)) return "In Round";
  return presence.localizedString || "Rich Presence disponible (estado sin clasificar)";
}

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
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>({ phase: "checking" });
  const [qrImage, setQrImage] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [richPresence, setRichPresence] = useState<Record<string, RichPresenceView>>({});
  const [lastRichCheck, setLastRichCheck] = useState<number | null>(null);
  const previousRichState = useRef<Record<string, string>>({});

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

  async function refreshBridgeStatus() {
    try {
      const status = await invoke<BridgeStatus>("rich_presence_status");
      setBridgeStatus(status);
      if (status.phase === "connected") setQrImage("");
      if (status.qrUrl) {
        const image = await QRCode.toDataURL(status.qrUrl, {
          width: 230,
          margin: 1,
          errorCorrectionLevel: "M",
        });
        setQrImage(image);
      }
    } catch (cause) {
      setBridgeStatus({ phase: "unavailable", lastError: String(cause) });
    }
  }

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;
    void reloadData();
    void refreshBridgeStatus();

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

    const statusTimer = window.setInterval(() => void refreshBridgeStatus(), 2500);
    return () => {
      mounted = false;
      unlisten?.();
      window.clearInterval(statusTimer);
    };
  }, []);

  useEffect(() => {
    if (bridgeStatus.phase !== "connected" || targets.length === 0) {
      setRichPresence({});
      return;
    }

    let active = true;
    const queryPresence = async () => {
      try {
        const result = await invoke<RichResponse>("rich_presence_query", {
          steamIds: targets.map((target) => target.steamId),
        });
        if (!active) return;

        const next: Record<string, RichPresenceView> = {};
        for (const [steamId, value] of Object.entries(result.users || {})) {
          const view = {
            ...value,
            stateLabel: classifyPresence(value),
            observedAt: Date.now(),
          };
          next[steamId] = view;
          const signature = JSON.stringify({
            localizedString: value.localizedString || null,
            richPresence: value.richPresence || {},
          });
          const previous = previousRichState.current[steamId];
          if (previous && previous !== signature) {
            const target = targets.find((item) => item.steamId === steamId);
            const message = (target?.displayName || steamId) + ": " + view.stateLabel;
            void (async () => {
              try {
                let permitted = await isPermissionGranted();
                if (!permitted) permitted = (await requestPermission()) === "granted";
                if (permitted) sendNotification({ title: "ARC Raiders · Rich Presence", body: message });
              } catch (cause) {
                console.error("No se pudo mostrar la notificación Rich Presence:", cause);
              }
            })();
          }
          previousRichState.current[steamId] = signature;
        }

        setRichPresence(next);
        setLastRichCheck(Date.now());
      } catch (cause) {
        console.warn("Rich Presence no disponible:", cause);
      }
    };

    void queryPresence();
    const timer = window.setInterval(() => void queryPresence(), 15000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [bridgeStatus.phase, targets]);

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

  async function handleStartSteamLogin() {
    setError("");
    setLoginBusy(true);
    setBridgeStatus({ phase: "starting" });
    try {
      const result = await invoke<{ qrUrl: string }>("rich_presence_start_login");
      const image = await QRCode.toDataURL(result.qrUrl, {
        width: 230,
        margin: 1,
        errorCorrectionLevel: "M",
      });
      setQrImage(image);
      setBridgeStatus({ phase: "awaiting_approval", qrUrl: result.qrUrl });
    } catch (cause) {
      setError("No se pudo iniciar Steam Guard: " + String(cause));
      await refreshBridgeStatus();
    } finally {
      setLoginBusy(false);
    }
  }

  async function handleSteamLogout() {
    setError("");
    try {
      await invoke("rich_presence_logout");
      previousRichState.current = {};
      setRichPresence({});
      setQrImage("");
      await refreshBridgeStatus();
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
              El tipo de perfil no limita el seguimiento básico. Rich Presence se consulta mediante tu sesión Steam
              cuando el perfil publica datos de ARC Raiders.
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
              const rich = richPresence[target.steamId];
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
                    {rich && (
                      <span className="rich-state">
                        {rich.stateLabel}
                      </span>
                    )}
                  </div>
                  <button className="remove-button" type="button" onClick={() => void handleRemoveTarget(target.steamId)} aria-label={"Quitar a " + target.displayName}>
                    ×
                  </button>
                  {rich && (
                    <details className="raw-presence">
                      <summary>Ver datos Rich Presence recibidos</summary>
                      <div className="raw-localized">
                        {rich.localizedString || "Steam no devolvió un texto localizado para este perfil."}
                      </div>
                      <pre>{JSON.stringify(rich.richPresence || {}, null, 2)}</pre>
                    </details>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="setup-panel rich-panel">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">ARC RAIDERS · APP ID 1808500</div>
            <h2>Rich Presence de Steam</h2>
          </div>
          <span className={bridgeStatus.phase === "connected" ? "count-pill connected-pill" : "count-pill"}>
            {bridgeStatus.phase === "connected" ? "STEAM CONECTADO" : bridgeStatus.phase === "awaiting_approval" ? "ESPERANDO CONFIRMACIÓN" : bridgeStatus.phase.toUpperCase()}
          </span>
        </div>

        {bridgeStatus.phase === "connected" ? (
          <div className="bridge-connected">
            <div className="bridge-identity">
              <span className="state-dot active" />
              <div>
                <strong>{bridgeStatus.accountName || "Cuenta Steam conectada"}</strong>
                <span>{bridgeStatus.steamId || "Sesión autenticada mediante Steam Guard"}</span>
              </div>
            </div>
            <button className="secondary-button" type="button" onClick={() => void handleSteamLogout()}>
              Desconectar Steam
            </button>
          </div>
        ) : (
          <div className="bridge-login">
            <div className="bridge-copy">
              <h3>Conecta tu cuenta para leer los estados extendidos</h3>
              <p>
                SteamTracker abrirá una sesión de cliente separada. Escanea el QR con Steam Mobile y confirma
                el inicio de sesión. No se solicita ni almacena tu contraseña.
              </p>
              <button type="button" onClick={() => void handleStartSteamLogin()} disabled={loginBusy || bridgeStatus.phase === "starting"}>
                {loginBusy || bridgeStatus.phase === "starting" ? "Generando QR..." : "Conectar con Steam mediante QR"}
              </button>
              {bridgeStatus.lastError && <p className="bridge-error">{bridgeStatus.lastError}</p>}
            </div>
            {qrImage && (
              <div className="qr-wrap">
                <img src={qrImage} alt="Código QR para iniciar sesión en Steam" />
                <span>Escanéalo con la aplicación Steam</span>
              </div>
            )}
          </div>
        )}

        <div className="rich-legend">
          <span>Estados reconocidos automáticamente: <strong>In Speranza</strong>, <strong>In Queue</strong>, <strong>In Round</strong>.</span>
          <span>{lastRichCheck ? "Última consulta: " + new Date(lastRichCheck).toLocaleTimeString() : "Esperando datos de Steam..."}</span>
        </div>
        <p className="form-note">
          La clasificación busca esas palabras en el texto localizado y los campos originales. Los valores sin clasificar
          se conservan y aparecen en «Ver datos Rich Presence recibidos» para poder ajustar el detector tras tu prueba.
        </p>
      </section>

      {error && <div className="error-banner">{error}</div>}

      <section className="summary-strip">
        <div><strong>{targets.length}</strong><span>PERFILES SEGUIDOS</span></div>
        <div><strong>{onlineCount}</strong><span>EN LÍNEA</span></div>
        <div><strong>30s</strong><span>INTERVALO ACTIVIDAD BÁSICA</span></div>
      </section>

      <section className="capability-grid">
        <article className="capability-card">
          <div className="card-kicker">01 / SEGUIMIENTO BÁSICO</div>
          <h3>Actividad de Steam</h3>
          <p>
            Estado online, offline, juego actual y cambios de actividad mediante
            Steam Web API, sujeto a la privacidad del perfil.
          </p>
          <span className="status-label">ACTIVO</span>
        </article>
        <article className="capability-card accent-card">
          <div className="card-kicker">02 / RICH PRESENCE</div>
          <h3>ARC Raiders</h3>
          <p>
            Solicitud de estado extendido cada 15 segundos para todos los perfiles seguidos,
            incluidos los que no están en tu lista de amigos.
          </p>
          <span className="status-label">LECTURA EXPERIMENTAL · CLASIFICADOR AJUSTABLE</span>
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