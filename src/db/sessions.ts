import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { Role, SessionDetail, SessionSummary, StoredMessage, Usage } from '../types';

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

export async function listSessions(pool: Pool): Promise<SessionSummary[]> {
  const { rows } = await pool.query(
    `SELECT s.id, s.title, s.model, s.base_url, s.created_at, s.updated_at,
            SUM(u.total_tokens) AS total_tokens
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
    `SELECT s.id, s.title, s.model, s.base_url, s.created_at, s.updated_at,
            (SELECT SUM(u.total_tokens)
               FROM vscode_chat.messages m
               JOIN vscode_chat.message_usage u ON u.message_id = m.id
              WHERE m.session_id = s.id) AS total_tokens
       FROM vscode_chat.sessions s
      WHERE s.id = $1`,
    [sessionId],
  );
  if (rows.length === 0) {
    return null;
  }

  const messages = await pool.query(
    `SELECT id, role, content, created_at
       FROM vscode_chat.messages
      WHERE session_id = $1
      ORDER BY id`,
    [sessionId],
  );

  return {
    ...toSummary(rows[0]),
    messages: messages.rows.map(
      (r): StoredMessage => ({
        id: String(r.id),
        role: r.role,
        content: r.content,
        createdAt: new Date(r.created_at).toISOString(),
      }),
    ),
  };
}

/** Inserta un mensaje y actualiza sessions.updated_at en la misma transacción. Devuelve el id del mensaje. */
export async function appendMessage(pool: Pool, sessionId: string, role: Role, content: string): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO vscode_chat.messages (session_id, role, content)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [sessionId, role, content],
    );
    await client.query(`UPDATE vscode_chat.sessions SET updated_at = now() WHERE id = $1`, [sessionId]);
    await client.query('COMMIT');
    return String(rows[0].id);
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
    totalTokens: toNullableNumber(r.total_tokens),
  };
}

// SUM devuelve bigint, que pg entrega como string; NULL se conserva como null.
function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
