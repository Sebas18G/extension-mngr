# LLM Chat

Extensión de VS Code con un panel lateral de chat contra cualquier endpoint **compatible con OpenAI** (OpenAI, OpenRouter, Ollama, gateways propios). Cada sesión se guarda en tu Postgres local y el panel muestra los tokens consumidos.

## Funcionalidades

- Chat con respuesta en streaming y botón **Cancelar**. Si cancelas o el stream falla a mitad, lo recibido hasta ese momento también se guarda.
- Sesiones persistidas en Postgres, bajo el schema `vscode_chat`: lista ordenada por última actividad, reapertura y continuación de sesiones pasadas.
- El título de cada sesión se deriva de los primeros 60 caracteres del primer mensaje.
- Consumo de tokens (`prompt`, `completion`, `total`) por sesión y total global. Si el endpoint no informa `usage`, se muestra `—` (nunca `0`).
- Si Postgres no responde, el envío se bloquea y aparece una banda con el error y un botón **Reintentar**. El mensaje del usuario se guarda antes de llamar al LLM, así que nunca se pierden mensajes en silencio.
- Las credenciales nunca aparecen en los mensajes de error: la cadena de conexión se sustituye por `<POSTGRES_URL>`.
- Adjuntos de contexto del proyecto: archivo activo, selección del editor, árbol de carpetas o cualquier archivo de texto del workspace (ver [Adjuntar contexto](#adjuntar-contexto)).

## Adjuntar contexto

El modelo solo ve lo que tú adjuntas: nunca se envía contexto de forma automática.

**Botones** sobre el input. Cada uno añade un chip que puedes quitar con `×` antes de enviar:

| Botón | Adjunta |
| --- | --- |
| **Archivo activo** | El archivo del editor activo, con los cambios sin guardar. |
| **Selección** | El texto seleccionado en el editor activo y sus líneas. |
| **Árbol** | El árbol de carpetas del workspace. |
| **Archivo…** | Un archivo elegido en un QuickPick. |

**Menciones** en el texto del mensaje:

| Mención | Equivale a |
| --- | --- |
| `@activo` | Archivo activo |
| `@seleccion` | Selección |
| `@arbol` | Árbol |
| `@ruta/relativa.ext` | Ese archivo, con la ruta relativa a la carpeta del workspace |

- Al escribir `@` seguido de texto aparecen sugerencias. Muévete con las flechas, acepta con **Enter** o **Tab** y cierra con **Esc**.
- Una mención empieza al inicio del texto o tras un espacio y termina en el siguiente espacio, así que `usuario@dominio.com` no adjunta nada. Las rutas con espacios se adjuntan con **Archivo…**.
- Chips y menciones se combinan y los duplicados se envían una sola vez.

**Cómo se comportan:**

- El contenido se lee al pulsar **Enviar**, no al crear el chip.
- Solo se admiten archivos de texto dentro de la primera carpeta del workspace. Una ruta inexistente, externa o un binario muestra un error y el mensaje no se envía ni se guarda.
- El árbol respeta `files.exclude` y el `.gitignore` raíz, con un máximo de 2000 rutas.
- Cada burbuja muestra sus adjuntos (tipo, ruta, líneas y `truncado` si se recortó).
- Los adjuntos se reenvían en los turnos siguientes, así que el modelo recuerda el archivo durante toda la conversación. El contenido enviado se guarda en Postgres: al reabrir una sesión se reenvía exactamente lo mismo, aunque el archivo haya cambiado.
- Cuidado con los secretos: **Archivo…**, las menciones y el autocompletado sí muestran archivos como `.env`.

### Límite de tokens

Cada envío (system prompt + historial + texto + adjuntos) se limita con `llmChat.maxContextTokens`, estimando `caracteres / 4`:

- Si los adjuntos nuevos no caben, se recortan al espacio disponible y se marcan como `truncado`.
- Si el historial por sí solo ya supera el límite, el envío se bloquea y se pide abrir una nueva sesión.

El valor por defecto (`200000`) es mayor que la ventana de muchos modelos locales. **Ajústalo al contexto del modelo que uses** (por ejemplo, el `num_ctx` de Ollama): si el prompt supera esa ventana, el modelo puede ignorar en silencio el principio de la conversación.

## Requisitos

- VS Code 1.90 o superior.
- Una instancia de PostgreSQL accesible. La extensión crea el schema `vscode_chat` y sus tablas al activarse (`CREATE ... IF NOT EXISTS`); nunca escribe en `public` ni borra nada. El DDL está en `db/` (`001_init.sql`, `002_message_context.sql`).
- Una API key para el endpoint (si el endpoint la requiere).
- Una carpeta abierta en VS Code con un archivo `.env` en su raíz (si hay varias carpetas en el workspace, se usa la primera).

## Puesta en marcha

1. En la raíz de la carpeta que abres en VS Code, crea un archivo `.env` (puedes copiar `.env.example`):

   ```dotenv
   POSTGRES_URL=postgresql://postgres:tu_contraseña@localhost:5432/postgres
   LLM_API_KEY=sk-...
   ```

   Si la contraseña tiene caracteres especiales (`@ # / :`), escápalos en la URL (`@` → `%40`).

2. Abre el icono **LLM Chat** de la Activity Bar y escribe. No hay que ejecutar ningún comando de configuración.

La extensión lee `.env` en cada uso y vigila el archivo: si lo creas, editas o borras, se reconecta sola y refresca el panel. Añade `.env` a tu `.gitignore`; nunca pongas credenciales en `settings.json`.

## Comandos

| Comando | Descripción |
| --- | --- |
| `LLM Chat: Probar conexión` | Ejecuta `SELECT 1` contra Postgres y muestra el resultado. |
| `LLM Chat: Nueva sesión` | Abre el panel con una sesión vacía (reutiliza la actual si aún no tiene mensajes). |

## Ajustes

| Ajuste | Por defecto | Descripción |
| --- | --- | --- |
| `llmChat.baseUrl` | `https://api.openai.com/v1` | URL base; la extensión llama a `{baseUrl}/chat/completions`. |
| `llmChat.model` | `gpt-4o-mini` | Modelo enviado en cada petición. |
| `llmChat.maxTokens` | `4096` | `max_tokens` de la respuesta. |
| `llmChat.temperature` | `0.7` | Temperatura de muestreo. |
| `llmChat.systemPrompt` | `""` | Mensaje de sistema opcional que se antepone a la conversación. |
| `llmChat.maxContextTokens` | `200000` | Límite estimado de tokens por envío (system prompt + historial + texto + adjuntos). Ajústalo al contexto del modelo. |

Los cambios se aplican en la siguiente petición, sin reiniciar VS Code.

## Modelo de datos

Todo vive en el schema `vscode_chat` (ver `db/`):

| Tabla | Contenido |
| --- | --- |
| `sessions` | `id` (uuid), `title`, `model`, `base_url`, `created_at`, `updated_at`. |
| `messages` | Mensajes `user` / `assistant` / `system` de cada sesión (`ON DELETE CASCADE`). |
| `message_usage` | Tokens de cada respuesta del assistant; columnas `NULL` si el endpoint no informa `usage`. |
| `message_context` | Adjuntos de cada mensaje de usuario: `kind`, `path`, `start_line`/`end_line`, `content` exacto enviado, `truncated` y `est_tokens` (`ON DELETE CASCADE`). |

`messages.content` guarda solo el texto que escribiste; los adjuntos van aparte en `message_context`.

Los totales por sesión y global se calculan con `SUM` al consultar; no se almacenan agregados.

## Estructura del proyecto

```
src/
  extension.ts            activación, comandos y watcher del .env
  config/env.ts           lectura de LLM_API_KEY y POSTGRES_URL desde .env
  config/settings.ts      lectura de los ajustes llmChat.*
  db/pool.ts              Pool de pg, health check y saneado de errores
  context/attachments.ts  lectura y validación de adjuntos al enviar
  context/budget.ts       estimación de tokens, truncado y formato <context> del prompt
  context/mentions.ts     parseo de menciones @ y sugerencias
  context/tree.ts         listado de archivos y árbol de carpetas
  db/schema.ts            ejecuta las migraciones de db/ en una transacción
  db/sessions.ts          consultas de sesiones, mensajes, adjuntos y usage
  llm/client.ts           streaming SSE contra /chat/completions (fetch nativo)
  panel/ChatViewProvider.ts  webview del panel y orquestación del chat
  panel/protocol.ts       tipos de los mensajes webview ↔ extensión
  types.ts                tipos compartidos
media/                    main.js / main.css del webview e iconos
db/                       migraciones SQL idempotentes (001_init, 002_message_context)
specs/                    specs del método spec-driven
```

## Desarrollo

```bash
npm install
npm run compile     # comprobación de tipos + bundle en dist/
npm run watch       # rebuild continuo con esbuild
npm run package     # genera llm-chat-<versión>.vsix
code --install-extension llm-chat-0.0.1.vsix
```

### Probar la extensión

No hay tests automáticos: se prueba a mano en un Extension Development Host.

1. Ejecuta `npm install` y arranca Postgres.
2. Abre el proyecto en VS Code y pulsa **F5** (configuración "Run Extension"). Compila y abre una segunda ventana **[Extension Development Host]** con la extensión cargada.
3. La ventana de pruebas abre este mismo repo, así que usa su `.env` y tiene archivos para probar los adjuntos. El `.env` se lee siempre de la carpeta abierta en esa ventana: si abres otra con **File → Open Folder**, debe tener su propio `.env` en la raíz.
4. Abre el panel **LLM Chat** en la Activity Bar.

Tras cambiar código TypeScript, reinicia la depuración con **Ctrl+Shift+F5**. Si solo cambiaste `media/main.js` o `media/main.css`, basta con **Ctrl+R** en la ventana de pruebas.

Pruebas rápidas de los adjuntos:

| Prueba | Resultado esperado |
| --- | --- |
| Abrir un archivo, pulsar **Archivo activo** y preguntar por él | El modelo lo conoce; la burbuja muestra la ruta. |
| Editar sin guardar y adjuntar el archivo activo | El modelo ve los cambios sin guardar. |
| Seleccionar líneas y pulsar **Selección** | La burbuja muestra las líneas seleccionadas. |
| **Selección** sin texto seleccionado y enviar | Error; el texto y el chip vuelven al input. |
| **Árbol** | No aparecen `node_modules/` ni `dist/`. |
| **Archivo…** y elegir `src/db/pool.ts` | Aparece un chip con esa ruta. |
| Escribir `explica @src/db/pool.ts` sin chips | La burbuja muestra el adjunto. |
| Escribir `@po` y pulsar Enter | Se completa la ruta y no se envía el mensaje. |
| `escribe a usuario@dominio.com` | No se crea ningún adjunto. |
| `@media/icon.png` o `@../otro.txt` | Error; no se guarda el mensaje. |
| `llmChat.maxContextTokens: 1000` y adjuntar un archivo grande | La burbuja muestra `truncado`. |
| `llmChat.maxContextTokens: 50` en una sesión con mensajes | Error que pide abrir una nueva sesión. |
| Modificar un archivo adjunto, recargar y reabrir la sesión | El historial usa el contenido guardado, no el actual. |

Para ver lo guardado:

```sql
SELECT message_id, kind, path, start_line, end_line, truncated, est_tokens
  FROM vscode_chat.message_context
 ORDER BY id DESC;
```

Si algo falla, los errores de la extensión salen en la **Debug Console** de la ventana original y los del webview en **Developer: Open Webview Developer Tools** dentro de la ventana de pruebas. La lista completa de criterios está en la sección 5 de cada spec.

Las funcionalidades nuevas se diseñan primero como spec en `specs/` con las skills `/spec` y `/spec-impl`.
