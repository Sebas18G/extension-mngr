import { SessionDetail, SessionSummary, Usage } from '../types';

// webview → extensión
export type ToHost =
  | { type: 'send'; text: string }
  | { type: 'newSession' }
  | { type: 'openSession'; sessionId: string }
  | { type: 'listSessions' }
  | { type: 'cancel' }
  | { type: 'retry' };

// extensión → webview
export type ToWebview =
  | { type: 'sessions'; items: SessionSummary[] }
  | { type: 'sessionLoaded'; session: SessionDetail }
  | { type: 'delta'; text: string }
  | { type: 'done'; usage: Usage | null }
  | { type: 'error'; message: string }
  | { type: 'dbStatus'; ok: boolean; message?: string };
