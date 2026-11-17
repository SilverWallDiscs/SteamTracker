function App() {
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
          <span className="state-dot" />
          <span>MONITOR NO CONFIGURADO</span>
        </div>
      </header>

      <section className="intro">
        <div className="eyebrow">DESKTOP COMPANION</div>
        <h1>Enterate cuando<br /><span>cambia su actividad.</span></h1>
        <p>
          Sigue perfiles de Steam desde el escritorio. Recibe avisos cuando alguien
          se conecta, inicia un juego o cambia su presencia.
        </p>
      </section>

      <section className="setup-panel">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">TU MONITOR</div>
            <h2>Perfiles seguidos</h2>
          </div>
          <span className="count-pill">0 PERFILES</span>
        </div>
        <div className="empty-state">
          <div className="empty-icon">◎</div>
          <h3>Aún no sigues a nadie</h3>
          <p>
            Agrega un perfil de Steam para comenzar. Los perfiles públicos pueden
            tener seguimiento básico aunque no sean tus amigos.
          </p>
        </div>
      </section>

      <section className="capability-grid">
        <article className="capability-card">
          <div className="card-kicker">01 / SEGUIMIENTO BÁSICO</div>
          <h3>Actividad de Steam</h3>
          <p>
            Estado online, offline, juego actual y cambios de actividad mediante
            Steam Web API, sujeto a la privacidad del perfil.
          </p>
          <span className="status-label">BASE DEL MONITOR</span>
        </article>
        <article className="capability-card accent-card">
          <div className="card-kicker">02 / MÓDULO EXPERIMENTAL</div>
          <h3>Rich Presence</h3>
          <p>
            Investigar los datos extendidos que Steam muestra para amigos.
            ARC Raiders: Speranza, Queue e In Round se validarán con datos reales.
          </p>
          <span className="status-label">EN VALIDACIÓN</span>
        </article>
      </section>

      <footer>
        <span>STEAMTRACKER <span className="footer-separator">/</span> EARLY BUILD</span>
        <span>La app puede permanecer minimizada en el área de notificación.</span>
      </footer>
    </main>
  );
}

export default App;