import * as vscode from 'vscode';
import { getPool } from './pool';

/**
 * Ejecuta db/001_init.sql dentro de una transacción.
 * El DDL es idempotente (IF NOT EXISTS), así que se puede llamar en cada activación.
 */
export async function ensureSchema(extensionUri: vscode.Uri, secrets: vscode.SecretStorage): Promise<void> {
  const sqlUri = vscode.Uri.joinPath(extensionUri, 'db', '001_init.sql');
  const sql = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(sqlUri));

  const pool = await getPool(secrets);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
