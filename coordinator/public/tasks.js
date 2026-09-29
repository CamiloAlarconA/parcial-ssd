// Panel de workers y tareas del coordinador.
// Muestra workers (estado, carga, capacidades), permite enviar tareas a mano
// con un formulario que se arma solo desde el ejemplo/esquema de cada
// capacidad, y lista los resultados.
(function () {
  const root = document.getElementById("tasks-root")
  const leaderTag = document.getElementById("task-leader")
  if (!root) return

  const state = { workers: [], tasks: [], caps: [], election: null, selectedType: "", selectedWorker: "" }
  let formKey = ""

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") node.className = v
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v)
      else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v)
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue
      node.append(c.nodeType ? c : document.createTextNode(String(c)))
    }
    return node
  }

  async function api(path, options) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
      ...options
    })
    let body = null
    try { body = await res.json() } catch { /* sin cuerpo */ }
    return { ok: res.ok, status: res.status, body }
  }

  const pretty = v => (v === null || v === undefined ? "" : JSON.stringify(v))

  /* ------------------------------------------------------------- datos -- */

  async function refresh() {
    try {
      const [servers, tasks, caps, election] = await Promise.all([
        api("/servers"), api("/tasks"), api("/tasks/capabilities"), api("/election/state")
      ])
      state.workers = servers.body || []
      state.tasks = (tasks.body && tasks.body.tasks) || []
      state.caps = caps.body || []
      state.election = election.body || null
    } catch { /* se reintenta en el siguiente ciclo */ }
    render()
  }

  /* ---------------------------------------------------------- formulario -- */

  // Campos del formulario: salen del ejemplo de la capacidad. Un campo con
  // "a | b" en el esquema se convierte en lista desplegable.
  function fieldsOf(cap) {
    if (!cap || !cap.example || typeof cap.example !== "object") return null
    const schema = cap.payload && typeof cap.payload === "object" ? cap.payload : {}

    return Object.entries(cap.example).map(([name, example]) => {
      const hint = typeof schema[name] === "string" ? schema[name] : ""
      const options = hint.includes("|") ? hint.split("|").map(x => x.trim()).filter(Boolean) : null
      return { name, example, hint, options, kind: Array.isArray(example) ? "list" : typeof example }
    })
  }

  function readValue(field, raw) {
    if (field.kind === "number") {
      const n = Number(raw)
      if (raw === "" || Number.isNaN(n)) throw new Error(`'${field.name}' debe ser un numero`)
      return n
    }
    if (field.kind === "list") {
      const parts = raw.split(",").map(x => x.trim()).filter(x => x !== "")
      const nums = parts.map(Number)
      return nums.every(n => !Number.isNaN(n)) ? nums : parts
    }
    return raw
  }

  function buildPayload(cap, form, advanced) {
    if (advanced) return JSON.parse(form.querySelector("[name=__json]").value || "{}")

    const payload = {}
    for (const f of fieldsOf(cap) || []) {
      payload[f.name] = readValue(f, form.querySelector(`[data-field="${f.name}"]`).value)
    }
    return payload
  }

  /* -------------------------------------------------------------- vistas -- */

  function workersTable() {
    if (!state.workers.length) {
      return h("p", { class: "help" }, "Ningún worker conectado a este coordinador todavía.")
    }

    return h("table", { class: "task-table" },
      h("thead", {}, h("tr", {}, ["Worker", "Estado", "Carga", "Capacidades", "URL"].map(t => h("th", {}, t)))),
      h("tbody", {}, state.workers.map(w => h("tr", {},
        h("td", {}, w.name),
        h("td", {}, w.status),
        h("td", {}, w.load === null ? "–" : `${Math.round(w.load * 100)}%`),
        h("td", {}, (w.capabilities || []).map(c => c.type).join(", ") || "sin leer"),
        h("td", {}, w.url)
      )))
    )
  }

  function sendForm() {
    const types = [...new Set(state.caps.map(c => c.type))]
    if (!state.selectedType || !types.includes(state.selectedType)) state.selectedType = types[0] || ""

    const cap = state.caps.find(c => c.type === state.selectedType)
    const fields = fieldsOf(cap)

    const workerSelect = h("select", { name: "worker", onchange: e => { state.selectedWorker = e.target.value } },
      h("option", { value: "" }, "Automático (menor carga)"),
      state.workers.map(w => h("option", { value: w.name, selected: w.name === state.selectedWorker }, w.name))
    )

    const typeSelect = h("select", {
      name: "type",
      onchange: e => { state.selectedType = e.target.value; formKey = ""; render() }
    }, types.map(t => h("option", { value: t, selected: t === state.selectedType }, t)))

    const inputs = fields
      ? fields.map(f => h("div", { class: "field" },
        h("label", {}, f.name, f.hint ? ` · ${f.hint}` : ""),
        f.options
          ? h("select", { "data-field": f.name }, f.options.map(o => h("option", { value: o, selected: o === f.example }, o)))
          : h("input", { "data-field": f.name, type: "text", value: f.kind === "list" ? f.example.join(",") : String(f.example) })
      ))
      : []

    const advanced = h("input", { type: "checkbox", name: "__advanced", onchange: () => toggleAdvanced() })
    const json = h("textarea", { name: "__json", rows: "4", style: "display:none;width:100%", spellcheck: "false" },
      JSON.stringify((cap && cap.example) || {}, null, 2))

    const result = h("p", { id: "task-send-result", class: "help" })

    const form = h("form", {
      onsubmit: async e => {
        e.preventDefault()
        try {
          const payload = buildPayload(cap, form, advanced.checked)
          const r = await api("/tasks", {
            method: "POST",
            body: JSON.stringify({ type: state.selectedType, payload, worker: workerSelect.value || undefined })
          })
          const msg = r.body && r.body.data && r.body.data.message
          result.textContent = r.ok ? `Tarea enviada: ${r.body.data.taskId} → ${r.body.data.worker}` : `Error ${r.status}: ${msg || (r.body && r.body.error) || "no se pudo enviar"}`
          if (r.status === 409 && r.body && r.body.data && r.body.data.leaderUrl) result.textContent += ` (el líder es ${r.body.data.leaderUrl})`
          refresh()
        } catch (err) {
          result.textContent = err.message
        }
      }
    },
      h("div", { class: "field" }, h("label", {}, "Worker"), workerSelect),
      h("div", { class: "field" }, h("label", {}, "Capacidad"), typeSelect),
      cap && cap.description ? h("p", { class: "help" }, cap.description) : null,
      inputs,
      h("label", { class: "help" }, advanced, " Editar payload como JSON"),
      json,
      h("button", { type: "submit", class: "btn btn-primary", disabled: types.length ? false : "disabled" }, "Enviar tarea"),
      result
    )

    function toggleAdvanced() {
      json.style.display = advanced.checked ? "block" : "none"
      form.querySelectorAll("[data-field]").forEach(i => { i.closest(".field").style.display = advanced.checked ? "none" : "" })
    }

    return form
  }

  function tasksTable() {
    if (!state.tasks.length) return h("p", { class: "help" }, "Todavía no se ha enviado ninguna tarea.")

    return h("table", { class: "task-table" },
      h("thead", {}, h("tr", {}, ["Tarea", "Tipo", "Worker", "Estado", "Payload", "Resultado / error", "ms"].map(t => h("th", {}, t)))),
      h("tbody", {}, state.tasks.slice(0, 30).map(t => h("tr", {},
        h("td", {}, t.taskId),
        h("td", {}, t.type),
        h("td", {}, t.worker),
        h("td", {}, t.status + (t.orphan ? " (de otro líder)" : "")),
        h("td", {}, pretty(t.payload)),
        h("td", {}, t.status === "error" ? (t.error || "") : pretty(t.result)),
        h("td", {}, t.ms === null ? "…" : t.ms)
      )))
    )
  }

  function inviteForm() {
    const input = h("input", { type: "text", placeholder: "https://url-del-worker.ngrok-free.dev", style: "flex:1" })
    const out = h("p", { class: "help" })

    return h("form", {
      onsubmit: async e => {
        e.preventDefault()
        const r = await api("/tasks/workers", { method: "POST", body: JSON.stringify({ url: input.value }) })
        out.textContent = r.ok ? "Le pedí al worker que se conecte; aparecerá en la tabla." : ((r.body && r.body.data && r.body.data.message) || "No se pudo")
        input.value = ""
        setTimeout(refresh, 1500)
      }
    },
      h("div", { class: "field-row" }, input, h("button", { type: "submit", class: "btn btn-ghost btn-sm" }, "Agregar worker")),
      h("p", { class: "help" }, "Le pide a un worker (el nuestro) que se conecte a este coordinador. Los workers también pueden apuntar aquí desde su propio panel."),
      out
    )
  }

  /* --------------------------------------------------------------- render -- */

  function render() {
    const el = state.election
    const isLeader = el && el.role === "leader"

    leaderTag.textContent = !el ? "…" : isLeader ? "soy el líder" : `líder: ${el.leader || "ninguno"}`

    // No se vuelve a dibujar el formulario mientras se escribe en el.
    const active = document.activeElement
    const typing = active && root.contains(active) && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)

    const key = JSON.stringify([state.workers.map(w => [w.name, w.status, w.load, (w.capabilities || []).length]), state.tasks.map(t => [t.taskId, t.status]), state.caps.map(c => c.type), isLeader])
    if (typing && key === formKey) return
    if (typing) { formKey = key; return }
    if (key === formKey) return
    formKey = key

    const banner = el && !isLeader
      ? h("p", { class: "help" }, `Este coordinador es backup: los workers y las tareas viven en el líder${el.leaderUrl ? ` (${el.leaderUrl})` : ""}.`)
      : null

    root.replaceChildren(
      banner,
      h("h3", {}, "Workers"),
      workersTable(),
      h("div", { class: "field-row" },
        h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: async () => { await api("/tasks/capabilities/refresh", { method: "POST", body: "{}" }); refresh() } }, "Actualizar capacidades")
      ),
      inviteForm(),
      h("h3", {}, "Enviar tarea"),
      sendForm(),
      h("h3", {}, "Tareas"),
      tasksTable()
    )
  }

  refresh()
  setInterval(refresh, 2000)
})()
