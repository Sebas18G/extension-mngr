CREATE TABLE IF NOT EXISTS vscode_chat.message_context (
  id          bigserial PRIMARY KEY,
  message_id  bigint   NOT NULL REFERENCES vscode_chat.messages(id) ON DELETE CASCADE,
  position    smallint NOT NULL,
  kind        text     NOT NULL CHECK (kind IN ('activeFile', 'selection', 'tree', 'file')),
  path        text,
  start_line  integer,
  end_line    integer,
  content     text     NOT NULL,
  truncated   boolean  NOT NULL DEFAULT false,
  est_tokens  integer  NOT NULL
);

CREATE INDEX IF NOT EXISTS message_context_message_id_idx
  ON vscode_chat.message_context (message_id, position);
