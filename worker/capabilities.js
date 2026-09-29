// ============================================================================
// CAPACIDADES DEL WORKER  (grupo G4: capacidades 3 y 4 + una propia)
//
//   3. search_text     -> cuenta cuantas veces aparece "query" en "text"
//   4. stats_compute   -> promedio, minimo y maximo de una lista de numeros
//   +  text_transform  -> (propuesta nuestra) upper | lower | reverse | capitalize
//
// Cada capacidad declara COMO debe llegar el payload (payload + example) y que
// devuelve (result): eso es lo que se publica en GET /task/capabilities para
// que cualquier coordinador arme la tarea sin conocerla de antemano.
// ============================================================================

const isString = v => typeof v === "string"

const CAPABILITIES = {
    search_text: {
        description: "Cuenta cuantas veces aparece el query dentro del texto (sin solaparse)",
        payload: { text: "string", query: "string (no vacio)", ignoreCase: "boolean (opcional, por defecto false)" },
        example: { text: "hola mundo hola", query: "hola" },
        result: { count: "number" },

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
        payload: { numbers: "number[] (al menos un numero)" },
        example: { numbers: [1, 2, 3, 4, 5] },
        result: { mean: "number", min: "number", max: "number" },

        run({ numbers }) {
            if (!Array.isArray(numbers) || numbers.length === 0) throw new Error("'numbers' debe ser una lista con al menos un numero")

            const list = numbers.map(n => (typeof n === "string" && n.trim() !== "" ? Number(n) : n))
            if (!list.every(n => typeof n === "number" && Number.isFinite(n))) throw new Error("'numbers' solo puede contener numeros")

            const sum = list.reduce((acc, n) => acc + n, 0)

            return { mean: sum / list.length, min: Math.min(...list), max: Math.max(...list) }
        }
    },

    text_transform: {
        description: "Transforma un texto: upper, lower, reverse o capitalize",
        payload: { text: "string", operation: "upper | lower | reverse | capitalize" },
        example: { text: "hola mundo", operation: "upper" },
        result: { result: "string" },

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

// Lo que se publica en GET /task/capabilities
function describe() {
    return names().map(type => {
        const { description, payload, example, result } = CAPABILITIES[type]
        return { type, description, payload, example, result }
    })
}

async function execute(type, payload) {
    if (!has(type)) throw new Error(`Capacidad no soportada: ${type}`)
    if (payload === null || typeof payload !== "object") throw new Error("payload debe ser un objeto")
    return CAPABILITIES[type].run(payload)
}

module.exports = { names, has, describe, execute }
