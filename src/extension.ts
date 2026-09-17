import * as vscode from 'vscode';
import { setApiKey, setPostgresUrl } from './config/secrets';
import { closePool, healthCheck } from './db/pool';
import { ChatViewProvider } from './panel/ChatViewProvider';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      new ChatViewProvider(context.extensionUri),
    ),
  );

  context.subscriptions.push(
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
    }),
  );
}

export function deactivate(): Promise<void> {
  return closePool();
}
