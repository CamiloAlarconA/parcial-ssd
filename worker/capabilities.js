// ============================================================================
// CAPACIDADES DEL WORKER
//
// GET /task/capabilities usa un contrato estandarizado:
//
// {
//   "worker": "worker-juan-55223042",
//   "capabilities": ["vector_distance", "http_latency", "text_stats"],
//   "schemas": {
//      "vector_distance": {
//         "description": "...",
//         "payload": { ...ejemplo... },
//         "expectedResult": { ...resultado esperado... }
//      }
//   }
// }
//
// El campo "payload" dentro de schemas es un EJEMPLO ejecutable, no una
// descripcion de tipos. Esto permite que cualquier Coordinator construya
// el formulario de tareas sin conocer el codigo interno del Worker.
// ============================================================================

const isString = v => typeof v === "string"

const CAPABILITIES = {
    search_text: {
        description: "Cuenta cuantas veces aparece el query dentro del texto (sin solaparse)",
        payload: { text: "hola mundo hola", query: "hola", ignoreCase: false },
        expectedResult: { count: 2 },

        run({ text, query, ignoreCase }) {
            if (!isString(text)) throw new Error("'text' debe ser un string")
            if (!isString(query) || query.length === 0) throw new Error("'query' debe ser un string no vacio")

            const haystack = ignoreCase ? text.toLowerCase() : text
            const needle = ignoreCase ? query.toLowerCase() : query

            let count = 0
            let from = 0
            while (true) {
                const at = haystack.indexOf(needle, from)
                if (at === -1) break
                count++
                from = at + needle.length
            }
            return { count }
        }
    },

    stats_compute: {
        description: "Promedio, minimo y maximo de una lista de numeros",
        payload: { numbers: [1, 2, 3, 4, 5] },
        expectedResult: { mean: 3, min: 1, max: 5 },

        run({ numbers }) {
            if (!Array.isArray(numbers) || numbers.length === 0) {
                throw new Error("'numbers' debe ser una lista con al menos un numero")
            }
            const list = numbers.map(n => (typeof n === "string" && n.trim() !== "" ? Number(n) : n))
            if (!list.every(n => typeof n === "number" && Number.isFinite(n))) {
                throw new Error("'numbers' solo puede contener numeros")
            }
            const sum = list.reduce((acc, n) => acc + n, 0)
            return { mean: sum / list.length, min: Math.min(...list), max: Math.max(...list) }
        }
    },

    text_transform: {
        description: "Transforma un texto: upper, lower, reverse o capitalize",
        payload: { text: "hola mundo", operation: "upper" },
        expectedResult: { result: "HOLA MUNDO" },

        run({ text, operation }) {
            if (!isString(text)) throw new Error("'text' debe ser un string")
            switch (operation) {
                case "upper": return { result: text.toUpperCase() }
                case "lower": return { result: text.toLowerCase() }
                case "reverse": return { result: [...text].reverse().join("") }
                case "capitalize": return { result: text.replace(/\b\p{L}/gu, c => c.toUpperCase()) }
                default: throw new Error("'operation' debe ser upper, lower, reverse o capitalize")
            }
        }
    }
}

const names = () => Object.keys(CAPABILITIES)
const has = type => Object.prototype.hasOwnProperty.call(CAPABILITIES, type)

function describe(workerId) {
    const schemas = {}
    for (const type of names()) {
        const { description, payload, expectedResult } = CAPABILITIES[type]
        schemas[type] = { description, payload, expectedResult }
    }

    return {
        worker: workerId || null,
        capabilities: names(),
        schemas
    }
}

async function execute(type, payload) {
    if (!has(type)) throw new Error(`Capacidad no soportada: ${type}`)
    if (payload === null || typeof payload !== "object") throw new Error("payload debe ser un objeto")
    return CAPABILITIES[type].run(payload)
}

module.exports = { names, has, describe, execute }
