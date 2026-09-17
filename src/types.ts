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
  totalTokens: number | null;
}

export interface StoredMessage {
  id: string;
  role: Role;
  content: string;
  createdAt: string;
}

export interface SessionDetail extends SessionSummary {
  messages: StoredMessage[];
}
