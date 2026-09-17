# CLAUDE.md

Guía para trabajar en este repositorio. El README cubre el uso; aquí van las convenciones y las decisiones que no conviene romper.

## Qué es

Extensión de VS Code (`llm-chat`) en TypeScript: panel webview en la Activity Bar que chatea en streaming con un endpoint compatible con OpenAI y persiste sesiones, mensajes y tokens en Postgres (schema `vscode_chat`). El usuario puede adjuntar contexto del proyecto (archivo activo, selección, árbol, archivos por ruta) con botones o menciones `@`. Las especificaciones de referencia son `specs/01-extension-chat-y-consumo.md` y `specs/02-adjuntos-contexto-proyecto.md`.

## Comandos

```bash
npm run compile      # tsc --noEmit + esbuild → dist/extension.js
npm run check-types  # solo comprobación de tipos
npm run watch        # esbuild en modo watch
npm run package      # genera el .vsix con vsce
```

No hay tests ni linter configurados. Verifica los cambios con `npm run compile` y, si tocan comportamiento, con F5 (Extension Development Host).

## Arquitectura

- `src/extension.ts`: registra el `ChatViewProvider`, los comandos `llmChat.testConnection` / `llmChat.newSession` y un `FileSystemWatcher` sobre `.env` que cierra el pool, recrea el schema y recarga el panel.
- `src/panel/ChatViewProvider.ts`: toda la orquestación. Mantiene `sessionId`, `history` (mensajes ya compuestos con sus adjuntos) y un `AbortController` que actúa también como candado de "envío en curso". También atiende `pickFile` (QuickPick) y `searchFiles` (autocompletado de `@`).
- `src/panel/protocol.ts`: contrato de mensajes `ToHost` (webview → extensión) y `ToWebview` (extensión → webview). Cualquier mensaje nuevo se añade aquí y en `media/main.js`.
- `src/llm/client.ts`: `fetch` nativo + parser SSE propio. Pide `stream_options.include_usage`. Sin SDK de OpenAI.
- `src/db/`: `pool.ts` (Pool único que se recrea si cambia `POSTGRES_URL`), `schema.ts` (ejecuta la lista fija `MIGRATIONS` de `db/` en una transacción), `sessions.ts` (SQL parametrizado; `appendMessage` inserta mensaje y adjuntos juntos, `getMessageContexts` devuelve el contenido guardado).
- `src/context/`: adjuntos de contexto.
  - `attachments.ts`: `resolveAttachments` lee el contenido al enviar (documento abierto si existe, para incluir cambios sin guardar). Rechaza rutas fuera de la primera carpeta y binarios (byte nulo en los primeros 8000 bytes).
  - `budget.ts`: `estimateTokens` (`ceil(caracteres / 4)`), `applyBudget` (trunca adjuntos al presupuesto) y `buildUserContent`, **única** fuente del formato `<context kind path lines truncated>`.
  - `tree.ts`: `findWorkspaceFiles` (solo `files.exclude`; QuickPick y autocompletado) y `buildTree` (además `.gitignore` raíz con `ignore`, máx. 2000 rutas).
  - `mentions.ts`: `parseMentions`, `dedupeRefs` y `suggestMentions`.
- `src/config/`: `env.ts` lee `.env` de la primera carpeta del workspace con `dotenv.parse`; `settings.ts` lee `llmChat.*`. Ambos se leen en cada uso, nunca se cachean.
- `media/main.js` y `media/main.css`: webview en JS plano, sin framework ni bundler. CSP con nonce; no añadir scripts inline ni recursos remotos.

## Reglas del proyecto

- **Secretos solo en `.env`** (`LLM_API_KEY`, `POSTGRES_URL`). Nunca en `settings.json`, `globalState` ni `SecretStorage`. Los errores que llegan al usuario pasan por `sanitizeError` para no filtrar la cadena de conexión.
- **Postgres**: todo bajo el schema `vscode_chat`; nunca escribir en `public` ni hacer `DROP`/`DELETE` de datos del usuario. El DDL debe seguir siendo idempotente (`IF NOT EXISTS`). Un cambio de schema va en un nuevo `db/00N_*.sql`, no editando `001_init.sql`.
- **No perder datos en silencio**: el mensaje del usuario se guarda antes de llamar al LLM; si falla Postgres no se envía. La respuesta parcial (cancelada o con error) también se guarda. Si Postgres no responde se emite `dbStatus: ok=false` y el webview bloquea el input.
- **Migraciones**: cada `db/00N_*.sql` nuevo se añade a mano, en orden, a `MIGRATIONS` en `src/db/schema.ts`. No se lista el directorio porque dentro del `.vsix` no es fiable.
- **Adjuntos congelados**: el `content` exacto enviado se guarda en `message_context` en la misma transacción que el mensaje. Al reabrir una sesión el historial se reconstruye con ese contenido, nunca releyendo el archivo. `messages.content` guarda solo el texto escrito por el usuario, sin bloques `<context>`.
- **Adjunto inválido bloquea el envío**: si un adjunto no se resuelve (sin selección, ruta inexistente, binario, fuera del workspace) o el historial supera `llmChat.maxContextTokens`, se muestra el error y no se guarda nada. El contenido de los adjuntos nunca viaja al webview: `StoredAttachment` no lleva `content`.
- **Usage desconocido es `null`, nunca `0`**: en tipos, en la base (`NULL`) y en la UI (`—`). `SUM` de pg devuelve string; convertir con `toNullableNumber`.
- `pg` y `vscode` son `external` en esbuild; `pg` se empaqueta desde `node_modules` en el `.vsix`. `dotenv` e `ignore` se incluyen en el bundle.
- Textos de UI, mensajes de error y comentarios en español.

## Estilo

- TypeScript `strict`, CommonJS, target ES2022 / node20.
- Comillas simples, punto y coma, trailing commas, 2 espacios.
- Comentarios JSDoc breves que explican el porqué, no el qué.

## Flujo de trabajo

- Funcionalidades nuevas: primero una spec con `/spec` en `specs/NN-slug.md`, después `/spec-impl`, que crea la rama `spec-NN-slug` (`specs/.spec-config.yml`).
- Ramas: se trabaja en `dev`; los PR van contra `main`.
- Fuera de alcance (requieren spec nueva): tool use / function calling, contexto automático sin acción del usuario, leer URLs, búsqueda semántica, imágenes y binarios, workspaces multi-raíz y `.gitignore` anidados, tokenización exacta, truncado o resumen del historial, costo en USD, gráficas de consumo.
