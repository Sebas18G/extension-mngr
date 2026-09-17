import { ChatMessage } from '../llm/client';
import { AttachmentWithContent } from '../types';

/** Caracteres por token en la estimación. Con Ollama no hay tokenizador disponible en la extensión. */
const CHARS_PER_TOKEN = 4;

/**
 * Adjunto ya leído, antes de aplicar el presupuesto de tokens.
 * `truncated` indica que la lectura ya se cortó (archivo mayor que lo que podría caber).
 */
export type ResolvedAttachment = Omit<AttachmentWithContent, 'truncated' | 'estTokens'> & { truncated?: boolean };

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Compone el mensaje de usuario que ve el LLM: adjuntos delante del texto, en orden.
 * Es la única fuente del formato, tanto al enviar como al reconstruir una sesión reabierta.
 */
export function buildUserContent(text: string, attachments: AttachmentWithContent[]): string {
  const blocks = attachments.map((a) => {
    const attrs = [`kind="${a.kind}"`];
    if (a.path !== null) {
      attrs.push(`path="${escapeAttr(a.path)}"`);
    }
    if (a.startLine !== null && a.endLine !== null) {
      attrs.push(`lines="${a.startLine}-${a.endLine}"`);
    }
    if (a.truncated) {
      attrs.push('truncated="true"');
    }
    return `<context ${attrs.join(' ')}>\n${a.content}\n</context>`;
  });
  return [...blocks, text].join('\n\n');
}

/** Tokens estimados de system prompt + historial ya compuesto + texto nuevo, sin los adjuntos nuevos. */
export function estimateBase(systemPrompt: string, history: ChatMessage[], text: string): number {
  return (
    estimateTokens(systemPrompt) + history.reduce((sum, m) => sum + estimateTokens(m.content), 0) + estimateTokens(text)
  );
}

export function sessionOverLimitMessage(base: number): string {
  return `La sesión supera el límite de llmChat.maxContextTokens (${base} tokens estimados). Abre una nueva sesión.`;
}

/**
 * Reparte el presupuesto restante entre los adjuntos nuevos, en orden.
 * Un adjunto que no cabe se trunca a lo disponible; sin presupuesto queda vacío, pero se guarda marcado.
 */
export function applyBudget(attachments: ResolvedAttachment[], remainingTokens: number): AttachmentWithContent[] {
  let remaining = Math.max(0, remainingTokens);
  return attachments.map((a) => {
    let content = a.content;
    let truncated = a.truncated ?? false;
    if (estimateTokens(content) > remaining) {
      content = content.slice(0, remaining * CHARS_PER_TOKEN);
      truncated = true;
    }
    const estTokens = estimateTokens(content);
    remaining -= estTokens;
    return { ...a, content, truncated, estTokens };
  });
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
