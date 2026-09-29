// ============================================================================
// COORDINADOR - punto de entrada del parcial
//
//   node index.js {PUERTO} {URL_NGROK}
//   Ej: node index.js 3000 https://nombre-random-ngrok.dev
//
// El ID sale de identity.js (coordinator-{nombre}-{codigo}). Todo lo demas
// (coordinadores, workers, tareas) se maneja desde el panel web.
// ============================================================================
const identity = require("./identity")

const [port, url, ...extra] = process.argv.slice(2)

if (!port || Number.isNaN(Number(port))) {
    console.error("\n  Uso: node index.js {PUERTO} {URL_NGROK}")
    console.error("  Ej.: node index.js 3000 https://nombre-random-ngrok.dev\n")
    process.exit(1)
}

// server.js lee: argv[2]=puerto, argv[3]=id, argv[4]=peers (opcional)
process.argv = [process.argv[0], process.argv[1], port, identity.id, extra.join(",")]

if (url) process.env.PUBLIC_URL = url.replace(/\/+$/, "")
else console.warn("  (sin URL_NGROK: me anuncio como localhost, solo sirve para pruebas locales)")

console.log(`  ID: ${identity.id}`)

require("./server")
