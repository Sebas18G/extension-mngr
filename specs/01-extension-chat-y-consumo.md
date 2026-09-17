# SPEC 01 — Extensión de VS Code con chat LLM, sesiones en Postgres y consumo de tokens

> **Estado:** Aprobado
> **Depende de:** —
> **Fecha:** 2026-09-16
> **Objetivo:** Construir una extensión instalable de VS Code con un panel lateral de chat contra un endpoint compatible con OpenAI, que persista cada sesión en un schema propio de Postgres y muestre los tokens consumidos por sesión.

---

## 1. Por qué existe esta spec

Es la primera spec del repositorio: no hay código previo, ni convenciones, ni `CLAUDE.md`. Esta spec fija tres decisiones estructurales que condicionan todo lo que venga después:

1. La extensión habla con un **endpoint HTTP genérico compatible con OpenAI**, no con un SDK propietario. Esto permite apuntar a OpenAI, OpenRouter, Ollama o un gateway propio sin recompilar.
2. La persistencia **no** vive en `globalState` ni en archivos JSON: vive en el Postgres local del usuario, en un schema propio. La extensión es un cliente de esa base, no su dueña exclusiva.
3. El alcance se corta deliberadamente en la base funcional. Tool use, contexto automático del workspace, costo en USD y gráficas se mencionaron en la conversación y quedan fuera a propósito.

---

## 2. Alcance

**Entra:**

- Extensión de VS Code en TypeScript, empaquetable como `.vsix` e instalable localmente.
- Panel propio en la Activity Bar con icono dedicado, que contiene tres vistas: lista de sesiones, chat activo y consumo.
- Chat contra un endpoint compatible con OpenAI (`POST {baseUrl}/chat/completions`) con respuesta en **streaming** token a token.
- API key y cadena de conexión a Postgres leídas del archivo `.env` en la raíz del workspace abierto (`LLM_API_KEY`, `POSTGRES_URL`).
- Schema propio `vscode_chat` en Postgres, creado por la propia extensión al activarse, de forma idempotente.
- Script DDL versionado en el repositorio (`db/001_init.sql`), que es la misma sentencia que ejecuta la extensión.
- Persistencia de sesiones y mensajes: crear sesión, listar sesiones, abrir y leer una sesión pasada.
- Registro de tokens por respuesta (`prompt_tokens`, `completion_tokens`, `total_tokens`) y agregado por sesión.
- Estado de error visible y explícito cuando Postgres no responde: el chat se bloquea en lugar de perder datos en silencio.
- Comandos en la paleta: probar conexión, nueva sesión.

**Fuera de alcance (para specs futuras):**

- Tool use / function calling: que el modelo lea archivos o ejecute acciones.
- Contexto automático del workspace: adjuntar el archivo abierto o la selección al prompt.
- Costo estimado en USD y tabla de precios por modelo.
- Gráficas y series temporales de consumo.
- Publicación en el Marketplace de VS Code. Esta spec llega hasta el `.vsix` local.
- Borrado y exportación de sesiones a markdown.
- Búsqueda dentro del historial de sesiones.
- Renombrar sesiones manualmente (el título se deriva automáticamente).
- Migraciones versionadas más allá de `001_init.sql`.
- Multi-proveedor con SDKs específicos (Anthropic Messages API, etc.).

---

## 3. Modelo de datos

### 3.1 Schema de Postgres

Todo vive bajo el schema `vscode_chat`. La extensión nunca escribe en `public`.

```sql
CREATE SCHEMA IF NOT EXISTS vscode_chat;

CREATE TABLE IF NOT EXISTS vscode_chat.sessions (
  id          uuid PRIMARY KEY,
  title       text        NOT NULL,
  model       text        NOT NULL,
  base_url    text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vscode_chat.messages (
  id          bigserial   PRIMARY KEY,
  session_id  uuid        NOT NULL REFERENCES vscode_chat.sessions(id) ON DELETE CASCADE,
  role        text        NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
  content     text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_session_id_idx
  ON vscode_chat.messages (session_id, id);

CREATE TABLE IF NOT EXISTS vscode_chat.message_usage (
  message_id        bigint PRIMARY KEY REFERENCES vscode_chat.messages(id) ON DELETE CASCADE,
  prompt_tokens     integer,
  completion_tokens integer,
  total_tokens      integer,
  model             text NOT NULL
);
```

Convenciones:

- `sessions.id` es un `uuid` generado en el cliente (`crypto.randomUUID()`), no en la base. Así la extensión conoce el id antes del primer `INSERT`.
- `sessions.title` se deriva de los primeros 60 caracteres del primer mensaje del usuario. Si aún no hay mensaje, es `"Nueva sesión"`.
- `sessions.updated_at` se actualiza en cada `INSERT` de mensaje.
- Las columnas de `message_usage` son **nullable** a propósito: un endpoint compatible que no devuelva `usage` deja `NULL`, que significa "desconocido", nunca `0`.
- Solo las filas con `role = 'assistant'` tienen entrada en `message_usage`.
- El consumo por sesión no se almacena: se calcula con `SUM` sobre `message_usage` en el momento de consultar.

### 3.2 Configuración en `settings.json`

Ajustes no sensibles, bajo el prefijo `llmChat`:

```jsonc
{
  "llmChat.baseUrl": "https://api.openai.com/v1",
  "llmChat.model": "gpt-4o-mini",
  "llmChat.maxTokens": 4096,
  "llmChat.temperature": 0.7,
  "llmChat.systemPrompt": ""
}
```

### 3.3 Secretos en `.env` del workspace

Nunca en `settings.json`, nunca commiteados. Se leen del archivo `.env` en la raíz de la primera carpeta del workspace abierto, en cada uso (un cambio en `.env` aplica sin reiniciar). Dos variables:

- `LLM_API_KEY` → se envía como `Authorization: Bearer <key>`.
- `POSTGRES_URL` → cadena completa, p. ej. `postgresql://user:pass@localhost:5432/mydb`.

El repositorio incluye `.env.example` con ambas variables vacías; `.env` está en `.gitignore` y en `.vscodeignore`. Si no hay workspace abierto, no existe `.env` o falta una variable, la extensión lo informa con un error explícito que nombra el archivo y la variable.

### 3.4 Protocolo webview ↔ extensión

Mensajes tipados que cruzan el `postMessage` del webview. Un único tipo discriminado por `type`:

```ts
// webview → extensión
type ToHost =
  | { type: 'send'; text: string }
  | { type: 'newSession' }
  | { type: 'openSession'; sessionId: string }
  | { type: 'listSessions' }
  | { type: 'cancel' }   // botón de cancelar el stream (paso 8)
  | { type: 'retry' };   // botón "Reintentar" del estado degradado (paso 12)

// extensión → webview
type ToWebview =
  | { type: 'sessions'; items: SessionSummary[] }
  | { type: 'sessionLoaded'; session: SessionDetail }
  | { type: 'delta'; text: string }
  | { type: 'done'; usage: Usage | null }
  | { type: 'error'; message: string }
  | { type: 'dbStatus'; ok: boolean; message?: string };
```

---

## 4. Plan de implementación

Cada paso deja el repositorio en estado compilable y ejecutable con F5 (Extension Development Host).

1. **Esqueleto de la extensión.** Crear `package.json` con el manifest mínimo (`engines.vscode`, `main`, `activationEvents`), `tsconfig.json`, `.vscodeignore`, `.gitignore` y `esbuild.js`. Añadir `src/extension.ts` con `activate()` que solo registra un comando `llmChat.testConnection` que muestra un `showInformationMessage`. Prueba manual: F5, ejecutar el comando desde la paleta, ver el mensaje.

2. **Panel lateral vacío.** Declarar en `package.json` el `viewsContainers.activitybar` con id `llmChat` y la vista `llmChat.chatView` de tipo `webview`. Implementar `src/panel/ChatViewProvider.ts` con un `resolveWebviewView` que sirve HTML estático. Crear `media/main.css` y `media/main.js`. Prueba manual: aparece el icono en la barra lateral y abre un panel con texto placeholder.

3. **Gestión de secretos.** Añadir `src/config/env.ts` con `getApiKey` y `getPostgresUrl`, que leen `LLM_API_KEY` y `POSTGRES_URL` del `.env` en la raíz del workspace abierto. Añadir `.env.example` y excluir `.env` en `.gitignore` y `.vscodeignore`. Prueba manual: rellenar `.env`, abrir la carpeta en VS Code y comprobar que la extensión usa esos valores. *(Revisado tras el paso 13: sustituye a `SecretStorage` y a los comandos `setApiKey`/`setPostgresUrl`.)*

4. **Conexión a Postgres.** Añadir la dependencia `pg`. Crear `src/db/pool.ts` que construye un `Pool` a partir de `POSTGRES_URL` del `.env` y expone `getPool()` y `healthCheck()`. Reescribir `llmChat.testConnection` para ejecutar `SELECT 1` y reportar éxito o el error real. Prueba manual: con Postgres arriba, el comando dice OK; con Postgres apagado, muestra el error de conexión.

5. **Creación del schema.** Escribir `db/001_init.sql` con el DDL de la sección 3.1. Crear `src/db/schema.ts` que lee ese archivo desde el bundle y lo ejecuta en una transacción durante la activación, después de que haya cadena de conexión. Prueba manual: activar la extensión y verificar con `\dt vscode_chat.*` en psql que existen las tres tablas; ejecutar dos veces y comprobar que no falla.

6. **Repositorio de sesiones.** Crear `src/db/sessions.ts` con `createSession`, `listSessions`, `getSession`, `appendMessage`, `saveUsage` y `getSessionUsage`. Sin UI todavía: se prueba desde el comando `llmChat.testConnection` ampliado temporalmente o desde un comando oculto. Prueba manual: crear una sesión y un mensaje, verlos en psql.

7. **Cliente LLM con streaming.** Crear `src/llm/client.ts` con `streamChat(messages, opts, onDelta): Promise<Usage | null>`. Usa `fetch` nativo contra `{baseUrl}/chat/completions` con `stream: true` y `stream_options: { include_usage: true }`, parsea el SSE línea a línea, invoca `onDelta` por cada `choices[0].delta.content` y devuelve el `usage` del chunk final (o `null` si no llega). Soporta cancelación con `AbortController`. Prueba manual: comando temporal que hace streaming a la consola de depuración.

8. **UI del chat.** Conectar el webview: input de texto, envío con Enter, burbujas por rol, y renderizado incremental de los `delta`. El panel muestra un indicador mientras streamea y un botón de cancelar. Prueba manual: escribir un mensaje y ver la respuesta aparecer progresivamente.

9. **Persistencia del turno completo.** Al enviar: `INSERT` del mensaje `user`; al terminar el stream: `INSERT` del mensaje `assistant` y su fila en `message_usage`; actualizar `sessions.updated_at`. Si no hay sesión activa, crear una y derivar el título del primer mensaje. Prueba manual: conversar, recargar la ventana y comprobar en psql que todo quedó guardado.

10. **Lista de sesiones e historial.** Vista superior del panel con las sesiones ordenadas por `updated_at DESC`, mostrando título, fecha y total de tokens. Al hacer clic, carga los mensajes de esa sesión en el chat y continúa la conversación sobre ella. Botón "Nueva sesión". Prueba manual: crear dos sesiones, alternar entre ellas, verificar que cada una conserva su historial.

11. **Vista de consumo.** Sección que muestra, para la sesión activa, el `SUM` de `prompt_tokens`, `completion_tokens` y `total_tokens`, y el total global de todas las sesiones. Los valores `NULL` se muestran como `—`, no como `0`. Prueba manual: comparar los números contra un `SELECT SUM(...)` manual en psql.

12. **Estado degradado de Postgres.** Si `healthCheck()` falla en la activación o durante el uso, el webview recibe `dbStatus: { ok: false }`, muestra una banda de error con el mensaje y deshabilita el input de envío. Un botón "Reintentar" repite el health check. Prueba manual: apagar Postgres con el panel abierto, enviar un mensaje, ver el bloqueo; encenderlo y reintentar.

13. **Empaquetado.** Añadir `@vscode/vsce` como dependencia de desarrollo y el script `npm run package`. Completar `package.json` con `displayName`, `description`, `publisher`, `categories`, icono y `README.md` de la extensión. Prueba manual: generar el `.vsix`, instalarlo con `code --install-extension`, reiniciar VS Code y usar la extensión desde una instalación real.

---

## 5. Criterios de aceptación

- [ ] `npm run package` genera un `.vsix` sin errores.
- [ ] El `.vsix` se instala con `code --install-extension` y la extensión aparece en la lista de instaladas.
- [ ] Tras instalar, aparece un icono propio en la Activity Bar que abre el panel.
- [ ] Con un `.env` válido en la raíz del workspace, la extensión conecta a Postgres y al endpoint sin ejecutar ningún comando de configuración.
- [ ] La API key no aparece en `settings.json`; `.env` está en `.gitignore` y no se incluye en el `.vsix`.
- [ ] Sin `.env` o sin una de sus variables, el panel muestra un error que nombra el archivo y la variable que falta.
- [ ] El comando `llmChat.testConnection` devuelve OK con Postgres arriba y un mensaje de error con Postgres apagado.
- [ ] Tras la primera activación con conexión válida, existen en Postgres `vscode_chat.sessions`, `vscode_chat.messages` y `vscode_chat.message_usage`.
- [ ] Ejecutar la creación del schema dos veces seguidas no produce error.
- [ ] Enviar un mensaje muestra la respuesta apareciendo de forma incremental, no de golpe.
- [ ] El botón de cancelar detiene el stream y lo ya recibido queda guardado.
- [ ] Tras una conversación de dos turnos, `SELECT COUNT(*) FROM vscode_chat.messages` devuelve 4.
- [ ] Recargar la ventana de VS Code y reabrir la sesión muestra los mensajes anteriores.
- [ ] La lista de sesiones muestra todas las sesiones ordenadas de más reciente a más antigua.
- [ ] Hacer clic en una sesión pasada carga su historial y permite seguir conversando en ella.
- [ ] La vista de consumo de una sesión coincide con `SELECT SUM(total_tokens) FROM vscode_chat.message_usage u JOIN vscode_chat.messages m ON m.id = u.message_id WHERE m.session_id = '<id>'`.
- [ ] Si el endpoint no devuelve `usage`, la vista de consumo muestra `—` y no `0`.
- [ ] Con Postgres apagado, el panel muestra una banda de error y el input de envío queda deshabilitado.
- [ ] Cambiar `llmChat.baseUrl` y `llmChat.model` en `settings.json` afecta a la siguiente petición sin reiniciar VS Code.
- [ ] El archivo `db/001_init.sql` existe en el repositorio y su contenido es el mismo DDL que ejecuta la extensión.

---

## 6. Decisiones tomadas y descartadas

- **Sí:** endpoint genérico compatible con OpenAI (`/chat/completions`). Un solo formato de petición, streaming y `usage` sirve para OpenAI, OpenRouter, Ollama y gateways propios.
- **No:** SDK de Anthropic o multi-proveedor con dos SDKs. Duplicaba el trabajo de streaming y de conteo de tokens desde el primer día.
- **Sí (revisado tras el paso 13):** `.env` en la raíz del workspace para la API key y la cadena de Postgres. La extensión debe funcionar sin pasos manuales de configuración dentro de VS Code, y las credenciales quedan junto al proyecto, fuera de git.
- **No (revisado):** `SecretStorage` con comandos `setApiKey`/`setPostgresUrl`. Obligaba a configurar a mano en cada instalación y no permite dejar la configuración lista por defecto.
- **No:** API key en `settings.json`. Queda en texto plano y viaja con Settings Sync.
- **Sí:** Postgres local con schema propio `vscode_chat`. El usuario ya tiene la instancia corriendo y quiere los datos ahí.
- **No:** archivos JSON en `globalStorageUri`, SQLite o `globalState`. Descartados frente a la instancia de Postgres que ya existe.
- **Sí:** la extensión crea el schema al arrancar con `CREATE ... IF NOT EXISTS` dentro de una transacción. Es idempotente y no exige pasos manuales al usuario.
- **Sí:** además, el DDL queda versionado en `db/001_init.sql` y es la única fuente del schema. El código lo lee, no lo reescribe en strings.
- **No:** librería de migraciones versionadas (`node-pg-migrate`). Sobredimensionado para tres tablas; se añadirá cuando exista un `002`.
- **Sí:** fallar de forma visible si Postgres no responde, bloqueando el envío. Una pérdida silenciosa de historial es peor que un chat temporalmente inutilizable.
- **No:** fallback en memoria cuando la base no está. El usuario perdería conversaciones sin enterarse.
- **Sí:** streaming token a token con `stream_options.include_usage`. Es lo que se espera de un chat y permite obtener el `usage` en el chunk final.
- **Sí:** columnas de tokens nullable. `NULL` significa "el endpoint no lo informó"; `0` sería una mentira.
- **Sí:** consumo por sesión calculado con `SUM` al consultar, no almacenado. Evita desincronización entre el agregado y las filas.
- **Sí:** webview en la barra lateral. Es el patrón de Copilot y Continue, y no compite con el editor.
- **No:** Chat Participant API nativa. Da menos control sobre el diseño y no permite la vista de consumo propia.
- **Sí:** `uuid` generado en el cliente para las sesiones. La extensión necesita el id antes de la primera escritura.
- **Sí:** recortar el alcance a la base funcional. Tool use, contexto de workspace, costo en USD y gráficas se mencionaron en la conversación y se aparcaron explícitamente para no producir una spec imposible de implementar en pasos commitables.

---

## 7. Riesgos identificados

| Riesgo | Mitigación |
| --- | --- |
| El endpoint compatible no devuelve `usage` al hacer streaming (Ollama y algunos gateways lo omiten) | Las columnas de tokens son nullable y la UI muestra `—`. El chat sigue funcionando; solo se pierde la métrica de ese turno. |
| Postgres caído o cadena de conexión inválida | `healthCheck()` en la activación y estado degradado visible con input bloqueado y botón de reintentar. Nunca se pierde un mensaje en silencio. |
| La cadena de conexión y la API key están en texto plano en `.env` | `.env` está en `.gitignore` y `.vscodeignore`; el repo solo versiona `.env.example`. Nunca en `settings.json`. Los mensajes de error nunca imprimen la cadena completa. |
| Sin workspace abierto no hay `.env` que leer | Error explícito en el panel indicando que hay que abrir la carpeta que contiene `.env`. |
| Las conversaciones crecen y el prompt supera la ventana de contexto | En esta spec se envía el historial completo y se propaga el error del endpoint tal cual. El truncado o resumen va en otra spec. |
| Colisión de nombres si el usuario ya tiene un schema `vscode_chat` | `CREATE SCHEMA IF NOT EXISTS` no borra nada, y todas las tablas usan `IF NOT EXISTS`. La extensión nunca hace `DROP`. |
| El driver `pg` se rompe al empaquetar con esbuild | Se marca `pg` como externo en el bundle y se incluye en `dependencies`, no en `devDependencies`. El paso 13 valida esto instalando el `.vsix` real. |
| Content Security Policy del webview bloquea los scripts | El HTML usa `nonce` por script y `webview.asWebviewUri` para todos los recursos de `media/`. Se valida en el paso 2, antes de tener lógica. |

---

## 8. Lo que **no** entra en esta spec

- Tool use / function calling.
- Contexto automático del workspace (archivo abierto, selección, adjuntos).
- Costo estimado en USD y tabla de precios por modelo.
- Gráficas y series temporales de consumo.
- Publicación en el Marketplace de VS Code.
- Borrado, renombrado y exportación de sesiones.
- Búsqueda en el historial.
- Truncado o resumen automático del contexto.
- Migraciones más allá de `001_init.sql`.

Cada uno de ellos, si llega, va en su propia spec.
