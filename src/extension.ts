import * as vscode from 'vscode';
import { ChatViewProvider } from './panel/ChatViewProvider';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      new ChatViewProvider(context.extensionUri),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('llmChat.testConnection', () => {
      vscode.window.showInformationMessage('LLM Chat: la extensión está activa.');
    }),
  );
}

export function deactivate(): void {}
