import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { AttachmentWithContent, Role, SessionDetail, SessionSummary, StoredMessage, Usage } from '../types';

export const DEFAULT_TITLE = 'Nueva sesión';

interface NewSession {
  title?: string;
  model: string;
  baseUrl: string;
}

export async function createSession(pool: Pool, input: NewSession): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO vscode_chat.sessions (id, title, model, base_url)
     VALUES ($1, $2, $3, $4)`,
    [id, input.title ?? DEFAULT_TITLE, input.model, input.baseUrl],
  );
  return id;
}

export async function updateSessionTitle(pool: Pool, sessionId: string, title: string): Promise<void> {
  await pool.query(`UPDATE vscode_chat.sessions SET title = $2 WHERE id = $1`, [sessionId, title]);
}

export async function listSessions(pool: Pool): Promise<SessionSummary[]> {
  const { rows } = await pool.query(
    `SELECT s.id, s.title, s.model, s.base_url, s.created_at, s.updated_at,
            SUM(u.prompt_tokens)     AS prompt_tokens,
            SUM(u.completion_tokens) AS completion_tokens,
            SUM(u.total_tokens)      AS total_tokens
       FROM vscode_chat.sessions s
       LEFT JOIN vscode_chat.messages m ON m.session_id = s.id
       LEFT JOIN vscode_chat.message_usage u ON u.message_id = m.id
      GROUP BY s.id
      ORDER BY s.updated_at DESC`,
  );
  return rows.map(toSummary);
}

export async function getSession(pool: Pool, sessionId: string): Promise<SessionDetail | null> {
  const { rows } = await pool.query(
    `SELECT id, title, model, base_url, created_at, updated_at
       FROM vscode_chat.sessions
      WHERE id = $1`,
    [sessionId],
  );
  if (rows.length === 0) {
    return null;
  }
  const usage = await getSessionUsage(pool, sessionId);

  const messages = await pool.query(
    `SELECT id, role, content, created_at
       FROM vscode_chat.messages
      WHERE session_id = $1
      ORDER BY id`,
    [sessionId],
  );
  const contexts = await getMessageContexts(pool, sessionId);

  return {
    ...toSummary(rows[0]),
    usage,
    messages: messages.rows.map((r): StoredMessage => {
      const id = String(r.id);
      return {
        id,
        role: r.role,
        content: r.content,
        createdAt: new Date(r.created_at).toISOString(),
        // Sin `content`: el webview solo muestra los metadatos del adjunto.
        attachments: (contexts.get(id) ?? []).map(({ content: _content, ...meta }) => meta),
      };
    }),
  };
}

/**
 * Adjuntos de todos los mensajes de una sesión, con el `content` exacto que se envió,
 * agrupados por id de mensaje y en orden de `position`. Sirve para reconstruir el historial.
 */
export async function getMessageContexts(pool: Pool, sessionId: string): Promise<Map<string, AttachmentWithContent[]>> {
  const { rows } = await pool.query(
    `SELECT c.message_id, c.kind, c.path, c.start_line, c.end_line, c.content, c.truncated, c.est_tokens
       FROM vscode_chat.message_context c
       JOIN vscode_chat.messages m ON m.id = c.message_id
      WHERE m.session_id = $1
      ORDER BY c.message_id, c.position`,
    [sessionId],
  );

  const byMessage = new Map<string, AttachmentWithContent[]>();
  for (const r of rows) {
    const messageId = String(r.message_id);
    const list = byMessage.get(messageId) ?? [];
    list.push({
      kind: r.kind,
      path: r.path,
      startLine: r.start_line,
      endLine: r.end_line,
      content: r.content,
      truncated: r.truncated,
      estTokens: r.est_tokens,
    });
    byMessage.set(messageId, list);
  }
  return byMessage;
}

/**
 * Inserta un mensaje con sus adjuntos y actualiza sessions.updated_at en la misma transacción,
 * para que nunca quede un mensaje de usuario sin el contexto que se envió con él.
 * Devuelve el id del mensaje.
 */
export async function appendMessage(
  pool: Pool,
  sessionId: string,
  role: Role,
  content: string,
  attachments: AttachmentWithContent[] = [],
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO vscode_chat.messages (session_id, role, content)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [sessionId, role, content],
    );
    const messageId = rows[0].id;
    for (const [position, a] of attachments.entries()) {
      await client.query(
        `INSERT INTO vscode_chat.message_context
           (message_id, position, kind, path, start_line, end_line, content, truncated, est_tokens)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [messageId, position, a.kind, a.path, a.startLine, a.endLine, a.content, a.truncated, a.estTokens],
      );
    }
    await client.query(`UPDATE vscode_chat.sessions SET updated_at = now() WHERE id = $1`, [sessionId]);
    await client.query('COMMIT');
    return String(messageId);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Guarda el usage de un mensaje assistant. Sin usage, las columnas de tokens quedan en NULL. */
export async function saveUsage(pool: Pool, messageId: string, usage: Usage | null, model: string): Promise<void> {
  await pool.query(
    `INSERT INTO vscode_chat.message_usage (message_id, prompt_tokens, completion_tokens, total_tokens, model)
     VALUES ($1, $2, $3, $4, $5)`,
    [messageId, usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null, usage?.total_tokens ?? null, model],
  );
}

export async function getSessionUsage(pool: Pool, sessionId: string): Promise<Usage> {
  const { rows } = await pool.query(
    `SELECT SUM(u.prompt_tokens)     AS prompt_tokens,
            SUM(u.completion_tokens) AS completion_tokens,
            SUM(u.total_tokens)      AS total_tokens
       FROM vscode_chat.message_usage u
       JOIN vscode_chat.messages m ON m.id = u.message_id
      WHERE m.session_id = $1`,
    [sessionId],
  );
  return toUsage(rows[0]);
}

export function toUsage(row: Record<string, unknown>): Usage {
  return {
    prompt_tokens: toNullableNumber(row.prompt_tokens),
    completion_tokens: toNullableNumber(row.completion_tokens),
    total_tokens: toNullableNumber(row.total_tokens),
  };
}

function toSummary(r: Record<string, any>): SessionSummary {
  return {
    id: r.id,
    title: r.title,
    model: r.model,
    baseUrl: r.base_url,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    usage: toUsage(r),
  };
}

// SUM devuelve bigint, que pg entrega como string; NULL se conserva como null.
function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
