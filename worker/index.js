// ============================================================================
// WORKER - punto de entrada del parcial
//
//   node index.js {PUERTO} {URL_NGROK}
//   Ej: node index.js 4000 https://nombre-random-ngrok.dev
//
// El ID sale de identity.js (worker-{nombre}-{codigo}). Los coordinadores se
// agregan desde el panel web (http://localhost:{PUERTO}); un tercer argumento
// opcional permite arrancar ya apuntando a uno.
//
//   POST /task/assign        el coordinador (lider) me manda una tarea
//   GET  /task/capabilities  que se hacer y como armar el payload
//   -> POST {lider}/task/receive   devuelvo el resultado al terminar
// ============================================================================

const os = require("os");
const express = require("express");
const axios = require("axios");

const capabilities = require("./capabilities");

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, x-server-token, x-worker, ngrok-skip-browser-warning",
  );
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ============================================================================
// CONFIGURACION
// ============================================================================

const clean = (url) =>
  String(url || "")
    .trim()
    .replace(/\/+$/, "");

const PORT = Number(process.argv[2] || process.env.PORT || 4000);
const HOST = process.env.HOST || "0.0.0.0";

if (Number.isNaN(PORT)) {
  console.error("\n  Uso: node index.js {PUERTO} {URL_NGROK}");
  console.error("  Ej.: node index.js 4000 https://nombre-random-ngrok.dev\n");
  process.exit(1);
}

const HOST_INFO = {
  hostname: os.hostname(),
  platform: os.platform(),
  arch: os.arch(),
  node: process.version,
};

function defaultSelfUrl() {
  const ip = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal);
  return `http://${ip ? ip.address : "localhost"}:${PORT}`;
}

const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 4); // con esto se calcula la carga

const state = {
  // Se establece desde la interfaz web mediante POST /identity.
  name: null,
  parentUrl: clean(process.argv[4] || process.env.PARENT_URL) || null, // coordinador (lider) actual
  leaderId: null,
  selfUrl: clean(process.argv[3] || process.env.SELF_URL) || defaultSelfUrl(),
  token: null,
  registered: false,
  pulseMs: Number(process.env.PULSE_MS || 3000), // PDF: pulse interval 3s
  pulsing: true,
  pulsesSent: 0,
  pulsesFailed: 0,
  taskDelayMs: Number(process.env.TASK_DELAY_MS || 2000), // "lag" simulado por tarea
  active: 0, // tareas en ejecucion
  tasksDone: 0,
  startedAt: Date.now(),
};

const http = axios.create({
  timeout: 6000,
  headers: { "ngrok-skip-browser-warning": "true" },
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const currentLoad = () =>
  Math.round(Math.min(1, state.active / MAX_CONCURRENT) * 100) / 100;

// ============================================================================
// LOG
// ============================================================================

const logs = [];
let logSeq = 0;

function log(level, event, data = {}) {
  const entry = { id: ++logSeq, ts: Date.now(), level, event, data };
  logs.push(entry);
  if (logs.length > 200) logs.shift();
  console.log(
    `[${new Date(entry.ts).toLocaleTimeString()}] ${String(level).toUpperCase().padEnd(7)} ${event}`,
    Object.keys(data).length ? JSON.stringify(data) : "",
  );
  return entry;
}

// ============================================================================
// COORDINADORES CONOCIDOS
// ============================================================================
// Cada respuesta de un coordinador trae a sus companeros y al lider: asi el
// worker aprende la lista solo y sabe a quien ir cuando el lider cae.

const coordinators = new Set(state.parentUrl ? [state.parentUrl] : []);
let hunting = false;
let huntTimer = null;

function rememberCluster(data) {
  if (!data) return;
  const found = [
    ...(data.peers || []),
    data.leader,
    data.data && data.data.leaderUrl,
  ];

  for (const url of found) {
    if (url && typeof url === "string" && !coordinators.has(clean(url))) {
      coordinators.add(clean(url));
      log("info", "coordinator-known", { url: clean(url) });
    }
  }

  if (data.leaderId) state.leaderId = data.leaderId;
}

// ============================================================================
// REGISTRO
// ============================================================================

async function register({ retries = 5 } = {}) {
  if (!state.name)
    return {
      ok: false,
      error: "falta configurar el ID del worker desde la interfaz",
    };
  if (!state.parentUrl)
    return { ok: false, error: "no hay coordinador configurado" };

  let hops = 0; // saltos de redirect al lider (maximo 3)

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { data } = await http.post(
        `${state.parentUrl}/register`,
        {
          id: state.name,
          name: state.name,
          url: state.selfUrl,
          host: HOST_INFO,
          capabilities: capabilities.names(),
          schemas: capabilities.describe(state.name).schemas,
          token: state.token || undefined,
        },
        {
          headers: state.token ? { "x-server-token": state.token } : {},
        },
      );

      state.token = data.token || state.token;
      state.registered = true;
      if (data.name) state.name = data.name;
      rememberCluster(data);

      log("success", "registered", {
        name: state.name,
        coordinator: state.parentUrl,
        self: state.selfUrl,
      });
      startPulsing();
      return { ok: true, data };
    } catch (error) {
      const status = error.response?.status;
      const body = error.response?.data;
      rememberCluster(body);

      // No es el lider y nos dice quien lo es (redirect)
      const leaderUrl = clean(body?.data?.leaderUrl || body?.leader);
      if (status === 409 && leaderUrl && !body?.suggestion && hops < 3) {
        hops++;
        log("info", "redirect", { from: state.parentUrl, to: leaderUrl });
        state.parentUrl = leaderUrl;
        coordinators.add(leaderUrl);
        attempt--;
        continue;
      }

      // Eleccion en curso o coordinador fuera de servicio: buscar lider
      if (status === 503 || (status === 409 && !body?.suggestion)) {
        log("warn", "no-leader", {
          coordinator: state.parentUrl,
          error: body?.error,
        });
        state.registered = false;
        scheduleHunt();
        return { ok: false, error: body?.error };
      }

      // Colision de nombre: se adopta el que sugiere el coordinador
      if (status === 409 && body?.suggestion) {
        log("warn", "name-taken", {
          tried: state.name,
          using: body.suggestion,
        });
        state.name = body.suggestion;
        state.token = null;
        continue;
      }

      if (status === 400) {
        log("error", "register-rejected", { error: body?.error });
        return { ok: false, error: body?.error };
      }

      const waitMs = Math.min(1000 * 2 ** (attempt - 1), 15000);
      log("warn", "register-retry", {
        attempt,
        in: `${waitMs}ms`,
        error: error.message,
      });
      state.registered = false;
      if (attempt < retries) await sleep(waitMs);
    }
  }

  log("error", "register-failed", { coordinator: state.parentUrl });
  scheduleHunt(); // no se queda zombi: sigue buscando quien lo acepte
  return { ok: false, error: "no se pudo registrar en el coordinador" };
}

async function switchTo(url) {
  const previous = state.parentUrl;
  state.parentUrl = clean(url);

  const result = await register({ retries: 1 });
  if (!result.ok) {
    state.parentUrl = previous;
    return false;
  }

  if (state.parentUrl !== previous)
    log("success", "new-leader", { from: previous, to: state.parentUrl });
  return true;
}

// Pregunta a cada coordinador conocido quien manda y se va con el.
async function huntForLeader() {
  if (hunting || !state.pulsing) return false;
  hunting = true;
  clearTimeout(huntTimer);

  const descartados = new Set();
  const candidates = [
    ...new Set([state.parentUrl, ...coordinators].filter(Boolean)),
  ];

  try {
    for (const url of candidates) {
      if (descartados.has(url)) continue;

      let info;
      try {
        info = (await http.get(`${url}/election/state`, { timeout: 2500 }))
          .data;
      } catch {
        descartados.add(url);
        continue;
      }

      rememberCluster({ peers: (info.peers || []).map((p) => p.url) });

      if (info.faults?.paused) {
        // congelado: dice ser lider pero no atiende
        descartados.add(url);
        continue;
      }

      const leader = info.role === "leader" ? url : info.leaderUrl;
      if (!leader || descartados.has(clean(leader))) continue;

      if (await switchTo(leader)) return true;
      descartados.add(clean(leader));
    }

    log("warn", "hunting-leader", {
      asked: candidates.length,
      result: "no hay lider disponible",
      retryInMs: 3000,
    });
    return false;
  } finally {
    hunting = false;
    if (!state.registered) scheduleHunt(); // nunca se rinde: espera a que aparezca un lider
  }
}

function scheduleHunt(ms = 3000) {
  if (hunting || !state.pulsing || coordinators.size === 0) return;
  clearTimeout(huntTimer);
  huntTimer = setTimeout(() => huntForLeader(), ms);
}

// ============================================================================
// PULSOS (con carga)
// ============================================================================

let pulseInterval = null;

function startPulsing() {
  stopPulsing();
  if (!state.pulsing) return;

  pulseInterval = setInterval(async () => {
    if (hunting || !state.parentUrl) return;

    try {
      const { data } = await http.post(
        `${state.parentUrl}/pulse/${encodeURIComponent(state.name)}`,
        {
          id: state.name,
          load: currentLoad(),
        },
      );
      state.pulsesSent++;
      rememberCluster(data);

      if (!state.registered) {
        state.registered = true;
        log("success", "link-recovered", { coordinator: state.parentUrl });
      }
    } catch (error) {
      state.pulsesFailed++;
      state.registered = false;

      const status = error.response?.status;
      const body = error.response?.data;
      rememberCluster(body);

      const leaderUrl = clean(body?.data?.leaderUrl || body?.leader);

      if (status === 404) {
        log("warn", "pulse-unknown", { action: "re-register" });
        register({ retries: 1 });
      } else if (status === 409 && leaderUrl) {
        log("warn", "not-leader", {
          coordinator: state.parentUrl,
          leader: leaderUrl,
        });
        switchTo(leaderUrl).then((ok) => {
          if (!ok) huntForLeader();
        });
      } else {
        log("warn", "pulse-failed", { error: body?.error || error.message });
        huntForLeader();
      }
    }
  }, state.pulseMs);

  log("info", "pulsing", { everyMs: state.pulseMs });
}

function stopPulsing() {
  if (pulseInterval) clearInterval(pulseInterval);
  pulseInterval = null;
}

// ============================================================================
// TAREAS
// ============================================================================

const history = []; // tareas recibidas (mas nueva primero)
const outbox = []; // resultados que aun no llegaron al lider
const MAX_ATTEMPTS = 20;

const errorBody = (message, extra) => ({
  type: "error",
  data: { message, ...(extra || {}) },
});

// El coordinador (lider) me asigna una tarea. Contesto rapido (202) y
// ejecuto en segundo plano: el resultado viaja despues a POST /task/receive.
app.post("/task/assign", (req, res) => {
  const d = (req.body && req.body.data) || req.body || {};
  const { taskId, type, payload } = d;

  if (
    !taskId ||
    typeof taskId !== "string" ||
    !type ||
    typeof type !== "string"
  ) {
    return res.status(400).json(errorBody("taskId y type son obligatorios"));
  }

  if (!capabilities.has(type)) {
    return res
      .status(400)
      .json(
        errorBody(`No tengo la capacidad '${type}'`, {
          capabilities: capabilities.names(),
        }),
      );
  }

  if (history.some((t) => t.taskId === taskId && t.status === "running")) {
    return res
      .status(202)
      .json({
        type: "task-accepted",
        data: { taskId, workerId: state.name, duplicate: true },
      });
  }

  const record = {
    taskId,
    type,
    payload,
    status: "running",
    receivedAt: Date.now(),
    finishedAt: null,
    result: null,
    error: null,
    delivered: false,
    deliveryNote: null,
  };
  history.unshift(record);
  if (history.length > 100) history.pop();

  state.active++;
  log("info", "task-received", { taskId, type, lagMs: state.taskDelayMs });

  res
    .status(202)
    .json({ type: "task-accepted", data: { taskId, workerId: state.name } });

  // El lag es configurable (POST /config/delay o TASK_DELAY_MS)
  setTimeout(async () => {
    try {
      record.result = await capabilities.execute(type, payload);
      record.status = "ok";
    } catch (error) {
      record.error = error.message;
      record.status = "error";
    }

    record.finishedAt = Date.now();
    state.active = Math.max(0, state.active - 1);
    state.tasksDone++;

    log(record.status === "ok" ? "success" : "warn", "task-done", {
      taskId,
      status: record.status,
    });

    outbox.push({
      record,
      attempts: 0,
      body: {
        type: "task-result",
        data:
          record.status === "ok"
            ? {
                taskId,
                status: "ok",
                result: record.result,
                workerId: state.name,
                taskType: type,
              }
            : {
                taskId,
                status: "error",
                error: record.error,
                workerId: state.name,
                taskType: type,
              },
      },
    });

    flushOutbox();
  }, state.taskDelayMs);
});

// Que se hacer y como armar el payload de cada tarea.
app.get("/task/capabilities", (req, res) => {
  res.json(capabilities.describe(state.name));
});

// Entrega de resultados al LIDER. Si cambio el lider, redirect; si no hay
// lider, se guarda y se reintenta: el resultado no se pierde.
let flushing = false;

async function flushOutbox() {
  if (flushing || !outbox.length) return;
  flushing = true;

  try {
    while (outbox.length) {
      const item = outbox[0];

      if (!state.parentUrl || !state.registered) break; // sin lider por ahora

      try {
        await http.post(`${state.parentUrl}/task/receive`, item.body);
        item.record.delivered = true;
        item.record.deliveryNote = `entregado a ${state.parentUrl}`;
        outbox.shift();
        log("info", "result-delivered", {
          taskId: item.record.taskId,
          to: state.parentUrl,
        });
      } catch (error) {
        item.attempts++;

        const status = error.response?.status;
        const body = error.response?.data;
        rememberCluster(body);
        const leaderUrl = clean(body?.data?.leaderUrl || body?.leader);

        if (item.attempts >= MAX_ATTEMPTS || status === 400) {
          item.record.deliveryNote = `no se pudo entregar: ${body?.data?.message || error.message}`;
          outbox.shift();
          log("error", "result-lost", {
            taskId: item.record.taskId,
            error: item.record.deliveryNote,
          });
          continue;
        }

        if (status === 409 && leaderUrl) {
          log("info", "redirect", { from: state.parentUrl, to: leaderUrl });
          await switchTo(leaderUrl);
          continue;
        }

        log("warn", "result-retry", {
          taskId: item.record.taskId,
          attempt: item.attempts,
          error: body?.error || error.message,
        });
        huntForLeader();
        break;
      }
    }
  } finally {
    flushing = false;
  }
}

setInterval(flushOutbox, 3000).unref();

app.get("/tasks", (req, res) => {
  res.json({
    active: state.active,
    load: currentLoad(),
    pendingDelivery: outbox.length,
    tasks: history.slice(0, 50),
  });
});

// ============================================================================
// PANEL WEB Y CONFIGURACION
// ============================================================================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    name: state.name,
    uptimeMs: Date.now() - state.startedAt,
    pulsing: state.pulsing,
    registered: state.registered,
    load: currentLoad(),
    host: HOST_INFO,
  });
});

app.get("/config", (req, res) => {
  res.json({
    name: state.name,
    selfUrl: state.selfUrl,
    parentUrl: state.parentUrl,
    leaderId: state.leaderId,
    registered: state.registered,
    pulsing: state.pulsing,
    pulseMs: state.pulseMs,
    hunting,
    load: currentLoad(),
    active: state.active,
    taskDelayMs: state.taskDelayMs,
    tasksDone: state.tasksDone,
    pulsesSent: state.pulsesSent,
    pulsesFailed: state.pulsesFailed,
    coordinators: [...coordinators],
    capabilities: capabilities.names(),
  });
});

// ============================================================================
// IDENTIDAD - el ID se define exclusivamente desde la interfaz del Worker
// ============================================================================

const WORKER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/;
const WORKER_RESERVED = new Set([
  "admin",
  "all",
  "server",
  "null",
  "undefined",
  "api",
]);

function validateWorkerId(value) {
  const id = String(value || "").trim();
  if (!id) return { ok: false, error: "El ID del worker es obligatorio" };
  if (!WORKER_ID_RE.test(id)) {
    return {
      ok: false,
      error:
        "ID invalido: use 1-40 caracteres [a-zA-Z0-9._-] y empiece con letra o numero",
    };
  }
  if (WORKER_RESERVED.has(id.toLowerCase())) {
    return { ok: false, error: `El ID '${id}' esta reservado` };
  }
  return { ok: true, id };
}

app.get("/identity", (req, res) => {
  res.json({
    id: state.name,
    configured: Boolean(state.name),
    canChange: !state.registered,
  });
});

app.post("/identity", async (req, res) => {
  const n = validateWorkerId(req.body?.id);
  if (!n.ok) return res.status(400).json({ ok: false, error: n.error });

  if (state.registered && state.name !== n.id) {
    return res
      .status(409)
      .json({
        ok: false,
        error:
          "No puedes cambiar el ID mientras el worker esta registrado. Desconectalo primero.",
      });
  }

  const previous = state.name;
  state.name = n.id;
  log("success", "worker-identity-set", { from: previous, to: state.name });

  let registration = null;
  if (state.parentUrl && !state.registered) {
    registration = await register({ retries: 3 });
  }

  res.json({
    ok: true,
    id: state.name,
    registered: state.registered,
    coordinator: state.parentUrl,
    registration,
  });
});

// Agregar un coordinador (desde el panel, o cuando un coordinador me invita).
app.post("/coordinators", async (req, res) => {
  const url = clean(req.body?.url);

  if (!/^https?:\/\/[^\s/]+/.test(url)) {
    return res
      .status(400)
      .json({
        ok: false,
        error: "URL invalida (ej: https://algo.ngrok-free.dev)",
      });
  }

  coordinators.add(url);
  log("info", "coordinator-added", { url });

  // Si ya estoy con un lider vivo no me muevo: si ese coordinador es (o
  // llega a ser) el lider, el redirect me lleva solo.
  if (!state.registered) {
    state.parentUrl = url;
    const result = await register({ retries: 2 });
    return res.json({
      ok: result.ok,
      registered: state.registered,
      coordinator: state.parentUrl,
      error: result.ok ? undefined : result.error,
    });
  }

  res.json({
    ok: true,
    registered: true,
    coordinator: state.parentUrl,
    note: "agregado a la lista; ya estoy registrado con un lider",
  });
});

app.delete("/coordinators", (req, res) => {
  const url = clean(req.body?.url);
  if (url === state.parentUrl)
    return res
      .status(400)
      .json({ ok: false, error: "Es el lider actual: no se puede quitar" });
  res.json({ ok: coordinators.delete(url) });
});

app.post("/config/delay", (req, res) => {
  const ms = Number(req.body?.ms);
  if (!Number.isFinite(ms) || ms < 0 || ms > 120000)
    return res.status(400).json({ error: "ms debe estar entre 0 y 120000" });
  state.taskDelayMs = Math.round(ms);
  log("info", "delay-set", { ms: state.taskDelayMs });
  res.json({ ok: true, taskDelayMs: state.taskDelayMs });
});

// Dejar de enviar pulsos / reanudarlos (para probar la caida del worker)
app.post("/shutdown", (req, res) => {
  state.pulsing = false;
  stopPulsing();
  log("warn", "pulses-stopped", { name: state.name });
  res.json({ message: `${state.name} dejo de enviar pulsos` });
});

app.post("/resume", (req, res) => {
  state.pulsing = true;
  startPulsing();
  if (!state.registered) huntForLeader();
  log("success", "pulses-resumed", { name: state.name });
  res.json({ message: `${state.name} reanudo los pulsos` });
});

app.get("/logs", (req, res) => {
  res.json(logs.slice(-Math.min(Number(req.query.limit) || 100, 200)));
});

app.use(express.static(require("path").join(__dirname, "public")));

// ============================================================================
// ARRANQUE Y APAGADO LIMPIO
// ============================================================================

const server = app.listen(PORT, HOST, async (error) => {
  if (error) {
    console.error(
      `\n  No se pudo arrancar en el puerto ${PORT}: ${error.code === "EADDRINUSE" ? "ya esta en uso" : error.message}\n`,
    );
    process.exit(1);
  }

  console.log("--------------------------------------------------------");
  console.log(` WORKER '${state.name}' en ${HOST}:${PORT}`);
  console.log(` URL publica   : ${state.selfUrl}`);
  console.log(
    ` Coordinador   : ${state.parentUrl || "ninguno (agregalo desde el panel)"}`,
  );
  console.log(` Capacidades   : ${capabilities.names().join(", ")}`);
  console.log(` Lag por tarea : ${state.taskDelayMs} ms`);
  console.log(` Panel         : http://localhost:${PORT}`);
  console.log("--------------------------------------------------------");

  if (state.parentUrl && state.name) await register();
  else
    console.log("  ID            : pendiente; configuralo desde el panel web");
});

async function shutdown(signal) {
  log("warn", "shutting-down", { signal });
  stopPulsing();

  if (state.parentUrl && state.name) {
    try {
      await http.delete(
        `${state.parentUrl}/unregister/${encodeURIComponent(state.name)}`,
        {
          headers: state.token ? { "x-server-token": state.token } : {},
        },
      );
    } catch {
      /* el coordinador lo detectara por timeout */
    }
  }

  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
