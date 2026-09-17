import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('llmChat.testConnection', () => {
      vscode.window.showInformationMessage('LLM Chat: la extensión está activa.');
    }),
  );
}

export function deactivate(): void {}
