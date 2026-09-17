import { parse } from 'dotenv';
import * as vscode from 'vscode';

export const ENV_FILE = '.env';
const API_KEY = 'LLM_API_KEY';
const POSTGRES_URL = 'POSTGRES_URL';

/** Uri del `.env` en la raíz de la primera carpeta del workspace, o undefined si no hay workspace. */
export function getEnvUri(): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? vscode.Uri.joinPath(folder.uri, ENV_FILE) : undefined;
}

/**
 * Lee una variable del `.env` del workspace. Se lee en cada llamada para que los cambios apliquen sin reiniciar.
 * Lanza un error explícito si no hay workspace, no existe el archivo o falta la variable.
 */
async function readRequired(name: string): Promise<string> {
  const uri = getEnvUri();
  if (!uri) {
    throw new Error(`No hay ninguna carpeta abierta. Abre la carpeta que contiene el archivo ${ENV_FILE}.`);
  }

  let content: Uint8Array;
  try {
    content = await vscode.workspace.fs.readFile(uri);
  } catch {
    throw new Error(`No se encontró ${uri.fsPath}. Créalo a partir de .env.example con ${POSTGRES_URL} y ${API_KEY}.`);
  }

  const value = parse(Buffer.from(content))[name]?.trim();
  if (!value) {
    throw new Error(`Falta ${name} en ${uri.fsPath}.`);
  }
  return value;
}

export function getApiKey(): Promise<string> {
  return readRequired(API_KEY);
}

export function getPostgresUrl(): Promise<string> {
  return readRequired(POSTGRES_URL);
}
