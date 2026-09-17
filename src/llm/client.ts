import { Role, Usage } from '../types';

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface StreamChatOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  temperature: number;
  signal?: AbortSignal;
}

/**
 * Hace streaming contra `{baseUrl}/chat/completions` (formato OpenAI).
 * Llama a `onDelta` por cada fragmento de contenido y devuelve el `usage` del chunk final,
 * o `null` si el endpoint no lo informa o si la petición se cancela con `signal`.
 */
export async function streamChat(
  messages: ChatMessage[],
  opts: StreamChatOptions,
  onDelta: (text: string) => void,
): Promise<Usage | null> {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let usage: Usage | null = null;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: opts.signal,
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(`El endpoint respondió ${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        const result = handleLine(line, onDelta);
        if (result === 'done') {
          return usage;
        }
        if (result) {
          usage = result;
        }
      }
    }

    const result = handleLine(buffer.trim(), onDelta);
    if (result && result !== 'done') {
      usage = result;
    }
    return usage;
  } catch (err) {
    if (opts.signal?.aborted) {
      return usage;
    }
    throw err;
  }
}

/** Procesa una línea SSE. Devuelve el usage si el chunk lo trae, 'done' al llegar [DONE]. */
function handleLine(line: string, onDelta: (text: string) => void): Usage | 'done' | undefined {
  if (!line.startsWith('data:')) {
    return undefined;
  }
  const data = line.slice(5).trim();
  if (data === '[DONE]') {
    return 'done';
  }

  let chunk: any;
  try {
    chunk = JSON.parse(data);
  } catch {
    return undefined;
  }

  if (chunk.error) {
    throw new Error(chunk.error.message ?? JSON.stringify(chunk.error));
  }

  const content = chunk.choices?.[0]?.delta?.content;
  if (typeof content === 'string' && content.length > 0) {
    onDelta(content);
  }

  if (chunk.usage) {
    return {
      prompt_tokens: chunk.usage.prompt_tokens ?? null,
      completion_tokens: chunk.usage.completion_tokens ?? null,
      total_tokens: chunk.usage.total_tokens ?? null,
    };
  }
  return undefined;
}
