import * as vscode from 'vscode';

const API_KEY = 'llmChat.apiKey';
const POSTGRES_URL = 'llmChat.postgresUrl';

export function getApiKey(secrets: vscode.SecretStorage): Thenable<string | undefined> {
  return secrets.get(API_KEY);
}

export function setApiKey(secrets: vscode.SecretStorage, value: string): Thenable<void> {
  return secrets.store(API_KEY, value);
}

export function getPostgresUrl(secrets: vscode.SecretStorage): Thenable<string | undefined> {
  return secrets.get(POSTGRES_URL);
}

export function setPostgresUrl(secrets: vscode.SecretStorage, value: string): Thenable<void> {
  return secrets.store(POSTGRES_URL, value);
}
