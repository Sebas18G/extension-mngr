import * as vscode from 'vscode';
import { getPool } from './pool';

/**
 * Migraciones en orden de ejecución. La lista es fija para no depender de
 * listar el directorio `db/` dentro del `.vsix`.
 */
const MIGRATIONS = ['001_init.sql', '002_message_context.sql'];

/**
 * Clave del advisory lock que serializa las migraciones. `ensureSchema` se llama a la vez desde la
 * activación y desde el panel (y desde otras ventanas): sin el lock, la FK de 002 sobre `messages`
 * choca con el CREATE INDEX de 001 en la otra transacción y Postgres aborta una por deadlock.
 */
const SCHEMA_LOCK_KEY = 7_302_418_001;

/**
 * Ejecuta las migraciones de `db/` dentro de una misma transacción.
 * El DDL es idempotente (IF NOT EXISTS), así que se puede llamar en cada activación.
 */
export async function ensureSchema(extensionUri: vscode.Uri): Promise<void> {
  const decoder = new TextDecoder('utf-8');
  const scripts: string[] = [];
  for (const file of MIGRATIONS) {
    const sqlUri = vscode.Uri.joinPath(extensionUri, 'db', file);
    scripts.push(decoder.decode(await vscode.workspace.fs.readFile(sqlUri)));
  }

  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Se libera solo al hacer COMMIT o ROLLBACK.
    await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_KEY]);
    for (const sql of scripts) {
      await client.query(sql);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
