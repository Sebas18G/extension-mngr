# SPEC 02 — Adjuntos de contexto del proyecto en el chat

> **Estado:** Aprobado
> **Depende de:** SPEC 01
> **Fecha:** 2026-09-16
> **Objetivo:** Permitir adjuntar a un mensaje el archivo activo, la selección, el árbol de carpetas o cualquier archivo de texto del workspace, mediante botones o menciones `@`, guardando en Postgres el contenido exacto enviado.

---

## 1. Por qué existe esta spec

La spec 01 dejó fuera a propósito el "contexto del workspace": hoy el modelo solo ve lo que el usuario escribe. Durante la definición se habló de que el modelo busque en el proyecto por sí mismo, como hace Claude. Eso es **tool use** y requiere function calling, que el endpoint actual (Ollama) no garantiza. Esta spec entrega primero la base: el **usuario** decide qué contexto adjunta.

Tres decisiones estructurales:

1. El contexto se adjunta de forma **explícita** (botones o menciones), nunca de forma automática.
2. El contenido enviado se **congela en Postgres** al enviar. Reabrir una sesión reenvía al LLM exactamente lo mismo que vio la primera vez, aunque el archivo haya cambiado.
3. El tamaño del prompt se controla con un **límite estimado de tokens por envío**, porque con Ollama no hay tokenizador disponible en la extensión.

---

## 2. Alcance

**Entra:**

- Cuatro tipos de adjunto: archivo activo, selección del editor, árbol de carpetas del workspace y archivo del workspace por ruta.
- Botones sobre el input: "Archivo activo", "Selección", "Árbol" y "Archivo…". Cada uno añade un chip quitable.
- Menciones en el texto: `@activo`, `@seleccion`, `@arbol` y `@ruta/relativa.ext`.
- Autocompletado de rutas al escribir `@` en el input.
- Selector de archivos (QuickPick de VS Code) para el botón "Archivo…".
- Captura del contenido al pulsar Enviar, incluidos los cambios sin guardar de los documentos abiertos.
- Árbol de carpetas que respeta `files.exclude` y el `.gitignore` raíz, con un máximo de 2000 rutas.
- Solo archivos de texto dentro de la primera carpeta del workspace. Se rechazan binarios y rutas externas.
- Nuevo ajuste `llmChat.maxContextTokens` (por defecto `200000`), aplicado por envío a system prompt + historial + texto + adjuntos.
- Truncado de adjuntos cuando no caben, marcado como `truncado` en la UI.
- Bloqueo del envío si el historial por sí solo ya supera el límite, con mensaje que pide abrir una sesión nueva.
- Tabla nueva `vscode_chat.message_context` creada con `db/002_message_context.sql`.
- Los adjuntos de mensajes anteriores se siguen enviando en los turnos siguientes, como parte del mensaje de usuario.
- Al reabrir una sesión, cada mensaje de usuario muestra sus adjuntos (tipo, ruta, líneas y si se truncó).

**Fuera de alcance (para specs futuras):**

- Tool use / function calling: que el modelo lea o busque archivos por sí mismo.
- Leer el contenido de páginas web a partir de una URL (descartado en la definición).
- Adjuntar el contexto de forma automática en cada mensaje sin acción del usuario.
- Búsqueda semántica, embeddings o indexado del código.
- Imágenes y archivos binarios.
- Workspaces multi-raíz: solo se usa la primera carpeta, igual que `.env`.
- `.gitignore` anidados en subcarpetas.
- Tokenización exacta por modelo.
- Truncado o resumen del historial de la conversación.
- Contexto de terminal, diagnósticos, diff de git o símbolos.
- Editar o quitar adjuntos de mensajes ya enviados.
- Arrastrar y soltar archivos en el panel.

---

## 3. Modelo de datos

### 3.1 Schema de Postgres (`db/002_message_context.sql`)

```sql
CREATE TABLE IF NOT EXISTS vscode_chat.message_context (
  id          bigserial PRIMARY KEY,
  message_id  bigint   NOT NULL REFERENCES vscode_chat.messages(id) ON DELETE CASCADE,
  position    smallint NOT NULL,
  kind        text     NOT NULL CHECK (kind IN ('activeFile', 'selection', 'tree', 'file')),
  path        text,
  start_line  integer,
  end_line    integer,
  content     text     NOT NULL,
  truncated   boolean  NOT NULL DEFAULT false,
  est_tokens  integer  NOT NULL
);

CREATE INDEX IF NOT EXISTS message_context_message_id_idx
  ON vscode_chat.message_context (message_id, position);
```

Convenciones:

- Solo los mensajes con `role = 'user'` tienen filas en `message_context`.
- `path` es relativo a la primera carpeta del workspace, con `/` como separador. Es `NULL` solo para `kind = 'tree'`.
- `start_line` y `end_line` son base 1 e inclusivas. Solo se rellenan para `kind = 'selection'`.
- `content` es el texto **exacto** que se envió al LLM, ya truncado si hizo falta.
- `position` conserva el orden de los adjuntos dentro del mensaje.
- `est_tokens` es `ceil(caracteres / 4)` del `content` guardado.
- `messages.content` sigue guardando solo el texto que escribió el usuario, con las menciones tal cual.
- El mensaje de usuario y sus adjuntos se insertan en la **misma transacción**.
- `001_init.sql` no se modifica. `ensureSchema` ejecuta `001_init.sql` y `002_message_context.sql` en ese orden.

### 3.2 Tipos (`src/types.ts`)

```ts
export type AttachmentKind = 'activeFile' | 'selection' | 'tree' | 'file';

/** Lo que el webview pide adjuntar. El contenido se resuelve en la extensión al enviar. */
export type AttachmentRef =
  | { kind: 'activeFile' }
  | { kind: 'selection' }
  | { kind: 'tree' }
  | { kind: 'file'; path: string };

export interface StoredAttachment {
  kind: AttachmentKind;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  truncated: boolean;
  estTokens: number;
}

export interface StoredMessage {
  id: string;
  role: Role;
  content: string;
  createdAt: string;
  attachments: StoredAttachment[]; // vacío en mensajes de assistant
}
```

`StoredAttachment` no incluye `content`: el webview no lo necesita y la extensión lo lee de la base al reconstruir el historial.

### 3.3 Protocolo webview ↔ extensión (`src/panel/protocol.ts`)

```ts
// webview → extensión
type ToHost =
  | { type: 'send'; text: string; attachments: AttachmentRef[] } // cambia
  | { type: 'pickFile' }                                         // nuevo: abre el QuickPick
  | { type: 'searchFiles'; query: string }                       // nuevo: autocompletado de @
  | /* resto sin cambios */;

// extensión → webview
type ToWebview =
  | { type: 'filePicked'; path: string }                         // nuevo
  | { type: 'fileSuggestions'; query: string; items: string[] }  // nuevo, máx. 20 rutas
  | /* resto sin cambios */;
```

### 3.4 Ajuste nuevo (`package.json` y `src/config/settings.ts`)

```jsonc
{
  "llmChat.maxContextTokens": 200000
}
```

### 3.5 Menciones

- Una mención empieza con `@` al inicio del texto o tras un espacio, y termina en el siguiente espacio. Así `usuario@dominio.com` no es una mención.
- `@activo`, `@seleccion` y `@arbol` son palabras reservadas y tienen prioridad sobre un archivo con ese nombre.
- Cualquier otra mención se interpreta como ruta relativa a la primera carpeta del workspace.
- Las rutas con espacios no se pueden mencionar: se adjuntan con el botón "Archivo…".
- Las menciones se resuelven en la extensión al enviar. Se combinan con los chips y se eliminan los duplicados (mismo `kind` y misma `path`).

### 3.6 Formato del prompt

Cada mensaje de usuario que se envía al LLM se compone con sus adjuntos delante del texto, en orden de `position`:

```text
<context kind="file" path="src/db/pool.ts">
...contenido...
</context>

<context kind="selection" path="src/extension.ts" lines="10-24">
...contenido...
</context>

texto del usuario
```

Si un adjunto se truncó, se añade el atributo `truncated="true"`. El árbol usa `kind="tree"` sin `path`. La composición vive en una sola función (`buildUserContent`), que se usa tanto al enviar como al reconstruir el historial de una sesión reabierta.

### 3.7 Límite de tokens

- Estimación: `ceil(caracteres / 4)`.
- `base` = estimación de system prompt + historial compuesto (con sus adjuntos) + texto nuevo.
- Si `base > maxContextTokens`, no se envía y **no se guarda nada**. Error: `La sesión supera el límite de llmChat.maxContextTokens (N tokens estimados). Abre una nueva sesión.`
- Si no, los adjuntos nuevos se procesan en orden con el presupuesto restante. Un adjunto que no cabe se trunca al presupuesto disponible y queda con `truncated = true`. Si el presupuesto es cero, se guarda con `content = ''` y `truncated = true`.
- El límite no reserva espacio para `llmChat.maxTokens` de la respuesta.

---

## 4. Plan de implementación

Cada paso deja el repositorio compilable con `npm run compile` y ejecutable con F5.

1. **Migración 002.** Crear `db/002_message_context.sql` con el DDL de la sección 3.1. Cambiar `src/db/schema.ts` para ejecutar una lista ordenada y fija (`['001_init.sql', '002_message_context.sql']`) dentro de la misma transacción. Prueba manual: activar la extensión, ver la tabla con `\d vscode_chat.message_context`, recargar la ventana y comprobar que no falla.

2. **Persistencia de adjuntos.** Añadir los tipos de la sección 3.2 en `src/types.ts`. Ampliar `appendMessage` en `src/db/sessions.ts` con un parámetro opcional de adjuntos que se insertan en la misma transacción. Ampliar `getSession` para devolver `attachments` por mensaje y una función `getMessageContexts` que devuelve el `content` para reconstruir el historial. Sin cambios de UI. Prueba manual: conversar como antes y comprobar que todo sigue funcionando y que `message_context` queda vacía.

3. **Presupuesto y composición del prompt.** Crear `src/context/budget.ts` con `estimateTokens`, `buildUserContent` y la lógica de la sección 3.7. Añadir `llmChat.maxContextTokens` en `package.json` y en `src/config/settings.ts`. En `ChatViewProvider`, construir `history` con `buildUserContent` al abrir una sesión y bloquear el envío si `base` supera el límite. Prueba manual: poner `llmChat.maxContextTokens` a `50`, enviar un mensaje largo y ver el error sin fila nueva en `messages`.

4. **Resolución de adjuntos en la extensión.** Crear `src/context/attachments.ts` con `resolveAttachments(refs)` para `activeFile`, `selection` y `file`. Valida que la ruta está dentro de la primera carpeta del workspace, rechaza binarios (byte nulo en los primeros 8000 bytes) y usa el texto del documento abierto si existe, para incluir cambios sin guardar. Cambiar `send` en `src/panel/protocol.ts` para aceptar `attachments` y conectarlo en `ChatViewProvider.send`: resolver, aplicar presupuesto, guardar y enviar. Si un adjunto falla, se muestra el error y no se guarda ni se envía nada. Prueba manual: mandar desde el webview `attachments: [{ kind: 'activeFile' }]` fijo y comprobar la fila en `message_context`.

5. **Chips de archivo activo y selección.** En `media/main.js` y `media/main.css`, añadir sobre el input los botones "Archivo activo" y "Selección", que crean chips quitables. Al enviar se mandan las referencias y se vacían los chips. Cada burbuja de usuario muestra sus adjuntos (tipo, ruta, líneas, `truncado`). Prueba manual: seleccionar código, adjuntar selección, preguntar por ella y ver que el modelo la conoce.

6. **Árbol de carpetas.** Crear `src/context/tree.ts`, que usa `workspace.findFiles` con las exclusiones de `files.exclude` y filtra con el `.gitignore` raíz mediante la dependencia `ignore`. Genera un árbol indentado ordenado alfabéticamente, cortado en 2000 rutas con la línea final `… (N rutas omitidas)`. Añadir el botón "Árbol" y el tipo `tree` en `resolveAttachments`. Prueba manual: adjuntar el árbol y comprobar que no aparecen `node_modules` ni `dist`.

7. **Selector de archivo.** Añadir el botón "Archivo…" que envía `pickFile`. La extensión abre un `showQuickPick` con las rutas de `findFiles` y responde `filePicked`, que añade un chip `file`. Prueba manual: elegir `src/db/pool.ts` y preguntar por su contenido.

8. **Menciones.** Crear `src/context/mentions.ts` con `parseMentions(text): AttachmentRef[]` según la sección 3.5. En `ChatViewProvider.send`, combinar las menciones con los chips y quitar duplicados. Una ruta mencionada que no existe produce un error y el mensaje no se envía. Prueba manual: escribir `explica @src/db/pool.ts` sin chips y ver el adjunto en la burbuja.

9. **Autocompletado de rutas.** En `media/main.js`, al escribir `@` seguido de texto, enviar `searchFiles` con debounce de 200 ms. La extensión responde `fileSuggestions` con hasta 20 rutas (incluidas `activo`, `seleccion` y `arbol` si coinciden). La lista se navega con flechas, se acepta con Enter o Tab y se cierra con Esc. Mientras la lista está abierta, Enter no envía el mensaje. Prueba manual: escribir `@pool` y elegir `src/db/pool.ts`.

---

## 5. Criterios de aceptación

- [ ] `npm run compile` termina sin errores.
- [ ] Tras activar la extensión existe `vscode_chat.message_context`, y `db/001_init.sql` no tiene cambios respecto a `main`.
- [ ] Ejecutar la creación del schema dos veces seguidas no produce error.
- [ ] Una sesión creada con la spec 01 se abre y se puede seguir usando sin errores.
- [ ] El botón "Archivo activo" añade un chip, y al enviar se crea una fila en `message_context` con `kind = 'activeFile'` y la ruta relativa del archivo.
- [ ] Con cambios sin guardar en el archivo activo, el `content` guardado incluye esos cambios.
- [ ] El botón "Selección" guarda `kind = 'selection'` con `start_line` y `end_line` iguales a las líneas seleccionadas.
- [ ] Pulsar "Selección" sin texto seleccionado o sin editor activo muestra un error y no guarda ningún mensaje.
- [ ] El adjunto "Árbol" no contiene rutas de `node_modules/`, `dist/` ni de otras entradas del `.gitignore` raíz.
- [ ] En un workspace con más de 2000 archivos, el árbol tiene como máximo 2000 rutas y termina en `… (N rutas omitidas)`.
- [ ] El botón "Archivo…" abre un QuickPick y el archivo elegido aparece como chip.
- [ ] Escribir `@src/db/pool.ts` en el texto crea un adjunto `file` con esa ruta sin usar botones.
- [ ] `usuario@dominio.com` en el texto no crea ningún adjunto.
- [ ] Mencionar `@activo` y pulsar además el botón "Archivo activo" produce un único adjunto.
- [ ] Mencionar una ruta que no existe muestra un error y no se guarda ningún mensaje.
- [ ] Adjuntar un archivo binario (p. ej. `media/icon.png`) muestra un error y no se guarda ningún mensaje.
- [ ] Una ruta fuera de la carpeta del workspace (p. ej. `@../otro/archivo.txt`) se rechaza con error.
- [ ] Escribir `@po` en el input muestra sugerencias; Enter acepta la sugerencia y no envía el mensaje.
- [ ] Con `llmChat.maxContextTokens = 1000` y un archivo de 20.000 caracteres adjunto, la fila queda con `truncated = true` y la burbuja muestra `truncado`.
- [ ] Si el historial estimado supera `llmChat.maxContextTokens`, aparece el error que pide abrir una nueva sesión y `SELECT COUNT(*) FROM vscode_chat.messages` no cambia.
- [ ] En el segundo turno de una conversación, el modelo responde sobre un archivo adjuntado en el primer turno sin volver a adjuntarlo.
- [ ] Tras modificar un archivo adjunto, recargar la ventana y reabrir la sesión, el historial enviado al LLM usa el `content` guardado y no el archivo actual.
- [ ] Al reabrir una sesión, cada burbuja de usuario muestra sus adjuntos con tipo, ruta y líneas.
- [ ] `messages.content` guarda el texto tal como lo escribió el usuario, sin los bloques `<context>`.
- [ ] Con Postgres apagado, adjuntar y enviar sigue bloqueado por el estado degradado de la spec 01.

---

## 6. Decisiones tomadas y descartadas

- **Sí:** adjuntos explícitos elegidos por el usuario. Son predecibles, controlan el consumo de tokens y funcionan con Ollama.
- **No (por ahora):** tool use para que el modelo busque en el proyecto. Es lo que el usuario quiere a largo plazo, pero depende de function calling y cambia el bucle de conversación. Va en una spec posterior que reutilizará `src/context/`.
- **No:** leer páginas web por URL. Surgió de una interpretación de la descripción inicial y el usuario lo descartó.
- **No:** contexto automático en cada mensaje. Gasta tokens sin que el usuario lo decida.
- **Sí:** botones y menciones `@` a la vez. Los botones son descubribles y las menciones son rápidas de teclear.
- **Sí:** menciones de cualquier ruta con autocompletado y botón con QuickPick. Elegir archivos concretos es la forma principal de dar contexto.
- **Sí:** capturar el contenido al pulsar Enviar. El chip solo guarda la referencia y se envía la versión actual, incluidos los cambios sin guardar.
- **No:** congelar el contenido al crear el chip. Enviaría versiones viejas si el usuario edita antes de enviar.
- **Sí:** guardar el contenido exacto enviado en `message_context`. El historial reenviado es reproducible aunque el archivo cambie o se borre.
- **No:** guardar solo la ruta. Al reabrir la sesión el modelo perdería el contexto.
- **No:** incrustar los adjuntos en `messages.content`. Mezcla lo escrito por el usuario con el contexto y ensucia la lista y el título de las sesiones.
- **Sí:** los adjuntos de turnos anteriores se reenvían en cada turno. El modelo recuerda el archivo durante toda la conversación.
- **Sí:** límite por envío de 200.000 tokens estimados, configurable con `llmChat.maxContextTokens`. Con Ollama no hay tokenizador, así que `caracteres / 4` es la única estimación disponible sin dependencias.
- **No:** límite acumulado por sesión ni límite solo sobre adjuntos. El primero bloquea sesiones largas sin necesidad y el segundo no evita desbordar la ventana.
- **Sí:** bloquear el envío si el historial ya supera el límite. El truncado o resumen del historial sigue fuera de alcance, como en la spec 01.
- **Sí:** truncar adjuntos nuevos que no caben y marcarlos como `truncado`. Es mejor enviar parte del archivo con aviso que bloquear.
- **Sí:** un adjunto que no se puede resolver (sin selección, ruta inexistente, binario, fuera del workspace) bloquea todo el envío. Sigue la regla de no perder datos en silencio: el usuario ve el error y corrige.
- **Sí:** solo archivos de texto dentro de la primera carpeta del workspace. Evita enviar datos de fuera del proyecto y es coherente con la lectura de `.env`.
- **Sí:** árbol con `files.exclude` + `.gitignore` raíz y máximo 2000 rutas. Sin eso, `node_modules` llenaría el presupuesto.
- **Sí:** dependencia `ignore` para interpretar `.gitignore`. `workspace.findFiles` no aplica `.gitignore` y escribir un parser propio es propenso a errores.
- **No:** `.gitignore` anidados. Cubren pocos casos y complican el filtrado.
- **Sí:** lista fija y ordenada de migraciones en `schema.ts`. Es explícita y no depende de listar directorios dentro del `.vsix`.
- **No:** librería de migraciones. Con dos archivos idempotentes sigue siendo sobredimensionado.
- **Sí:** formato `<context kind path lines>` delante del texto del usuario. Los modelos lo delimitan bien y el mismo formato sirve al enviar y al reconstruir.

---

## 7. Riesgos identificados

| Riesgo | Mitigación |
| --- | --- |
| La estimación `caracteres / 4` se queda corta con código o idiomas con muchos símbolos y el endpoint rechaza el prompt | El límite es configurable. El error del endpoint se propaga tal cual, como en la spec 01. |
| La ventana real del modelo en Ollama (`num_ctx`) es mucho menor que 200.000 y el modelo ignora en silencio el principio del prompt | Documentar en el README que `llmChat.maxContextTokens` debe ajustarse al contexto del modelo usado. |
| Leer un archivo enorme bloquea la extensión o consume mucha memoria | Se leen como máximo `maxContextTokens × 4` bytes por archivo antes de truncar. |
| Al hacer clic en el panel se pierde la selección o el editor activo | Los webviews de la barra lateral no cambian `activeTextEditor`. Si aun así no hay editor o selección, el envío se bloquea con error explícito. |
| La base crece al guardar el contenido de cada adjunto | Aceptado a cambio de reproducibilidad. El borrado de sesiones sigue fuera de alcance. |
| Se envían por error secretos al LLM (p. ej. `.env` mencionado o adjuntado) | El usuario elige cada adjunto de forma explícita. `.env` está en `.gitignore`, así que no aparece en el árbol. Excluirlo también de menciones y QuickPick queda como mejora posible, no como parte de esta spec. |
| En workspaces grandes `findFiles` es lento para el autocompletado | Debounce de 200 ms y máximo 20 resultados. |
| Añadir `002` rompe instalaciones que ya tienen el schema de la spec 01 | El DDL usa `IF NOT EXISTS` y solo añade una tabla. No modifica ni borra tablas existentes. |

---

## 8. Lo que **no** entra en esta spec

- Tool use / function calling.
- Lectura de páginas web por URL.
- Contexto automático sin acción del usuario.
- Búsqueda semántica o embeddings.
- Imágenes y binarios.
- Workspaces multi-raíz y `.gitignore` anidados.
- Tokenización exacta.
- Truncado o resumen del historial.
- Terminal, diagnósticos, diff de git o símbolos como contexto.
- Editar adjuntos ya enviados y arrastrar y soltar archivos.

Cada uno de ellos, si llega, va en su propia spec.
