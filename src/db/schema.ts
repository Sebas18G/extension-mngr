import * as vscode from 'vscode';
import { getPool } from './pool';

/**
 * Migraciones en orden de ejecución. La lista es fija para no depender de
 * listar el directorio `db/` dentro del `.vsix`.
 */
const MIGRATIONS = ['001_init.sql', '002_message_context.sql'];

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
