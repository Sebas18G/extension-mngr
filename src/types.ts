export type Role = 'system' | 'user' | 'assistant';

/** Tokens de una respuesta o agregados. `null` significa "desconocido", nunca 0. */
export interface Usage {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
}

export interface SessionSummary {
  id: string;
  title: string;
  model: string;
  baseUrl: string;
  createdAt: string;
  updatedAt: string;
  /** SUM sobre message_usage de la sesión, calculado al consultar. */
  usage: Usage;
}

export type AttachmentKind = 'activeFile' | 'selection' | 'tree' | 'file';

/** Lo que el webview pide adjuntar. El contenido se resuelve en la extensión al enviar. */
export type AttachmentRef =
  | { kind: 'activeFile' }
  | { kind: 'selection' }
  | { kind: 'tree' }
  | { kind: 'file'; path: string };

export interface StoredAttachment {
  kind: AttachmentKind;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  truncated: boolean;
  estTokens: number;
}

/** Adjunto con el texto exacto enviado al LLM. Solo vive en la extensión; no viaja al webview. */
export interface AttachmentWithContent extends StoredAttachment {
  content: string;
}

export interface StoredMessage {
  id: string;
  role: Role;
  content: string;
  createdAt: string;
  attachments: StoredAttachment[]; // vacío en mensajes de assistant
}

export interface SessionDetail extends SessionSummary {
  messages: StoredMessage[];
}
