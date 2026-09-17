# LLM Chat

Extensión de VS Code con un panel lateral de chat contra cualquier endpoint **compatible con OpenAI** (OpenAI, OpenRouter, Ollama, gateways propios). Cada sesión se guarda en tu Postgres local y el panel muestra los tokens consumidos.

## Funcionalidades

- Chat con respuesta en streaming y botón de cancelar.
- Sesiones persistidas en Postgres, bajo el schema `vscode_chat`: lista ordenada por actividad, reapertura y continuación de sesiones pasadas.
- Consumo de tokens (`prompt`, `completion`, `total`) por sesión y total global. Si el endpoint no informa `usage`, se muestra `—`.
- Si Postgres no responde, el envío se bloquea y aparece una banda con el error y un botón **Reintentar**. Nunca se pierden mensajes en silencio.

## Requisitos

- VS Code 1.90 o superior.
- Una instancia de PostgreSQL accesible. La extensión crea el schema `vscode_chat` y sus tablas al activarse (`CREATE ... IF NOT EXISTS`); nunca escribe en `public` ni borra nada. El DDL está en `db/001_init.sql`.
- Una API key para el endpoint (si el endpoint la requiere).

## Puesta en marcha

1. Abre la paleta de comandos y ejecuta **LLM Chat: Configurar conexión a Postgres**, con una cadena del tipo `postgresql://user:pass@localhost:5432/mydb`.
2. Ejecuta **LLM Chat: Configurar API key**.
3. Opcional: **LLM Chat: Probar conexión** para comprobar Postgres.
4. Abre el icono **LLM Chat** de la Activity Bar y escribe.

La API key y la cadena de conexión se guardan en el `SecretStorage` de VS Code (cifrado del sistema operativo). Nunca se escriben en `settings.json`.

## Comandos

| Comando | Descripción |
| --- | --- |
| `LLM Chat: Configurar API key` | Guarda la API key en `SecretStorage`. |
| `LLM Chat: Configurar conexión a Postgres` | Guarda la cadena de conexión y crea el schema. |
| `LLM Chat: Probar conexión` | Ejecuta `SELECT 1` contra Postgres y muestra el resultado. |
| `LLM Chat: Nueva sesión` | Abre el panel con una sesión vacía. |

## Ajustes

| Ajuste | Por defecto | Descripción |
| --- | --- | --- |
| `llmChat.baseUrl` | `https://api.openai.com/v1` | URL base; la extensión llama a `{baseUrl}/chat/completions`. |
| `llmChat.model` | `gpt-4o-mini` | Modelo enviado en cada petición. |
| `llmChat.maxTokens` | `4096` | `max_tokens` de la respuesta. |
| `llmChat.temperature` | `0.7` | Temperatura de muestreo. |
| `llmChat.systemPrompt` | `""` | Mensaje de sistema opcional. |

Los cambios se aplican en la siguiente petición, sin reiniciar VS Code.

## Desarrollo

```bash
npm install
npm run compile     # comprobación de tipos + bundle en dist/
npm run package     # genera llm-chat-<versión>.vsix
code --install-extension llm-chat-0.0.1.vsix
```

Para depurar, abre el proyecto en VS Code y pulsa F5.
