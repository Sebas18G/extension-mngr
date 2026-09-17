import * as vscode from 'vscode';
import { ENV_FILE } from './config/env';
import { closePool, healthCheck, sanitizeError } from './db/pool';
import { ensureSchema } from './db/schema';
import { ChatViewProvider } from './panel/ChatViewProvider';

export function activate(context: vscode.ExtensionContext): void {
  const chatView = new ChatViewProvider(context.extensionUri);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatView));

  context.subscriptions.push(
    vscode.commands.registerCommand('llmChat.newSession', async () => {
      await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
      await chatView.newSession();
    }),

    vscode.commands.registerCommand('llmChat.testConnection', async () => {
      const status = await healthCheck();
      if (status.ok) {
        vscode.window.showInformationMessage('LLM Chat: conexión a Postgres OK.');
      } else {
        vscode.window.showErrorMessage(`LLM Chat: error de conexión a Postgres: ${status.message}`);
      }
    }),
  );

  // Editar, crear o borrar el .env del workspace vuelve a conectar sin reiniciar.
  const watcher = vscode.workspace.createFileSystemWatcher(`**/${ENV_FILE}`);
  const onEnvChange = async () => {
    await closePool();
    await initSchema(context, { silent: true });
    await chatView.reload();
  };
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(onEnvChange),
    watcher.onDidCreate(onEnvChange),
    watcher.onDidDelete(onEnvChange),
  );

  void initSchema(context, { silent: true });
}

/**
 * Crea el schema si hay conexión. En la activación los fallos no abren notificaciones:
 * el panel ya los muestra en la banda de estado de Postgres.
 */
async function initSchema(context: vscode.ExtensionContext, { silent }: { silent: boolean }): Promise<void> {
  try {
    await ensureSchema(context.extensionUri);
  } catch (err) {
    if (!silent) {
      vscode.window.showErrorMessage(`LLM Chat: no se pudo crear el schema vscode_chat: ${sanitizeError(err)}`);
    }
  }
}

export function deactivate(): Promise<void> {
  return closePool();
}
