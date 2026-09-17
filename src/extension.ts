import * as vscode from 'vscode';
import { getPostgresUrl, setApiKey, setPostgresUrl } from './config/secrets';
import { closePool, healthCheck, sanitizeError } from './db/pool';
import { ensureSchema } from './db/schema';
import { ChatViewProvider } from './panel/ChatViewProvider';

export function activate(context: vscode.ExtensionContext): void {
  const chatView = new ChatViewProvider(context.extensionUri, context.secrets);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatView));

  context.subscriptions.push(
    vscode.commands.registerCommand('llmChat.newSession', async () => {
      await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
      await chatView.newSession();
    }),

    vscode.commands.registerCommand('llmChat.testConnection', async () => {
      const status = await healthCheck(context.secrets);
      if (status.ok) {
        vscode.window.showInformationMessage('LLM Chat: conexión a Postgres OK.');
      } else {
        vscode.window.showErrorMessage(`LLM Chat: error de conexión a Postgres: ${status.message}`);
      }
    }),

    vscode.commands.registerCommand('llmChat.setApiKey', async () => {
      const value = await vscode.window.showInputBox({
        prompt: 'API key del endpoint compatible con OpenAI',
        password: true,
        ignoreFocusOut: true,
      });
      if (!value) {
        return;
      }
      await setApiKey(context.secrets, value);
      vscode.window.showInformationMessage('LLM Chat: API key guardada.');
    }),

    vscode.commands.registerCommand('llmChat.setPostgresUrl', async () => {
      const value = await vscode.window.showInputBox({
        prompt: 'Cadena de conexión a Postgres',
        placeHolder: 'postgresql://user:pass@localhost:5432/mydb',
        password: true,
        ignoreFocusOut: true,
      });
      if (!value) {
        return;
      }
      await setPostgresUrl(context.secrets, value);
      vscode.window.showInformationMessage('LLM Chat: conexión a Postgres guardada.');
      await initSchema(context);
    }),
  );

  void initSchema(context);
}

/** Crea el schema si ya hay cadena de conexión configurada. */
async function initSchema(context: vscode.ExtensionContext): Promise<void> {
  if (!(await getPostgresUrl(context.secrets))) {
    return;
  }
  try {
    await ensureSchema(context.extensionUri, context.secrets);
  } catch (err) {
    vscode.window.showErrorMessage(`LLM Chat: no se pudo crear el schema vscode_chat: ${sanitizeError(err)}`);
  }
}

export function deactivate(): Promise<void> {
  return closePool();
}
