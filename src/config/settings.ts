import * as vscode from 'vscode';

export interface LlmSettings {
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
  systemPrompt: string;
  /** Límite estimado por envío (system prompt + historial + texto + adjuntos). */
  maxContextTokens: number;
}

/** Se lee en cada petición para que los cambios en settings.json apliquen sin reiniciar. */
export function getSettings(): LlmSettings {
  const config = vscode.workspace.getConfiguration('llmChat');
  return {
    baseUrl: config.get<string>('baseUrl', 'https://api.openai.com/v1'),
    model: config.get<string>('model', 'gpt-4o-mini'),
    maxTokens: config.get<number>('maxTokens', 4096),
    temperature: config.get<number>('temperature', 0.7),
    systemPrompt: config.get<string>('systemPrompt', ''),
    maxContextTokens: config.get<number>('maxContextTokens', 200000),
  };
}
