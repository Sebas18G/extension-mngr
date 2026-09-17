import * as crypto from 'crypto';
import { Pool } from 'pg';
import * as vscode from 'vscode';
import { getApiKey } from '../config/secrets';
import { getSettings } from '../config/settings';
import { getPool, sanitizeError } from '../db/pool';
import { appendMessage, createSession, saveUsage } from '../db/sessions';
import { ChatMessage, streamChat } from '../llm/client';
import { Usage } from '../types';
import { ToHost, ToWebview } from './protocol';

const TITLE_LENGTH = 60;

function deriveTitle(firstMessage: string): string {
  return firstMessage.trim().slice(0, TITLE_LENGTH);
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'llmChat.chatView';

  private view?: vscode.WebviewView;
  private sessionId?: string;
  private history: ChatMessage[] = [];
  private abortController?: AbortController;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secrets: vscode.SecretStorage,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const mediaUri = vscode.Uri.joinPath(this.extensionUri, 'media');
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaUri],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: ToHost) => this.handleMessage(msg));
    webviewView.onDidDispose(() => {
      this.abortController?.abort();
      this.view = undefined;
    });
  }

  private async handleMessage(msg: ToHost): Promise<void> {
    switch (msg.type) {
      case 'send':
        await this.send(msg.text);
        break;
      case 'cancel':
        this.abortController?.abort();
        break;
    }
  }

  private async send(text: string): Promise<void> {
    if (this.abortController || !text.trim()) {
      return;
    }
    // Se marca el envío en curso antes del primer await para descartar envíos concurrentes.
    const controller = new AbortController();
    this.abortController = controller;

    try {
      const apiKey = await getApiKey(this.secrets);
      if (!apiKey) {
        this.post({ type: 'error', message: 'No hay API key. Ejecuta "LLM Chat: Configurar API key".' });
        return;
      }

      // Los ajustes se leen en cada envío para que los cambios apliquen sin reiniciar.
      const settings = getSettings();

      // El mensaje del usuario se guarda antes de llamar al LLM: si Postgres falla, no se envía nada.
      let pool: Pool;
      try {
        pool = await getPool(this.secrets);
        if (!this.sessionId) {
          this.sessionId = await createSession(pool, {
            title: deriveTitle(text),
            model: settings.model,
            baseUrl: settings.baseUrl,
          });
        }
        await appendMessage(pool, this.sessionId, 'user', text);
      } catch (err) {
        this.post({ type: 'error', message: `No se pudo guardar el mensaje en Postgres: ${sanitizeError(err)}` });
        return;
      }
      this.history.push({ role: 'user', content: text });

      const messages: ChatMessage[] = settings.systemPrompt
        ? [{ role: 'system', content: settings.systemPrompt }, ...this.history]
        : [...this.history];

      let reply = '';
      let usage: Usage | null = null;
      let streamError: unknown;
      try {
        usage = await streamChat(messages, { ...settings, apiKey, signal: controller.signal }, (delta) => {
          reply += delta;
          this.post({ type: 'delta', text: delta });
        });
      } catch (err) {
        streamError = err;
      }

      // Lo recibido se guarda también si el stream se canceló o falló a mitad.
      if (reply) {
        try {
          const messageId = await appendMessage(pool, this.sessionId, 'assistant', reply);
          await saveUsage(pool, messageId, usage, settings.model);
          this.history.push({ role: 'assistant', content: reply });
        } catch (err) {
          this.post({ type: 'error', message: `No se pudo guardar la respuesta en Postgres: ${sanitizeError(err)}` });
          return;
        }
      }

      if (streamError) {
        this.post({ type: 'error', message: streamError instanceof Error ? streamError.message : String(streamError) });
      } else {
        this.post({ type: 'done', usage });
      }
    } finally {
      this.abortController = undefined;
    }
  }

  private post(msg: ToWebview): void {
    void this.view?.webview.postMessage(msg);
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.css'));
    const nonce = crypto.randomBytes(16).toString('base64');

    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>LLM Chat</title>
</head>
<body>
  <main id="chat">
    <div id="messages" aria-live="polite"></div>
    <div id="error" class="error" hidden></div>
    <div id="streaming" class="streaming" hidden>
      <span class="dots">Generando respuesta</span>
      <button id="cancel" type="button" class="secondary">Cancelar</button>
    </div>
    <form id="composer">
      <textarea id="input" rows="3" placeholder="Escribe un mensaje (Enter para enviar, Shift+Enter para nueva línea)"></textarea>
      <button id="send" type="submit">Enviar</button>
    </form>
  </main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
