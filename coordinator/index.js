// ============================================================================
// COORDINADOR - punto de entrada del parcial
//
// El ID NO se genera en codigo ni se pide por consola.
// Se configura desde la interfaz web del coordinador: http://localhost:{PUERTO}
// ============================================================================

const [port, url, ...extra] = process.argv.slice(2)

if (!port || Number.isNaN(Number(port))) {
    console.error("\n  Uso: node index.js {PUERTO} {URL_NGROK}")
    console.error("  Ej.: node index.js 3000 https://nombre-random-ngrok.dev\n")
    process.exit(1)
}

// server.js lee: argv[2]=puerto, argv[3]=id, argv[4]=peers.
// No enviamos argv[3]: el ID se elige exclusivamente desde el panel.
process.argv = [process.argv[0], process.argv[1], port, "", extra.join(",")]

if (url) process.env.PUBLIC_URL = url.replace(/\/+$/, "")
else console.warn("  (sin URL_NGROK: me anuncio como localhost, solo sirve para pruebas locales)")

require("./server")
