# LLM Chat

Extensión de VS Code con un panel lateral de chat contra cualquier endpoint **compatible con OpenAI** (OpenAI, OpenRouter, Ollama, gateways propios). Cada sesión se guarda en tu Postgres local y el panel muestra los tokens consumidos.

## Funcionalidades

- Chat con respuesta en streaming y botón **Cancelar**. Si cancelas o el stream falla a mitad, lo recibido hasta ese momento también se guarda.
- Sesiones persistidas en Postgres, bajo el schema `vscode_chat`: lista ordenada por última actividad, reapertura y continuación de sesiones pasadas.
- El título de cada sesión se deriva de los primeros 60 caracteres del primer mensaje.
- Consumo de tokens (`prompt`, `completion`, `total`) por sesión y total global. Si el endpoint no informa `usage`, se muestra `—` (nunca `0`).
- Si Postgres no responde, el envío se bloquea y aparece una banda con el error y un botón **Reintentar**. El mensaje del usuario se guarda antes de llamar al LLM, así que nunca se pierden mensajes en silencio.
- Las credenciales nunca aparecen en los mensajes de error: la cadena de conexión se sustituye por `<POSTGRES_URL>`.

## Requisitos

- VS Code 1.90 o superior.
- Una instancia de PostgreSQL accesible. La extensión crea el schema `vscode_chat` y sus tablas al activarse (`CREATE ... IF NOT EXISTS`); nunca escribe en `public` ni borra nada. El DDL está en `db/001_init.sql`.
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

Los cambios se aplican en la siguiente petición, sin reiniciar VS Code.

## Modelo de datos

Todo vive en el schema `vscode_chat` (ver `db/001_init.sql`):

| Tabla | Contenido |
| --- | --- |
| `sessions` | `id` (uuid), `title`, `model`, `base_url`, `created_at`, `updated_at`. |
| `messages` | Mensajes `user` / `assistant` / `system` de cada sesión (`ON DELETE CASCADE`). |
| `message_usage` | Tokens de cada respuesta del assistant; columnas `NULL` si el endpoint no informa `usage`. |

Los totales por sesión y global se calculan con `SUM` al consultar; no se almacenan agregados.

## Estructura del proyecto

```
src/
  extension.ts            activación, comandos y watcher del .env
  config/env.ts           lectura de LLM_API_KEY y POSTGRES_URL desde .env
  config/settings.ts      lectura de los ajustes llmChat.*
  db/pool.ts              Pool de pg, health check y saneado de errores
  db/schema.ts            ejecuta db/001_init.sql en una transacción
  db/sessions.ts          consultas de sesiones, mensajes y usage
  llm/client.ts           streaming SSE contra /chat/completions (fetch nativo)
  panel/ChatViewProvider.ts  webview del panel y orquestación del chat
  panel/protocol.ts       tipos de los mensajes webview ↔ extensión
  types.ts                tipos compartidos
media/                    main.js / main.css del webview e iconos
db/001_init.sql           DDL idempotente
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

Para depurar, abre el proyecto en VS Code y pulsa F5 (ejecuta `npm: compile` y lanza un Extension Development Host). Recuerda que el `.env` se lee de la carpeta abierta en esa ventana, no de este repositorio.

Las funcionalidades nuevas se diseñan primero como spec en `specs/` con las skills `/spec` y `/spec-impl`.
