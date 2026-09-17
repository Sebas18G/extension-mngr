import * as crypto from 'crypto';
import { Pool } from 'pg';
import * as vscode from 'vscode';
import { getApiKey } from '../config/env';
import { getSettings } from '../config/settings';
import { getPool, healthCheck, sanitizeError } from '../db/pool';
import { ensureSchema } from '../db/schema';
import {
  appendMessage,
  createSession,
  getSession,
  listSessions,
  saveUsage,
  updateSessionTitle,
} from '../db/sessions';
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

  constructor(private readonly extensionUri: vscode.Uri) {}

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
      // El webview pide la lista al cargarse; "Reintentar" repite lo mismo tras un fallo de Postgres.
      case 'listSessions':
      case 'retry':
        await this.reload();
        break;
      case 'openSession':
        await this.openSession(msg.sessionId);
        break;
      case 'newSession':
        await this.newSession();
        break;
    }
  }

  /**
   * Comprueba la base y, si responde, recarga la lista y la sesión activa.
   * Público para que un cambio en `.env` refresque el panel sin pulsar "Reintentar".
   */
  async reload(): Promise<void> {
    if (!this.view || this.abortController || !(await this.checkDb())) {
      return;
    }
    await this.refreshSessions({ reportErrors: true });
    // Si el webview se recrea (p. ej. al ocultar y volver a mostrar el panel), restaura la sesión activa.
    if (this.sessionId) {
      await this.openSession(this.sessionId);
    }
  }

  /**
   * Health check + creación idempotente del schema. Informa al webview con `dbStatus` y devuelve si hay base.
   * Crear el schema aquí cubre el caso en que Postgres estaba caído durante la activación.
   */
  private async checkDb(): Promise<boolean> {
    const status = await healthCheck();
    if (status.ok) {
      try {
        await ensureSchema(this.extensionUri);
      } catch (err) {
        this.post({ type: 'dbStatus', ok: false, message: `No se pudo crear el schema vscode_chat: ${sanitizeError(err)}` });
        return false;
      }
    }
    this.post({ type: 'dbStatus', ok: status.ok, message: status.message });
    return status.ok;
  }

  /**
   * Ante un error de base, distingue "Postgres no responde" (estado degradado, input bloqueado)
   * de un error puntual con la base disponible (se muestra como error normal).
   */
  private async reportDbFailure(prefix: string, err: unknown): Promise<void> {
    const status = await healthCheck();
    if (status.ok) {
      this.post({ type: 'error', message: `${prefix}: ${sanitizeError(err)}` });
    } else {
      this.post({ type: 'dbStatus', ok: false, message: status.message });
    }
  }

  /**
   * Crea una sesión vacía con título "Nueva sesión" y la abre.
   * Si la sesión activa todavía no tiene mensajes, se reutiliza en vez de crear otra vacía.
   */
  async newSession(): Promise<void> {
    if (this.abortController) {
      return;
    }
    if (this.sessionId && this.history.length === 0) {
      await this.openSession(this.sessionId);
      return;
    }
    try {
      const settings = getSettings();
      const pool = await getPool();
      const sessionId = await createSession(pool, { model: settings.model, baseUrl: settings.baseUrl });
      await this.openSession(sessionId);
      await this.refreshSessions({ reportErrors: false });
    } catch (err) {
      await this.reportDbFailure('No se pudo crear la sesión', err);
    }
  }

  private async openSession(sessionId: string): Promise<void> {
    if (this.abortController) {
      return;
    }
    try {
      const pool = await getPool();
      const session = await getSession(pool, sessionId);
      if (!session) {
        this.post({ type: 'error', message: 'La sesión ya no existe.' });
        return;
      }
      this.sessionId = session.id;
      this.history = session.messages.map((m) => ({ role: m.role, content: m.content }));
      this.post({ type: 'sessionLoaded', session });
    } catch (err) {
      await this.reportDbFailure('No se pudo cargar la sesión', err);
    }
  }

  private async refreshSessions({ reportErrors }: { reportErrors: boolean }): Promise<void> {
    try {
      const pool = await getPool();
      this.post({ type: 'sessions', items: await listSessions(pool) });
    } catch (err) {
      if (reportErrors) {
        await this.reportDbFailure('No se pudo cargar la lista de sesiones', err);
      }
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
      let apiKey: string;
      try {
        apiKey = await getApiKey();
      } catch (err) {
        this.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        return;
      }

      // Los ajustes se leen en cada envío para que los cambios apliquen sin reiniciar.
      const settings = getSettings();

      // El mensaje del usuario se guarda antes de llamar al LLM: si Postgres falla, no se envía nada.
      let pool: Pool;
      try {
        pool = await getPool();
        if (!this.sessionId) {
          this.sessionId = await createSession(pool, {
            title: deriveTitle(text),
            model: settings.model,
            baseUrl: settings.baseUrl,
          });
        } else if (this.history.length === 0) {
          // Sesión creada vacía con "Nueva sesión": el título pasa a derivarse del primer mensaje.
          await updateSessionTitle(pool, this.sessionId, deriveTitle(text));
        }
        await appendMessage(pool, this.sessionId, 'user', text);
      } catch (err) {
        // No se llama al LLM: el mensaje no quedó guardado.
        await this.reportDbFailure('No se pudo guardar el mensaje en Postgres', err);
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
          // La respuesta ya está en pantalla: se avisa explícitamente de que no quedó guardada.
          this.post({ type: 'error', message: `La respuesta no se guardó en Postgres: ${sanitizeError(err)}` });
          const status = await healthCheck();
          if (!status.ok) {
            this.post({ type: 'dbStatus', ok: false, message: status.message });
          }
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
      // updated_at y el total de tokens cambiaron: la lista se reordena.
      await this.refreshSessions({ reportErrors: false });
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
    <div id="db-status" class="db-status" role="alert" hidden>
      <span id="db-status-message"></span>
      <button id="retry" type="button">Reintentar</button>
    </div>
    <section id="sessions-section">
      <header class="section-header">
        <h2>Sesiones</h2>
        <button id="new-session" type="button" class="secondary">Nueva sesión</button>
      </header>
      <ul id="sessions" class="sessions"></ul>
    </section>
    <section id="usage-section">
      <header class="section-header">
        <h2>Consumo</h2>
      </header>
      <table class="usage">
        <thead>
          <tr><th></th><th>Prompt</th><th>Completion</th><th>Total</th></tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Sesión</th>
            <td id="usage-prompt">—</td>
            <td id="usage-completion">—</td>
            <td id="usage-total">—</td>
          </tr>
          <tr>
            <th scope="row">Global</th>
            <td colspan="2"></td>
            <td id="usage-global">—</td>
          </tr>
        </tbody>
      </table>
    </section>
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
