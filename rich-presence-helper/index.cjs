const http = require("node:http");
const crypto = require("node:crypto");
const { LoginSession, EAuthTokenPlatformType } = require("steam-session");
const SteamUser = require("steam-user");

const HOST = "127.0.0.1";
const APP_ID = 1808500;
const SECRET = process.env.STEAMTRACKER_BRIDGE_SECRET || "";
const state = {
  phase: "disconnected",
  accountName: null,
  steamId: null,
  qrUrl: null,
  lastError: null,
  refreshToken: null
};

let loginSession = null;
let steam = null;
let requestBusy = false;

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function respond(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk.toString("utf8");
      if (raw.length > 256 * 1024) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function publicStatus() {
  return {
    phase: state.phase,
    accountName: state.accountName,
    steamId: state.steamId,
    qrUrl: state.qrUrl,
    lastError: state.lastError
  };
}

function stopSteam() {
  if (steam) {
    try { steam.logOff(); } catch {}
    steam = null;
  }
}

function connectWithRefreshToken(refreshToken) {
  state.phase = "connecting";
  state.lastError = null;
  state.qrUrl = null;
  state.refreshToken = refreshToken;

  stopSteam();
  const client = new SteamUser({
    language: "english",
    autoRelogin: true,
    renewRefreshTokens: true,
    dataDirectory: null
  });
  steam = client;

  client.on("loggedOn", () => {
    state.phase = "connected";
    state.steamId = client.steamID ? client.steamID.getSteamID64() : null;
    state.accountName = (client.accountInfo && client.accountInfo.name) || state.accountName;
    state.lastError = null;
  });

  client.on("accountInfo", info => {
    if (info && info.name) state.accountName = info.name;
  });

  client.on("refreshToken", token => {
    state.refreshToken = token;
  });

  client.on("disconnected", (eresult, message) => {
    if (steam === client) {
      state.phase = "disconnected";
      state.lastError = message || String(eresult || "Disconnected from Steam");
    }
  });

  client.on("error", error => {
    state.phase = "error";
    state.lastError = error && error.message ? error.message : String(error);
  });

  client.logOn({
    refreshToken,
    machineName: "SteamTracker",
    logonID: crypto.randomInt(1, 0x7fffffff)
  });
}

async function startQrLogin() {
  if (loginSession) {
    try { loginSession.cancelLoginAttempt(); } catch {}
  }

  state.phase = "awaiting_qr";
  state.accountName = null;
  state.steamId = null;
  state.lastError = null;

  const session = new LoginSession(EAuthTokenPlatformType.SteamClient, {
    machineId: true,
    machineFriendlyName: "SteamTracker"
  });
  loginSession = session;

  session.on("authenticated", () => {
    const token = session.refreshToken;
    state.accountName = session.accountName || null;
    state.steamId = session.steamID ? session.steamID.getSteamID64() : null;
    state.refreshToken = token;
    connectWithRefreshToken(token);
  });

  session.on("timeout", () => {
    if (loginSession === session) {
      state.phase = "timeout";
      state.qrUrl = null;
      state.lastError = "El código QR expiró. Genera uno nuevo.";
    }
  });

  session.on("error", error => {
    if (loginSession === session) {
      state.phase = "error";
      state.lastError = error && error.message ? error.message : String(error);
    }
  });

  const result = await session.startWithQR();
  state.qrUrl = result.qrChallengeUrl;
  state.phase = "awaiting_approval";
  return { qrUrl: state.qrUrl };
}

async function getPresence(body) {
  if (!steam || state.phase !== "connected") {
    throw new Error("Conecta tu cuenta de Steam primero.");
  }
  if (requestBusy) {
    throw new Error("Steam está procesando otra consulta Rich Presence.");
  }

  const appId = Number(body.appId || APP_ID);
  if (appId !== APP_ID) throw new Error("El puente solo permite consultar ARC Raiders.");
  const steamIds = Array.isArray(body.steamIds)
    ? [...new Set(body.steamIds.map(String).filter(id => /^\d{17}$/.test(id)))].slice(0, 50)
    : [];
  if (!steamIds.length) return { appId, users: {} };

  requestBusy = true;
  try {
    const result = await new Promise((resolve, reject) => {
      steam.requestRichPresence(appId, steamIds, (error, response, users) => {
        if (error) return reject(error);
        resolve({ response: response || null, users: users || {} });
      });
    });
    return { appId, ...result };
  } finally {
    requestBusy = false;
  }
}

const server = http.createServer(async (req, res) => {
  if (!safeEqual(req.headers["x-steamtracker-secret"], SECRET)) {
    return respond(res, 401, { error: "Unauthorized" });
  }

  try {
    if (req.method === "GET" && req.url === "/status") {
      return respond(res, 200, { ...publicStatus(), refreshToken: state.refreshToken });
    }

    if (req.method === "POST" && req.url === "/login/start") {
      await readJson(req);
      const result = await startQrLogin();
      return respond(res, 200, result);
    }

    if (req.method === "POST" && req.url === "/login/restore") {
      const body = await readJson(req);
      if (typeof body.refreshToken !== "string" || body.refreshToken.length < 20) {
        return respond(res, 400, { error: "Refresh token no válido." });
      }
      connectWithRefreshToken(body.refreshToken);
      return respond(res, 200, publicStatus());
    }

    if (req.method === "POST" && req.url === "/presence") {
      const body = await readJson(req);
      return respond(res, 200, await getPresence(body));
    }

    if (req.method === "POST" && req.url === "/logout") {
      await readJson(req);
      if (loginSession) {
        try { loginSession.cancelLoginAttempt(); } catch {}
        loginSession = null;
      }
      stopSteam();
      state.phase = "disconnected";
      state.accountName = null;
      state.steamId = null;
      state.qrUrl = null;
      state.refreshToken = null;
      state.lastError = null;
      return respond(res, 200, publicStatus());
    }

    return respond(res, 404, { error: "Not found" });
  } catch (error) {
    return respond(res, 500, { error: error && error.message ? error.message : String(error) });
  }
});

if (!SECRET) {
  process.stderr.write("Missing bridge secret.\n");
  process.exit(2);
}

server.listen(0, HOST, () => {
  const address = server.address();
  process.stdout.write(JSON.stringify({ ready: true, port: address.port }) + "\n");
});

process.on("SIGTERM", () => {
  stopSteam();
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  stopSteam();
  server.close(() => process.exit(0));
});