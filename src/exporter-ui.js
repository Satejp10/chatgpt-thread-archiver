(() => {
  const CONTROL_ID = 'chatgpt-chats-exporter-control';
  const PANEL_ID = 'chatgpt-chats-exporter-panel';
  const OPTIONS_ID = 'chatgpt-chats-exporter-options';
  const STYLE_ID = 'chatgpt-chats-exporter-style';
  const PREF_KEY = 'chatgpt-thread-archiver-prefs';
  const LEGACY_PREF_KEY = 'chatgpt-chats-exporter-prefs';

  function addStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${CONTROL_ID} { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647; border: 0; border-radius: 999px; padding: 10px 15px; background: #111827; color: white; box-shadow: 0 6px 22px rgb(0 0 0 / .2); font: 600 13px/1.2 system-ui, sans-serif; cursor: pointer; }
      #${CONTROL_ID}:hover { background: #1f2937; }
      #${CONTROL_ID}[data-state="busy"] { opacity: .7; cursor: wait; }
      #${PANEL_ID} { position: fixed; right: 18px; bottom: 64px; z-index: 2147483647; max-width: min(420px, calc(100vw - 36px)); border: 1px solid rgb(156 163 175 / .45); border-radius: 12px; padding: 12px 14px; background: Canvas; color: CanvasText; box-shadow: 0 8px 30px rgb(0 0 0 / .2); font: 13px/1.45 system-ui, sans-serif; white-space: normal; }
      #${PANEL_ID}[hidden] { display: none; }
      #${PANEL_ID} strong { display: block; margin-bottom: 3px; }
      #${PANEL_ID} code { font: 12px ui-monospace, monospace; overflow-wrap: anywhere; }
      #${OPTIONS_ID} { position: fixed; inset: 0; z-index: 2147483646; display: grid; place-items: center; padding: 18px; background: rgb(0 0 0 / .45); font: 14px/1.45 system-ui, sans-serif; }
      #${OPTIONS_ID}[hidden] { display: none; }
      #${OPTIONS_ID} .cge-card { width: min(430px, 100%); padding: 22px; border: 1px solid rgb(156 163 175 / .45); border-radius: 14px; background: Canvas; color: CanvasText; box-shadow: 0 12px 42px rgb(0 0 0 / .25); }
      #${OPTIONS_ID} h2 { margin: 0 0 8px; font-size: 18px; }
      #${OPTIONS_ID} p { margin: 0 0 16px; color: GrayText; }
      #${OPTIONS_ID} label { display: flex; gap: 9px; align-items: flex-start; margin: 10px 0; cursor: pointer; }
      #${OPTIONS_ID} input { margin-top: 3px; }
      #${OPTIONS_ID} .cge-actions { display: flex; gap: 9px; justify-content: flex-end; margin-top: 20px; }
      #${OPTIONS_ID} button { border: 0; border-radius: 8px; padding: 9px 13px; cursor: pointer; font: inherit; }
      #${OPTIONS_ID} .cge-primary { background: #111827; color: white; }
      #${OPTIONS_ID} .cge-secondary { background: rgb(127 127 127 / .16); color: CanvasText; }
    `;
    document.head.appendChild(style);
  }

  function showStatus(title, detail = '', isError = false) {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      document.body.appendChild(panel);
    }
    panel.hidden = false;
    panel.setAttribute('role', isError ? 'alert' : 'status');
    panel.replaceChildren();
    const heading = document.createElement('strong');
    heading.textContent = title;
    panel.appendChild(heading);
    if (detail) {
      const detailNode = document.createElement('span');
      const lines = String(detail).split('\n');
      lines.forEach((line, index) => {
        if (index > 0) detailNode.appendChild(document.createElement('br'));
        detailNode.appendChild(document.createTextNode(line));
      });
      panel.appendChild(detailNode);
    }
    if (!isError) window.setTimeout(() => { if (panel) panel.hidden = true; }, 6000);
  }

  function downloadHtml(html, fileName) {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${fileName}.html`;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function defaultPrefs() {
    return { url: true, title: true, conversationId: false };
  }

  function parsePrefs(raw) {
    if (!raw) return null;
    try {
      const value = JSON.parse(raw);
      const keys = ['url', 'title', 'conversationId'];
      if (!value || typeof value !== 'object' || keys.some((key) => typeof value[key] !== 'boolean')) return null;
      return { url: value.url, title: value.title, conversationId: value.conversationId };
    } catch {
      return null;
    }
  }

  function migratePrefsOnce() {
    try {
      if (localStorage.getItem(PREF_KEY) !== null) return;
      const legacyRaw = localStorage.getItem(LEGACY_PREF_KEY);
      const legacyPrefs = parsePrefs(legacyRaw);
      if (!legacyPrefs) return;
      const serialized = JSON.stringify(legacyPrefs);
      localStorage.setItem(PREF_KEY, serialized);
      if (localStorage.getItem(PREF_KEY) !== serialized) throw new Error('new preference key verification failed');
      localStorage.removeItem(LEGACY_PREF_KEY);
      if (localStorage.getItem(LEGACY_PREF_KEY) !== null) throw new Error('legacy preference key removal failed');
    } catch {
      try { localStorage.removeItem(PREF_KEY); } catch {
        // Keep the legacy key untouched when rollback is unavailable.
      }
    }
  }

  function loadPrefs() {
    const prefs = defaultPrefs();
    migratePrefsOnce();
    try {
      const stored = parsePrefs(localStorage.getItem(PREF_KEY)) ?? parsePrefs(localStorage.getItem(LEGACY_PREF_KEY));
      if (stored) Object.assign(prefs, stored);
    } catch {
      // Defaults remain active when storage is unavailable or malformed.
    }
    return prefs;
  }

  function savePrefs(prefs) {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({
        url: Boolean(prefs.url),
        title: Boolean(prefs.title),
        conversationId: Boolean(prefs.conversationId),
      }));
    } catch {
      // Preference persistence is optional and must never block an export.
    }
  }

  function checkbox(id, label, checked) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.checked = checked;
    const text = document.createElement('span');
    text.textContent = label;
    const wrapper = document.createElement('label');
    wrapper.htmlFor = id;
    wrapper.append(input, text);
    return { input, wrapper };
  }

  function showExportOptions(button) {
    if (document.getElementById(OPTIONS_ID)) return;
    const prefs = loadPrefs();
    const overlay = document.createElement('div');
    overlay.id = OPTIONS_ID;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    const card = document.createElement('div');
    card.className = 'cge-card';
    const heading = document.createElement('h2');
    heading.textContent = 'Export ChatGPT conversation';
    const intro = document.createElement('p');
    intro.textContent = 'Choose which identifying fields should be included in the offline HTML file.';
    const url = checkbox('cge-pref-url', 'Include the conversation URL', prefs.url);
    const title = checkbox('cge-pref-title', 'Include the conversation title and use it in the filename', prefs.title);
    const conversationId = checkbox('cge-pref-conversation-id', 'Include the conversation ID in the HTML metadata', prefs.conversationId);
    const actions = document.createElement('div');
    actions.className = 'cge-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'cge-secondary';
    cancel.textContent = 'Cancel';
    const exportButton = document.createElement('button');
    exportButton.type = 'button';
    exportButton.className = 'cge-primary';
    exportButton.textContent = 'Export HTML';
    actions.append(cancel, exportButton);
    card.append(heading, intro, url.wrapper, title.wrapper, conversationId.wrapper, actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    cancel.addEventListener('click', close);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
    exportButton.addEventListener('click', () => {
      const chosen = { url: url.input.checked, title: title.input.checked, conversationId: conversationId.input.checked };
      savePrefs(chosen);
      close();
      exportCurrentConversation(button, chosen);
    });
    exportButton.focus();
  }

  function filenameFor(conversation, prefs, exportedAt) {
    if (prefs.title) return sanitizeFilename(conversation.title);
    const stamp = exportedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    return sanitizeFilename(`chatgpt-export-${stamp}`);
  }

  async function exportCurrentConversation(button, prefs = loadPrefs()) {
    if (button?.dataset.state === 'busy') return;
    if (button) {
      button.dataset.state = 'busy';
      button.textContent = 'Exporting…';
    }

    try {
      const conversationId = getConversationIdFromUrl();
      if (!conversationId) throw new ChatGPTClientError('missing-id', 'Open a ChatGPT conversation before exporting.');
      showStatus('Loading conversation…', `Conversation ID: ${redactId(conversationId)}`);
      const raw = await fetchConversation(conversationId);
      showStatus('Formatting messages…');
      const normalized = normalizeConversation(raw);
      const conversation = await resolveConversationImages(normalized, {
        conversationId,
        onProgress: (completed, total) => showStatus('Resolving images…', `${completed}/${total} image asset(s)`),
      });
      const exportedAt = new Date().toISOString();
      const html = renderConversationHtml(conversation, {
        exportedAt,
        sourceUrl: prefs.url ? globalThis.location?.href : null,
        includeConversationId: prefs.conversationId,
        includeTitle: prefs.title,
      });
      downloadHtml(html, filenameFor(conversation, prefs, exportedAt));
      const imageSummary = Number.isFinite(conversation.stats.imageCount) && conversation.stats.imageCount > 0
        ? ` ${conversation.stats.imageEmbeddedCount} image(s) embedded; ${conversation.stats.imageUnavailableCount} unavailable.`
        : '';
      showStatus('Download ready', `${conversation.stats.messageCount} message(s) exported; ${conversation.stats.omittedBlockCount} non-text block(s) omitted.${imageSummary}`);
    } catch (error) {
      showStatus('Export failed', describeClientError(error), true);
      console.error('[ChatGPT Thread Archiver]', error?.code ?? 'unknown', describeClientError(error));
    } finally {
      if (button) {
        button.dataset.state = 'idle';
        button.textContent = 'Export HTML';
      }
    }
  }

  function install() {
    if (!isChatGPTHost()) return;
    if (!document.body || document.getElementById(CONTROL_ID)) return;
    installAuthCacheInvalidation();
    addStyles();
    const button = document.createElement('button');
    button.id = CONTROL_ID;
    button.type = 'button';
    button.textContent = 'Export HTML';
    button.title = 'Export the currently open ChatGPT conversation as HTML';
    button.addEventListener('click', () => showExportOptions(button));
    document.body.appendChild(button);
  }

  function boot() {
    if (!document.body) return window.setTimeout(boot, 50);
    install();
  }

  boot();
})();
