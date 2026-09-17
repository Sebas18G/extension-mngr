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
  const dbStatusEl = /** @type {HTMLElement} */ (document.getElementById('db-status'));
  const dbStatusMessageEl = /** @type {HTMLElement} */ (document.getElementById('db-status-message'));
  const retryBtn = /** @type {HTMLButtonElement} */ (document.getElementById('retry'));
  const attachActiveBtn = /** @type {HTMLButtonElement} */ (document.getElementById('attach-active'));
  const attachSelectionBtn = /** @type {HTMLButtonElement} */ (document.getElementById('attach-selection'));
  const attachTreeBtn = /** @type {HTMLButtonElement} */ (document.getElementById('attach-tree'));
  const attachFileBtn = /** @type {HTMLButtonElement} */ (document.getElementById('attach-file'));
  const suggestionsEl = /** @type {HTMLUListElement} */ (document.getElementById('suggestions'));
  const chipsEl = /** @type {HTMLUListElement} */ (document.getElementById('chips'));

  const KIND_LABELS = {
    activeFile: 'Archivo activo',
    selection: 'Selección',
    tree: 'Árbol',
    file: 'Archivo',
  };

  /**
   * Referencias pendientes de adjuntar. Solo guardan qué adjuntar: el contenido se lee al enviar.
   * @type {any[]}
   */
  let chips = [];
  /** Chips del envío en curso, para devolverlos si el mensaje no llegó a guardarse. */
  /** @type {any[]} */
  let pendingChips = [];
  /** Si la extensión confirmó que el mensaje de usuario en curso quedó guardado. */
  let pendingSaved = false;

  const SUGGEST_DEBOUNCE_MS = 200;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let suggestTimer;
  /**
   * Mención que se está escribiendo: posición del `@` y texto tras él hasta el cursor.
   * @type {{ start: number; query: string } | null}
   */
  let mention = null;
  /** @type {string[]} */
  let suggestions = [];
  let selectedSuggestion = 0;

  /** @type {HTMLElement | null} */
  let currentReply = null;
  /** Burbuja y texto del envío en curso, para deshacerlos si Postgres no llegó a guardar el mensaje. */
  /** @type {HTMLElement | null} */
  let pendingUserBubble = null;
  let pendingText = '';
  let streaming = false;
  // Hasta recibir el primer dbStatus no se permite enviar.
  let dbOk = false;
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

  /**
   * Burbuja de usuario con la lista de adjuntos encima del texto.
   * @param {string} text
   * @param {any[]} attachments adjuntos guardados o referencias de chips
   */
  function addUserBubble(text, attachments) {
    const bubble = addBubble('user', '');
    const list = document.createElement('ul');
    list.className = 'bubble-attachments';
    const body = document.createElement('div');
    body.textContent = text;
    bubble.append(list, body);
    renderBubbleAttachments(bubble, attachments);
    scrollToBottom();
    return bubble;
  }

  /**
   * @param {HTMLElement} bubble
   * @param {any[]} attachments
   */
  function renderBubbleAttachments(bubble, attachments) {
    const list = /** @type {HTMLElement} */ (bubble.querySelector('.bubble-attachments'));
    list.replaceChildren();
    list.hidden = attachments.length === 0;
    for (const attachment of attachments) {
      const item = document.createElement('li');
      item.textContent = describeAttachment(attachment);
      if (attachment.truncated) {
        const flag = document.createElement('span');
        flag.className = 'truncated';
        flag.textContent = 'truncado';
        item.append(' · ', flag);
      }
      list.appendChild(item);
    }
  }

  /** @param {any} attachment */
  function describeAttachment(attachment) {
    let label = KIND_LABELS[/** @type {keyof typeof KIND_LABELS} */ (attachment.kind)] ?? attachment.kind;
    if (attachment.path) {
      label += `: ${attachment.path}`;
    }
    if (attachment.startLine != null && attachment.endLine != null) {
      label += ` (líneas ${attachment.startLine}-${attachment.endLine})`;
    }
    return label;
  }

  /** @param {any} ref */
  function chipKey(ref) {
    return `${ref.kind}:${ref.path ?? ''}`;
  }

  /** @param {any} ref */
  function addChip(ref) {
    if (!chips.some((c) => chipKey(c) === chipKey(ref))) {
      chips.push(ref);
      renderChips();
    }
  }

  function renderChips() {
    chipsEl.replaceChildren();
    chipsEl.hidden = chips.length === 0;
    for (const ref of chips) {
      const item = document.createElement('li');
      item.className = 'chip';
      const label = document.createElement('span');
      label.textContent = describeAttachment(ref);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'chip-remove';
      remove.textContent = '×';
      remove.title = 'Quitar adjunto';
      remove.setAttribute('aria-label', `Quitar ${describeAttachment(ref)}`);
      remove.addEventListener('click', () => {
        chips = chips.filter((c) => chipKey(c) !== chipKey(ref));
        renderChips();
        input.focus();
      });
      item.append(label, remove);
      chipsEl.appendChild(item);
    }
  }

  /** Deshace un envío que no llegó a guardarse: quita la burbuja y devuelve texto y chips. */
  function restorePending() {
    if (pendingUserBubble && !pendingSaved) {
      pendingUserBubble.remove();
      if (!input.value) {
        input.value = pendingText;
      }
      if (chips.length === 0) {
        chips = pendingChips;
        renderChips();
      }
    }
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
      button.disabled = streaming || !dbOk;
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
        if (!streaming && dbOk && session.id !== activeSessionId) {
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
      if (message.role === 'user') {
        addUserBubble(message.content, message.attachments ?? []);
      } else {
        addBubble(message.role, message.content);
      }
    }
    showError(null);
    renderSessions();
    input.focus();
  }

  /** @param {boolean} value */
  function setStreaming(value) {
    streaming = value;
    streamingEl.hidden = !value;
    if (!value) {
      if (currentReply && !currentReply.textContent) {
        currentReply.remove();
      }
      currentReply = null;
      pendingUserBubble = null;
      pendingText = '';
      pendingChips = [];
      pendingSaved = false;
      input.focus();
    }
    updateControls();
  }

  function updateControls() {
    const blocked = streaming || !dbOk;
    input.disabled = !dbOk;
    sendBtn.disabled = blocked;
    newSessionBtn.disabled = blocked;
    attachActiveBtn.disabled = blocked;
    attachSelectionBtn.disabled = blocked;
    attachTreeBtn.disabled = blocked;
    attachFileBtn.disabled = blocked;
    renderSessions();
  }

  /**
   * @param {boolean} ok
   * @param {string | undefined} message
   */
  function setDbStatus(ok, message) {
    dbOk = ok;
    dbStatusEl.hidden = ok;
    dbStatusMessageEl.textContent = ok ? '' : `Sin conexión a Postgres: ${message ?? 'error desconocido'}`;
    retryBtn.disabled = false;

    if (!ok && streaming) {
      // El mensaje no llegó a guardarse: se quita de la conversación y se devuelve al input.
      restorePending();
      setStreaming(false);
    } else {
      updateControls();
    }
  }

  /** @param {string | null} message */
  function showError(message) {
    errorEl.hidden = !message;
    errorEl.textContent = message ?? '';
  }

  function send() {
    const text = input.value.trim();
    if (!text || streaming || !dbOk) {
      return;
    }
    showError(null);
    const attachments = chips;
    pendingUserBubble = addUserBubble(text, attachments);
    pendingText = text;
    pendingChips = attachments;
    pendingSaved = false;
    currentReply = addBubble('assistant', '');
    input.value = '';
    closeSuggestions();
    chips = [];
    renderChips();
    setStreaming(true);
    vscode.postMessage({ type: 'send', text, attachments });
  }

  function suggestionsOpen() {
    return !suggestionsEl.hidden && suggestions.length > 0;
  }

  /** Detecta una mención `@texto` que termina en el cursor y pide sugerencias con debounce. */
  function updateMention() {
    clearTimeout(suggestTimer);
    const caret = input.selectionStart ?? input.value.length;
    const match = /(?:^|\s)@(\S+)$/.exec(input.value.slice(0, caret));
    if (!match || input.selectionStart !== input.selectionEnd) {
      closeSuggestions();
      return;
    }
    mention = { start: caret - match[1].length - 1, query: match[1] };
    const query = match[1];
    suggestTimer = setTimeout(() => {
      vscode.postMessage({ type: 'searchFiles', query });
    }, SUGGEST_DEBOUNCE_MS);
  }

  function closeSuggestions() {
    clearTimeout(suggestTimer);
    mention = null;
    suggestions = [];
    suggestionsEl.hidden = true;
    suggestionsEl.replaceChildren();
    input.removeAttribute('aria-activedescendant');
  }

  function renderSuggestions() {
    suggestionsEl.replaceChildren();
    suggestionsEl.hidden = suggestions.length === 0;
    suggestions.forEach((item, index) => {
      const option = document.createElement('li');
      option.id = `suggestion-${index}`;
      option.className = 'suggestion';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === selectedSuggestion));
      option.textContent = `@${item}`;
      // mousedown en vez de click para no quitar el foco al textarea antes de aceptar.
      option.addEventListener('mousedown', (event) => {
        event.preventDefault();
        acceptSuggestion(index);
      });
      suggestionsEl.appendChild(option);
    });
    if (suggestions.length > 0) {
      input.setAttribute('aria-activedescendant', `suggestion-${selectedSuggestion}`);
      suggestionsEl.children[selectedSuggestion]?.scrollIntoView({ block: 'nearest' });
    }
  }

  /**
   * Sustituye la mención en curso (hasta el siguiente espacio, aunque el cursor esté en medio)
   * por la sugerencia y deja un espacio detrás.
   * @param {number} index
   */
  function acceptSuggestion(index) {
    const item = suggestions[index];
    if (!mention || item === undefined) {
      closeSuggestions();
      return;
    }
    const tokenEnd = input.value.slice(mention.start).search(/\s/);
    const end = tokenEnd === -1 ? input.value.length : mention.start + tokenEnd;
    const before = input.value.slice(0, mention.start);
    const after = input.value.slice(end).replace(/^\s*/, '');
    const inserted = `@${item} `;
    input.value = before + inserted + after;
    const caret = before.length + inserted.length;
    input.setSelectionRange(caret, caret);
    closeSuggestions();
    input.focus();
  }

  input.addEventListener('input', updateMention);
  input.addEventListener('click', updateMention);
  input.addEventListener('blur', closeSuggestions);

  attachActiveBtn.addEventListener('click', () => {
    addChip({ kind: 'activeFile' });
    input.focus();
  });

  attachSelectionBtn.addEventListener('click', () => {
    addChip({ kind: 'selection' });
    input.focus();
  });

  attachTreeBtn.addEventListener('click', () => {
    addChip({ kind: 'tree' });
    input.focus();
  });

  attachFileBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'pickFile' });
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    send();
  });

  input.addEventListener('keydown', (event) => {
    if (event.isComposing) {
      return;
    }
    // Con la lista abierta, Enter y Tab aceptan la sugerencia en vez de enviar.
    if (suggestionsOpen()) {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          selectedSuggestion = (selectedSuggestion + 1) % suggestions.length;
          renderSuggestions();
          return;
        case 'ArrowUp':
          event.preventDefault();
          selectedSuggestion = (selectedSuggestion - 1 + suggestions.length) % suggestions.length;
          renderSuggestions();
          return;
        case 'Enter':
        case 'Tab':
          event.preventDefault();
          acceptSuggestion(selectedSuggestion);
          return;
        case 'Escape':
          event.preventDefault();
          closeSuggestions();
          return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

  cancelBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'cancel' });
  });

  newSessionBtn.addEventListener('click', () => {
    if (!streaming && dbOk) {
      vscode.postMessage({ type: 'newSession' });
    }
  });

  retryBtn.addEventListener('click', () => {
    retryBtn.disabled = true;
    vscode.postMessage({ type: 'retry' });
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
      case 'fileSuggestions':
        // Se descartan respuestas de consultas que ya no coinciden con lo escrito.
        if (mention && msg.query === mention.query) {
          suggestions = msg.items;
          selectedSuggestion = 0;
          renderSuggestions();
        }
        break;
      case 'filePicked':
        addChip({ kind: 'file', path: msg.path });
        input.focus();
        break;
      case 'userMessageSaved':
        pendingSaved = true;
        if (pendingUserBubble) {
          renderBubbleAttachments(pendingUserBubble, msg.attachments);
        }
        break;
      case 'error':
        // Si falló antes de guardar (adjunto inválido, límite, API key), nada quedó en la base.
        if (streaming) {
          restorePending();
        }
        setStreaming(false);
        showError(msg.message);
        break;
      case 'dbStatus':
        setDbStatus(msg.ok, msg.message);
        break;
    }
  });

  updateControls();
  vscode.postMessage({ type: 'listSessions' });
  input.focus();
})();
