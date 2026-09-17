import { Pool } from 'pg';
import { getPostgresUrl } from '../config/env';

export interface HealthStatus {
  ok: boolean;
  message?: string;
}

let pool: Pool | undefined;
let poolUrl: string | undefined;

/**
 * Devuelve un Pool construido con POSTGRES_URL del `.env` del workspace.
 * Si la cadena cambió desde la última llamada, cierra el pool anterior y crea uno nuevo.
 */
export async function getPool(): Promise<Pool> {
  const url = await getPostgresUrl();

  if (pool && poolUrl === url) {
    return pool;
  }

  await closePool();
  pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
  // Un error en un cliente inactivo no debe tumbar el extension host.
  pool.on('error', () => {});
  poolUrl = url;
  return pool;
}

export async function healthCheck(): Promise<HealthStatus> {
  try {
    const p = await getPool();
    await p.query('SELECT 1');
    return { ok: true };
  } catch (err) {
    return { ok: false, message: sanitizeError(err) };
  }
}

export async function closePool(): Promise<void> {
  const old = pool;
  pool = undefined;
  poolUrl = undefined;
  if (old) {
    await old.end().catch(() => {});
  }
}

/** Mensaje de error legible que nunca incluye la cadena de conexión. */
export function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return poolUrl ? message.split(poolUrl).join('<POSTGRES_URL>') : message;
}
