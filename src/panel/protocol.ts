import { AttachmentRef, SessionDetail, SessionSummary, StoredAttachment, Usage } from '../types';

// webview → extensión
export type ToHost =
  | { type: 'send'; text: string; attachments: AttachmentRef[] }
  | { type: 'pickFile' }
  | { type: 'searchFiles'; query: string }
  | { type: 'newSession' }
  | { type: 'openSession'; sessionId: string }
  | { type: 'listSessions' }
  | { type: 'cancel' }
  | { type: 'retry' };

// extensión → webview
export type ToWebview =
  | { type: 'sessions'; items: SessionSummary[] }
  | { type: 'sessionLoaded'; session: SessionDetail }
  // El mensaje de usuario en curso quedó guardado; lleva los adjuntos tal como se enviaron (líneas, truncado).
  | { type: 'userMessageSaved'; attachments: StoredAttachment[] }
  | { type: 'filePicked'; path: string }
  | { type: 'fileSuggestions'; query: string; items: string[] } // máx. 20 rutas
  | { type: 'delta'; text: string }
  | { type: 'done'; usage: Usage | null }
  | { type: 'error'; message: string }
  | { type: 'dbStatus'; ok: boolean; message?: string };
