// @ts-check
(function () {
  // @ts-ignore acquireVsCodeApi lo inyecta VS Code en el webview.
  const vscode = acquireVsCodeApi();

  const sessionsEl = /** @type {HTMLUListElement} */ (document.getElementById('sessions'));
  const newSessionBtn = /** @type {HTMLButtonElement} */ (document.getElementById('new-session'));
  const messagesEl = /** @type {HTMLElement} */ (document.getElementById('messages'));
  const errorEl = /** @type {HTMLElement} */ (document.getElementById('error'));
  const streamingEl = /** @type {HTMLElement} */ (document.getElementById('streaming'));
  const cancelBtn = /** @type {HTMLButtonElement} */ (document.getElementById('cancel'));
  const form = /** @type {HTMLFormElement} */ (document.getElementById('composer'));
  const input = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
  const sendBtn = /** @type {HTMLButtonElement} */ (document.getElementById('send'));
  const usagePromptEl = /** @type {HTMLElement} */ (document.getElementById('usage-prompt'));
  const usageCompletionEl = /** @type {HTMLElement} */ (document.getElementById('usage-completion'));
  const usageTotalEl = /** @type {HTMLElement} */ (document.getElementById('usage-total'));
  const usageGlobalEl = /** @type {HTMLElement} */ (document.getElementById('usage-global'));

  /** @type {HTMLElement | null} */
  let currentReply = null;
  let streaming = false;
  /** @type {string | null} */
  let activeSessionId = null;
  /** @type {any[]} */
  let sessions = [];

  /**
   * @param {'system' | 'user' | 'assistant'} role
   * @param {string} text
   */
  function addBubble(role, text) {
    const bubble = document.createElement('div');
    bubble.className = `bubble ${role}`;
    bubble.textContent = text;
    messagesEl.appendChild(bubble);
    scrollToBottom();
    return bubble;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  /** @param {number | null} value */
  function formatTokens(value) {
    return value === null || value === undefined ? '—' : value.toLocaleString();
  }

  function renderSessions() {
    renderUsage();
    sessionsEl.replaceChildren();
    if (sessions.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'Aún no hay sesiones.';
      sessionsEl.appendChild(empty);
      return;
    }
    for (const session of sessions) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'session';
      button.disabled = streaming;
      if (session.id === activeSessionId) {
        button.classList.add('active');
        button.setAttribute('aria-current', 'true');
      }

      const title = document.createElement('span');
      title.className = 'session-title';
      title.textContent = session.title;

      const meta = document.createElement('span');
      meta.className = 'session-meta';
      meta.textContent = `${new Date(session.updatedAt).toLocaleString()} · ${formatTokens(session.usage.total_tokens)} tokens`;

      button.append(title, meta);
      button.addEventListener('click', () => {
        if (!streaming && session.id !== activeSessionId) {
          vscode.postMessage({ type: 'openSession', sessionId: session.id });
        }
      });
      item.appendChild(button);
      sessionsEl.appendChild(item);
    }
  }

  /**
   * Sesión activa: sus SUM tal como llegan de Postgres.
   * Global: suma de los totales de todas las sesiones; como SUM en SQL, ignora NULL y es NULL si no hay ningún valor.
   */
  function renderUsage() {
    const active = sessions.find((s) => s.id === activeSessionId);
    usagePromptEl.textContent = formatTokens(active ? active.usage.prompt_tokens : null);
    usageCompletionEl.textContent = formatTokens(active ? active.usage.completion_tokens : null);
    usageTotalEl.textContent = formatTokens(active ? active.usage.total_tokens : null);

    const known = sessions.map((s) => s.usage.total_tokens).filter((t) => t !== null && t !== undefined);
    usageGlobalEl.textContent = formatTokens(known.length > 0 ? known.reduce((a, b) => a + b, 0) : null);
  }

  /** @param {any} session */
  function loadSession(session) {
    activeSessionId = session.id;
    currentReply = null;
    messagesEl.replaceChildren();
    for (const message of session.messages) {
      addBubble(message.role, message.content);
    }
    showError(null);
    renderSessions();
    input.focus();
  }

  /** @param {boolean} value */
  function setStreaming(value) {
    streaming = value;
    streamingEl.hidden = !value;
    sendBtn.disabled = value;
    newSessionBtn.disabled = value;
    if (!value) {
      if (currentReply && !currentReply.textContent) {
        currentReply.remove();
      }
      currentReply = null;
      input.focus();
    }
    renderSessions();
  }

  /** @param {string | null} message */
  function showError(message) {
    errorEl.hidden = !message;
    errorEl.textContent = message ?? '';
  }

  function send() {
    const text = input.value.trim();
    if (!text || streaming) {
      return;
    }
    showError(null);
    addBubble('user', text);
    currentReply = addBubble('assistant', '');
    input.value = '';
    setStreaming(true);
    vscode.postMessage({ type: 'send', text });
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    send();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    }
  });

  cancelBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'cancel' });
  });

  newSessionBtn.addEventListener('click', () => {
    if (!streaming) {
      vscode.postMessage({ type: 'newSession' });
    }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'sessions':
        sessions = msg.items;
        // Tras el primer envío de una sesión nueva, la activa es la más reciente.
        if (!activeSessionId && sessions.length > 0 && messagesEl.childElementCount > 0) {
          activeSessionId = sessions[0].id;
        }
        renderSessions();
        break;
      case 'sessionLoaded':
        loadSession(msg.session);
        break;
      case 'delta':
        if (currentReply) {
          currentReply.textContent += msg.text;
          scrollToBottom();
        }
        break;
      case 'done':
        setStreaming(false);
        break;
      case 'error':
        setStreaming(false);
        showError(msg.message);
        break;
    }
  });

  renderSessions();
  vscode.postMessage({ type: 'listSessions' });
  input.focus();
})();
