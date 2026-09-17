CREATE SCHEMA IF NOT EXISTS vscode_chat;

CREATE TABLE IF NOT EXISTS vscode_chat.sessions (
  id          uuid PRIMARY KEY,
  title       text        NOT NULL,
  model       text        NOT NULL,
  base_url    text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vscode_chat.messages (
  id          bigserial   PRIMARY KEY,
  session_id  uuid        NOT NULL REFERENCES vscode_chat.sessions(id) ON DELETE CASCADE,
  role        text        NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
  content     text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_session_id_idx
  ON vscode_chat.messages (session_id, id);

CREATE TABLE IF NOT EXISTS vscode_chat.message_usage (
  message_id        bigint PRIMARY KEY REFERENCES vscode_chat.messages(id) ON DELETE CASCADE,
  prompt_tokens     integer,
  completion_tokens integer,
  total_tokens      integer,
  model             text NOT NULL
);
