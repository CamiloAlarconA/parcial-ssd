# Parcial Sistemas Distribuidos — Coordinador / Worker

Dos proyectos independientes (cada uno con su `package.json` e `index.js`):

    coordinator/   -> tu server.js de siempre (Bully, registro, pulsos) + tareas
    worker/        -> tu miniserver.js + /task/assign, /task/capabilities y 3 capacidades

## 1. Configura tu identidad (una vez por proyecto, en cada PC)

Edita `identity.js` en `coordinator/` y en `worker/`: pon tu NOMBRE y tu CODIGO.
El ID queda `coordinator-{nombre}-{codigo}` / `worker-{nombre}-{codigo}`.
Tambien se puede con variables de entorno: `CODIGO=55217003 node index.js ...`

## 2. Arranque (unico comando, como pide el PDF)

    cd coordinator && npm install && node index.js 3000 https://tu-url-ngrok.dev
    cd worker      && npm install && node index.js 4000 https://otra-url-ngrok.dev

Coordinador y worker son servicios distintos: puertos y URLs de ngrok distintos.
Todo lo demas se hace desde el panel web:

- Coordinador: `http://localhost:3000` (workers, carga, capacidades, enviar tareas)
  y `/election.html` (peers, lider, particiones) para agregar coordinadores.
- Worker: `http://localhost:4000` (agregar coordinadores, lag por tarea, tareas recibidas).

## 3. Endpoints de tareas (como en el correo)

| Endpoint | Donde vive | Quien lo llama |
|---|---|---|
| `POST /task/assign` | Worker | El coordinador lider |
| `POST /task/receive` | Coordinador | El worker, a su lider, al terminar |
| `GET /task/capabilities` | Worker | El coordinador, al registrarse el worker |

Cuerpos (formato `{ type, data }` del PDF):

    POST /task/assign   { "type":"task-assign", "data":{ "taskId":"task-1", "type":"search_text", "payload":{ "text":"hola mundo hola", "query":"hola" } } }
    POST /task/receive  { "type":"task-result", "data":{ "taskId":"task-1", "status":"ok", "result":{ "count":2 } } }
    POST /task/receive  { "type":"task-result", "data":{ "taskId":"task-1", "status":"error", "error":"..." } }
    GET  /task/capabilities -> { "type":"capabilities", "data":{ "id":"worker-...", "capabilities":[ { "type", "description", "payload", "example", "result" } ] } }

El worker responde 202 al asignar y devuelve el resultado despues (lag configurable:
`TASK_DELAY_MS` o el campo del panel / `POST /config/delay {"ms":3000}`).

## 4. Que hace el coordinador con las capacidades

No tiene ninguna cableada: lee `GET /task/capabilities` de cada worker, guarda tipo, payload y
ejemplo, y arma el formulario del panel a partir de ahi. Al enviar una tarea elige, entre los
workers vivos que declaran esa capacidad, el de menor `load` (el worker manda `load` en cada pulso).
El catalogo de las 6 capacidades del PDF solo rellena ejemplo/esquema si un worker no lo trae.

## 5. Capacidades de este worker (G4)

- `search_text` (3): cuenta apariciones de `query` en `text` (sensible a mayusculas; `ignoreCase:true` opcional)
- `stats_compute` (4): `{mean, min, max}` de `numbers`
- `text_transform` (propia): `upper | lower | reverse | capitalize` -> `{result}`

## 6. Cambios respecto a tu repo

- Coordinador: `index.js`, `identity.js`, `tasks.js`, `public/tasks.js` nuevos; `server.js` con parches minimos
  (ID sin forzar mayusculas, `load` y capacidades en registro/pulso, `redirect` en el 409 de "no soy lider",
  pulse timeout 8s); `election/timing.js` con ping timeout 5s (tiempos del PDF).
- Worker: reescrito desde `miniserver.js` (mismo registro/pulso/busqueda de lider) con carga en el pulso,
  cola de resultados que reintenta si el lider cambia, y panel propio.
- Quedan fuera `miniserver.js`, `scripts/` y los `npm run hijoN` (ya no aplican con dos proyectos).
