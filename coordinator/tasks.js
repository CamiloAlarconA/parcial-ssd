// ============================================================================
// TAREAS DEL COORDINADOR
// ----------------------------------------------------------------------------
//   GET  {worker}/task/capabilities   el coordinador descubre que sabe hacer
//                                     cada worker y con que payload
//   POST {worker}/task/assign         el coordinador (lider) asigna una tarea
//   POST /task/receive                el worker devuelve el resultado al lider
//
// Endpoints internos para el panel web:
//   POST /tasks                       enviar una tarea (elige worker o el de menor carga)
//   GET  /tasks                       historial de tareas
//   GET  /tasks/capabilities          capacidades de los workers conectados
//   POST /tasks/capabilities/refresh  volver a leer /task/capabilities
//   POST /tasks/workers               pedirle a un worker que se conecte aqui
//
// El coordinador NO tiene las capacidades cableadas: las lee de cada worker. El
// catalogo KNOWN solo rellena ejemplo/esquema cuando un worker (por ejemplo el de
// un companero) declara la capacidad sin decir como se arma el payload.
// ============================================================================

const axios = require("axios")

const HEADERS = { "ngrok-skip-browser-warning": "true" }
const TASK_TIMEOUT_MS = Number(process.env.TASK_TIMEOUT_MS || 30000)
const MAX_TASKS = 200

// Las 6 capacidades del PDF: solo sirven de ayuda para el formulario del panel.
const KNOWN = {
    math_compute: {
        description: "Calculadora basica: una operacion y dos operandos",
        payload: { operation: "add | sub | mul | div", a: "number", b: "number" },
        example: { operation: "add", a: 10, b: 5 },
        result: { result: "number" }
    },
    http_fetch: {
        description: "Hace fetch a una URL y devuelve status y cuerpo",
        payload: { url: "string" },
        example: { url: "https://example.com" },
        result: { status: "number", body: "any" }
    },
    search_text: {
        description: "Cuenta cuantas veces aparece el query dentro del texto",
        payload: { text: "string", query: "string" },
        example: { text: "hola mundo hola", query: "hola" },
        result: { count: "number" }
    },
    stats_compute: {
        description: "Promedio, minimo y maximo de una lista de numeros",
        payload: { numbers: "number[]" },
        example: { numbers: [1, 2, 3, 4, 5] },
        result: { mean: "number", min: "number", max: "number" }
    },
    vector_distance: {
        description: "Distancia entre dos vectores de dos dimensiones",
        payload: { a: "number[2]", b: "number[2]" },
        example: { a: [0, 0], b: [3, 4] },
        result: { distance: "number" }
    },
    http_latency: {
        description: "Latencia en milisegundos de una URL",
        payload: { url: "string" },
        example: { url: "https://example.com" },
        result: { ms: "number" }
    }
}

const tasks = new Map()   // taskId -> tarea

const clean = url => String(url || "").trim().replace(/\/+$/, "")
const unwrap = body => (body && typeof body === "object" && body.data && typeof body.data === "object" ? body.data : body || {})

/* ------------------------------------------------------------ capacidades -- */

// Acepta lo que mande cada equipo: ["a","b"], {capabilities:[...]},
// {type,data:{capabilities:[...]}}, y cada item como string u objeto.
function normalizeCapabilities(body) {
    // Contrato estandarizado:
    // {
    //   worker,
    //   capabilities: ["cap1", "cap2"],
    //   schemas: {
    //     cap1: { description, payload, expectedResult }
    //   }
    // }
    let source = body
    if (source && !Array.isArray(source)) source = unwrap(source)
    if (!source || typeof source !== "object") return []

    const list = Array.isArray(source) ? source : (source.capabilities || source.caps || [])
    if (!Array.isArray(list)) return []

    const schemas = !Array.isArray(source) && source.schemas && typeof source.schemas === "object"
        ? source.schemas
        : {}

    const out = []

    for (const item of list) {
        const type = typeof item === "string"
            ? item
            : (item && (item.type || item.name || item.capability || item.id))

        if (!type || out.some(c => c.type === type)) continue

        const schema = schemas[type] || {}
        const known = KNOWN[type] || {}

        // Contrato nuevo: schema.payload es el ejemplo que se usara para
        // construir la tarea; schema.expectedResult es el ejemplo de salida.
        const payloadExample = schema.payload !== undefined
            ? schema.payload
            : (item && typeof item === "object" && item.example !== undefined ? item.example : known.example || null)

        const resultExample = schema.expectedResult !== undefined
            ? schema.expectedResult
            : (item && typeof item === "object" && item.result !== undefined ? item.result : known.result || null)

        out.push({
            type: String(type),
            description: schema.description || (item && typeof item === "object" && item.description) || known.description || "",
            // Se conserva payload como compatibilidad interna: representa el
            // ejemplo del contrato estandarizado.
            payload: payloadExample,
            example: payloadExample,
            expectedResult: resultExample,
            result: resultExample,
            inputSchema: known.payload || null
        })
    }

    return out
}

// Al registrarse, el worker puede declarar sus capacidades en el body
// (["math_compute", ...]); luego se leen completas con GET /task/capabilities.
function onRegister(entry, body) {
    const declared = normalizeCapabilities(body && body.capabilities)
    if (declared.length) entry.capabilities = declared
    refreshCapabilities(entry)
}

async function refreshCapabilities(entry) {
    if (!entry || !entry.url) return entry && entry.capabilities
    if (entry.capsFetching) return entry.capabilities

    entry.capsFetching = true

    try {
        const { data } = await axios.get(`${clean(entry.url)}/task/capabilities`, { timeout: 5000, headers: HEADERS })
        const caps = normalizeCapabilities(data)

        if (caps.length) {
            entry.capabilities = caps
            entry.capsAt = Date.now()
            module.exports.log("info", "capabilities", { worker: entry.display, capabilities: caps.map(c => c.type) })
        }
    } catch (error) {
        module.exports.log("warn", "capabilities-failed", { worker: entry.display, error: error.message })
    } finally {
        entry.capsFetching = false
    }

    return entry.capabilities
}

const hasCapability = (entry, type) =>
    (entry.capabilities || []).some(c => String(c.type).toLowerCase() === String(type).toLowerCase())

/* --------------------------------------------------------------- tareas -- */

function newTaskId() {
    return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function remember(task) {
    tasks.set(task.id, task)

    if (tasks.size > MAX_TASKS) {
        const oldest = tasks.keys().next().value
        tasks.delete(oldest)
    }

    return task
}

function pendingOf(registry, name) {
    let n = 0
    tasks.forEach(t => { if (t.status === "pending" && t.worker === name) n++ })
    return n
}

// Menor carga entre los workers vivos que SABEN hacer la tarea.
function pickWorker(ctx, type, preferred) {
    const { registry, computeStatus } = ctx
    const alive = [...registry.values()].filter(e => computeStatus(e) === "ALIVE")

    if (preferred) {
        const wanted = alive.find(e => e.key === String(preferred).trim().toLowerCase() || e.display === preferred)
        return wanted || null
    }

    const capable = alive.filter(e => hasCapability(e, type))

    capable.sort((a, b) => {
        const la = typeof a.load === "number" ? a.load : 0.5
        const lb = typeof b.load === "number" ? b.load : 0.5
        if (la !== lb) return la - lb
        const pa = pendingOf(registry, a.display)
        const pb = pendingOf(registry, b.display)
        if (pa !== pb) return pa - pb
        return a.display.localeCompare(b.display)
    })

    return capable[0] || null
}

async function assign(ctx, { type, payload, worker }) {
    let target = pickWorker(ctx, type, worker)

    if (!target) {
        const why = worker
            ? `El worker '${worker}' no esta conectado o no esta vivo`
            : `No hay ningun worker vivo con la capacidad '${type}'`
        return { status: 404, body: { type: "error", data: { message: why } } }
    }

    // Capacidades aun desconocidas: se leen antes de decidir.
    if (!target.capabilities || !target.capabilities.length) await refreshCapabilities(target)

    if (!hasCapability(target, type)) {
        return {
            status: 409,
            body: { type: "error", data: { message: `El worker '${target.display}' no declara la capacidad '${type}'`, capabilities: (target.capabilities || []).map(c => c.type) } }
        }
    }

    const task = remember({
        id: newTaskId(),
        type,
        payload: payload || {},
        worker: target.display,
        workerUrl: target.url,
        assignedBy: ctx.engine.state.id,
        status: "pending",
        createdAt: Date.now(),
        finishedAt: null,
        result: null,
        error: null
    })

    try {
        await axios.post(`${clean(target.url)}/task/assign`, {
            type: "task-assign",
            data: { taskId: task.id, type, payload: task.payload }
        }, { timeout: 8000, headers: HEADERS })

        ctx.log("info", "task-assigned", { taskId: task.id, type, worker: target.display })
        return { status: 202, body: { type: "task-assigned", data: publicTask(task) } }

    } catch (error) {
        const detail = error.response?.data?.data?.message || error.response?.data?.error || error.message

        task.status = "error"
        task.error = `El worker no acepto la tarea: ${detail}`
        task.finishedAt = Date.now()

        ctx.log("error", "task-assign-failed", { taskId: task.id, worker: target.display, error: detail })
        return { status: 502, body: { type: "error", data: { message: task.error, task: publicTask(task) } } }
    }
}

function publicTask(task) {
    return {
        taskId: task.id,
        type: task.type,
        payload: task.payload,
        worker: task.worker,
        assignedBy: task.assignedBy,
        status: task.status,
        result: task.result,
        error: task.error,
        createdAt: task.createdAt,
        finishedAt: task.finishedAt,
        ms: task.finishedAt ? task.finishedAt - task.createdAt : null,
        orphan: Boolean(task.orphan)
    }
}

/* ---------------------------------------------------------------- rutas -- */

function install(ctx) {
    const { app, registry, rejectIfNotLeader, log, engine, computeStatus } = ctx
    module.exports.log = log

    // Resultado de una tarea: lo llama el worker a SU lider al terminar.
    app.post("/task/receive", (req, res) => {
        if (rejectIfNotLeader(req, res)) return

        const d = unwrap(req.body)
        const taskId = d.taskId
        const status = d.status

        if (!taskId || typeof taskId !== "string") {
            return res.status(400).json({ type: "error", data: { message: "taskId es obligatorio" } })
        }
        if (status !== "ok" && status !== "error") {
            return res.status(400).json({ type: "error", data: { message: "status debe ser 'ok' o 'error'" } })
        }

        let task = tasks.get(taskId)

        // Puede llegar el resultado de una tarea asignada por el lider anterior
        // (failover): se guarda igual para no perderlo.
        if (!task) {
            task = remember({
                id: taskId,
                type: d.taskType || "desconocida",
                payload: null,
                worker: d.workerId || "desconocido",
                workerUrl: null,
                assignedBy: "otro coordinador",
                status: "pending",
                createdAt: Date.now(),
                orphan: true
            })
        }

        task.status = status
        task.finishedAt = Date.now()
        task.result = status === "ok" ? (d.result === undefined ? {} : d.result) : null
        task.error = status === "error" ? String(d.error || "error sin detalle") : null
        if (d.workerId) task.worker = d.workerId

        log(status === "ok" ? "success" : "warn", "task-result", { taskId, status, worker: task.worker })
        res.json({ type: "task-received", data: { taskId } })
    })

    // Enviar una tarea (lo usa el panel; tambien sirve con curl).
    app.post("/tasks", async (req, res) => {
        if (rejectIfNotLeader(req, res)) return

        const b = unwrap(req.body)
        const type = b.type
        if (!type || typeof type !== "string") {
            return res.status(400).json({ type: "error", data: { message: "type (capacidad) es obligatorio" } })
        }
        if (b.payload !== undefined && (typeof b.payload !== "object" || b.payload === null)) {
            return res.status(400).json({ type: "error", data: { message: "payload debe ser un objeto JSON" } })
        }

        const out = await assign(ctx, { type, payload: b.payload, worker: b.worker })
        res.status(out.status).json(out.body)
    })

    app.get("/tasks", (req, res) => {
        const list = [...tasks.values()].reverse().map(publicTask)
        res.json({
            leader: engine.isLeader(),
            leaderUrl: engine.leaderUrl(),
            pending: list.filter(t => t.status === "pending").length,
            tasks: list
        })
    })

    app.get("/tasks/capabilities", (req, res) => {
        const byType = new Map()

        for (const entry of registry.values()) {
            const alive = computeStatus(entry) === "ALIVE"

            for (const cap of entry.capabilities || []) {
                if (!byType.has(cap.type)) byType.set(cap.type, { ...cap, workers: [] })
                byType.get(cap.type).workers.push({ name: entry.display, alive, load: entry.load ?? null })
            }
        }

        res.json([...byType.values()])
    })

    app.post("/tasks/capabilities/refresh", async (req, res) => {
        if (rejectIfNotLeader(req, res)) return
        await Promise.all([...registry.values()].map(entry => refreshCapabilities(entry)))
        res.json({ ok: true, workers: registry.size })
    })

    // "Agregar worker": el coordinador no puede registrar a un worker a la
    // fuerza (el registro lo inicia el worker), asi que se lo pide: le manda su
    // URL para que se conecte solo.
    app.post("/tasks/workers", async (req, res) => {
        if (rejectIfNotLeader(req, res)) return

        const url = clean(req.body?.url)
        if (!/^https?:\/\//.test(url)) return res.status(400).json({ type: "error", data: { message: "URL del worker invalida" } })

        try {
            const { data } = await axios.post(`${url}/coordinators`, { url: engine.state.url }, { timeout: 8000, headers: HEADERS })
            log("info", "worker-invited", { url })
            res.json({ ok: true, worker: url, response: data })
        } catch (error) {
            const detail = error.response?.data?.error || error.message
            res.status(502).json({ type: "error", data: { message: `No pude pedirle al worker que se conecte: ${detail}` } })
        }
    })

    // Barrido: una tarea no puede quedar "pending" para siempre.
    setInterval(() => {
        const now = Date.now()

        tasks.forEach(task => {
            if (task.status !== "pending") return

            const entry = [...registry.values()].find(e => e.display === task.worker)
            const dead = !entry || computeStatus(entry) === "DEAD"

            if (dead || now - task.createdAt > TASK_TIMEOUT_MS) {
                task.status = "error"
                task.error = dead ? `El worker ${task.worker} se cayo antes de responder` : `Sin respuesta tras ${Math.round(TASK_TIMEOUT_MS / 1000)}s`
                task.finishedAt = now
                log("warn", "task-timeout", { taskId: task.id, worker: task.worker })
            }
        })
    }, 5000).unref()
}

module.exports = { install, onRegister, refreshCapabilities, normalizeCapabilities, KNOWN, log: () => {} }
