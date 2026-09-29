// ============================================================================
// IDENTIDAD DE ESTE COORDINADOR  ->  coordinator-{nombre}-{codigo}
// ----------------------------------------------------------------------------
// EDITA estas dos lineas (o usa las variables de entorno NOMBRE y CODIGO).
// Ejemplo del PDF: coordinator-jose-55217003
// ============================================================================
const NOMBRE = process.env.NOMBRE || "Camilo"
const CODIGO = process.env.CODIGO || "55223013"

if (!/^[a-z0-9]+$/i.test(CODIGO) || CODIGO === "TU_CODIGO") {
    console.error("\n  Falta tu codigo estudiantil. Abre identity.js y cambia CODIGO")
    console.error("  (o ejecuta con CODIGO=55217003 node index.js 3000 https://tu-url.ngrok-free.dev)\n")
    process.exit(1)
}

const id = `coordinator-${String(NOMBRE).trim().toLowerCase()}-${CODIGO}`

module.exports = { NOMBRE, CODIGO, id }
