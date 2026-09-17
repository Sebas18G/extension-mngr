// @ts-check
(function () {
  // @ts-ignore acquireVsCodeApi lo inyecta VS Code en el webview.
  const vscode = acquireVsCodeApi();

  const messagesEl = /** @type {HTMLElement} */ (document.getElementById('messages'));
  const errorEl = /** @type {HTMLElement} */ (document.getElementById('error'));
  const streamingEl = /** @type {HTMLElement} */ (document.getElementById('streaming'));
  const cancelBtn = /** @type {HTMLButtonElement} */ (document.getElementById('cancel'));
  const form = /** @type {HTMLFormElement} */ (document.getElementById('composer'));
  const input = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
  const sendBtn = /** @type {HTMLButtonElement} */ (document.getElementById('send'));

  /** @type {HTMLElement | null} */
  let currentReply = null;
  let streaming = false;

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

  /** @param {boolean} value */
  function setStreaming(value) {
    streaming = value;
    streamingEl.hidden = !value;
    sendBtn.disabled = value;
    if (!value) {
      if (currentReply && !currentReply.textContent) {
        currentReply.remove();
      }
      currentReply = null;
      input.focus();
    }
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

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
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

  input.focus();
})();
