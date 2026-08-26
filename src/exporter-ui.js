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
      @media (max-width: 700px) {
        #${CONTROL_ID} { right: 12px; bottom: calc(84px + env(safe-area-inset-bottom, 0px)); }
        #${PANEL_ID} { right: 12px; bottom: calc(138px + env(safe-area-inset-bottom, 0px)); max-width: calc(100vw - 24px); }
      }
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
      #${OPTIONS_ID} fieldset { max-height: min(60vh, 520px); overflow: auto; margin: 16px 0 0; padding: 8px 12px; border: 1px solid rgb(156 163 175 / .45); border-radius: 9px; }
      #${OPTIONS_ID} legend { padding: 0 5px; font-weight: 700; }
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
    return { url: true, title: true, conversationId: false, imageMode: 'all', messageModels: true, branchMode: 'active' };
  }

  function parsePrefs(raw) {
    if (!raw) return null;
    try {
      const value = JSON.parse(raw);
      const keys = ['url', 'title', 'conversationId'];
      if (!value || typeof value !== 'object' || keys.some((key) => typeof value[key] !== 'boolean')) return null;
      const imageMode = ['all', 'none', 'choose'].includes(value.imageMode) ? value.imageMode : 'all';
      const messageModels = typeof value.messageModels === 'boolean' ? value.messageModels : true;
      const branchMode = ['active', 'all'].includes(value.branchMode) ? value.branchMode : 'active';
      return { url: value.url, title: value.title, conversationId: value.conversationId, imageMode, messageModels, branchMode };
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
        imageMode: ['all', 'none', 'choose'].includes(prefs.imageMode) ? prefs.imageMode : 'all',
        messageModels: prefs.messageModels !== false,
        branchMode: ['active', 'all'].includes(prefs.branchMode) ? prefs.branchMode : 'active',
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

  function radio(name, id, label, value, checked) {
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.id = id;
    input.value = value;
    input.checked = checked;
    const text = document.createElement('span');
    text.textContent = label;
    const wrapper = document.createElement('label');
    wrapper.htmlFor = id;
    wrapper.append(input, text);
    return { input, wrapper };
  }

  function providerForLocation() {
    if (isChatGPTHost() && isExporterRoute()) return 'ChatGPT';
    if (isClaudeHost() && isClaudeExporterRoute()) return 'Claude';
    return null;
  }

  function imageEntries(conversation) {
    const branchRecords = Array.isArray(conversation?.branches) && conversation.branches.length > 1
      ? conversation.branches
      : [{ index: 0, messages: conversation?.messages ?? [] }];
    let index = 0;
    const entries = [];
    for (const branch of branchRecords) {
      let turnIndex = 0;
      for (const message of branch.messages ?? []) {
        if (message.role !== 'unknown') turnIndex += 1;
        for (const block of message.textBlocks ?? []) {
          if (block.type !== 'image') continue;
          entries.push({
            index: index++,
            branchIndex: branch.index ?? 0,
            messageIndex: turnIndex,
            speaker: message.authorLabel ?? (message.role === 'user' ? 'You' : 'ChatGPT'),
            generated: Boolean(block.asset?.generated),
            sizeBytes: Number.isFinite(block.asset?.sizeBytes) ? block.asset.sizeBytes : null,
          });
        }
      }
    }
    return entries;
  }

  function formatImageSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return 'size unknown';
    if (bytes < 1024) return `${bytes} B`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function showImageSelection(conversation) {
    const entries = imageEntries(conversation);
    if (entries.length === 0) return Promise.resolve(new Set());
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.id = OPTIONS_ID;
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      const card = document.createElement('div');
      card.className = 'cge-card';
      const heading = document.createElement('h2');
      heading.textContent = 'Choose images to include';
      const intro = document.createElement('p');
      intro.textContent = 'Images are selected by default. Unselected images will not be downloaded and will be marked as excluded in the HTML.';
      const fieldset = document.createElement('fieldset');
      const legend = document.createElement('legend');
      legend.textContent = `${entries.length} image${entries.length === 1 ? '' : 's'} found`;
      fieldset.appendChild(legend);
      const inputs = [];
      for (const entry of entries) {
        const branchLabel = entries.some((candidate) => candidate.branchIndex !== entry.branchIndex) ? ` · branch ${entry.branchIndex + 1}` : '';
        const image = checkbox(`cge-image-${entry.index}`, `Image ${entry.index + 1}${branchLabel} · message ${entry.messageIndex} · ${entry.speaker} · ${entry.generated ? 'generated' : 'uploaded/reference'} · ${formatImageSize(entry.sizeBytes)}`, true);
        image.input.dataset.imageIndex = String(entry.index);
        inputs.push(image.input);
        fieldset.appendChild(image.wrapper);
      }
      const actions = document.createElement('div');
      actions.className = 'cge-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'cge-secondary';
      cancel.textContent = 'Cancel';
      const continueButton = document.createElement('button');
      continueButton.type = 'button';
      continueButton.className = 'cge-primary';
      continueButton.textContent = 'Export selected';
      actions.append(cancel, continueButton);
      card.append(heading, intro, fieldset, actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      const close = (selection) => { overlay.remove(); resolve(selection); };
      cancel.addEventListener('click', () => close(null));
      overlay.addEventListener('click', (event) => { if (event.target === overlay) close(null); });
      continueButton.addEventListener('click', () => close(new Set(inputs.filter((input) => input.checked).map((input) => Number(input.dataset.imageIndex)))));
      continueButton.focus();
    });
  }

  function showExportOptions(button, provider) {
    if (document.getElementById(OPTIONS_ID)) return;
    const prefs = loadPrefs();
    const overlay = document.createElement('div');
    overlay.id = OPTIONS_ID;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    const card = document.createElement('div');
    card.className = 'cge-card';
    const heading = document.createElement('h2');
    heading.textContent = `Export ${provider} conversation`;
    const intro = document.createElement('p');
    intro.textContent = 'Choose which identifying fields and images should be included in the offline HTML file.';
    const url = checkbox('cge-pref-url', 'Include the conversation URL', prefs.url);
    const title = checkbox('cge-pref-title', 'Include the conversation title and use it in the filename', prefs.title);
    const conversationId = checkbox('cge-pref-conversation-id', 'Include the conversation ID in the HTML metadata', prefs.conversationId);
    const messageModels = checkbox('cge-pref-message-models', 'Show a model label on each assistant message', prefs.messageModels);
    const imageChoices = [];
    let imageFieldset = null;
    const branchChoices = [];
    const branchFieldset = document.createElement('fieldset');
    const branchLegend = document.createElement('legend');
    branchLegend.textContent = 'Conversation branches';
    branchFieldset.appendChild(branchLegend);
    for (const choice of [['active', 'Export current branch only'], ['all', 'Include edited and regenerated branches']]) {
      const branchRadio = radio('cge-branch-mode', `cge-branch-mode-${choice[0]}`, choice[1], choice[0], prefs.branchMode === choice[0]);
      branchChoices.push(branchRadio.input);
      branchFieldset.appendChild(branchRadio.wrapper);
    }
    if (provider === 'ChatGPT') {
      imageFieldset = document.createElement('fieldset');
      const imageLegend = document.createElement('legend');
      imageLegend.textContent = 'Images';
      imageFieldset.appendChild(imageLegend);
      for (const choice of [['all', 'Include all images'], ['none', 'Exclude all images'], ['choose', 'Choose images after loading the conversation']]) {
        const imageRadio = radio('cge-image-mode', `cge-image-mode-${choice[0]}`, choice[1], choice[0], prefs.imageMode === choice[0]);
        imageChoices.push(imageRadio.input);
        imageFieldset.appendChild(imageRadio.wrapper);
      }
    }
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
    card.append(heading, intro, url.wrapper, title.wrapper, conversationId.wrapper, messageModels.wrapper, branchFieldset);
    if (imageFieldset) card.appendChild(imageFieldset);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    cancel.addEventListener('click', close);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
    exportButton.addEventListener('click', () => {
      const chosen = {
        url: url.input.checked,
        title: title.input.checked,
        conversationId: conversationId.input.checked,
        messageModels: messageModels.input.checked,
        imageMode: provider === 'ChatGPT' ? (imageChoices.find((input) => input.checked)?.value ?? prefs.imageMode) : prefs.imageMode,
        branchMode: branchChoices.find((input) => input.checked)?.value ?? prefs.branchMode,
      };
      savePrefs(chosen);
      close();
      exportCurrentConversation(button, chosen, provider);
    });
    exportButton.focus();
  }

  function filenameFor(conversation, prefs, exportedAt) {
    if (prefs.title) return sanitizeFilename(conversation.title);
    const stamp = exportedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    return sanitizeFilename(`chatgpt-export-${stamp}`);
  }

  function aggregateBranchStats(conversation) {
    const branches = Array.isArray(conversation?.branches) ? conversation.branches : [];
    if (branches.length <= 1) return conversation?.stats ?? {};
    const sumKeys = ['omittedBlockCount', 'sourceNodeCount', 'droppedNodeCount', 'duplicateMessageCount', 'hiddenMessageCount'];
    return {
      ...(conversation.stats ?? {}),
      ...Object.fromEntries(sumKeys.map((key) => [key, branches.reduce((sum, branch) => sum + Number(branch.stats?.[key] ?? 0), 0)])),
      branchCount: branches.length,
    };
  }

  async function resolveAllConversationBranches(conversation, options = {}) {
    const branches = Array.isArray(conversation?.branches) && conversation.branches.length > 1 ? conversation.branches : [];
    if (branches.length === 0) return resolveConversationImages(conversation, options);
    const totalImages = imageEntries(conversation).length;
    let imageOffset = 0;
    let completed = 0;
    const resolvedBranches = [];
    for (const branch of branches) {
      const branchConversation = { ...conversation, messages: branch.messages, branches: [], stats: branch.stats };
      const branchImageCount = imageEntries(branchConversation).length;
      const resolved = await resolveConversationImages(branchConversation, {
        ...options,
        imageIndexOffset: imageOffset,
        onProgress: () => options.onProgress?.(++completed, totalImages),
      });
      resolvedBranches.push({ ...branch, messages: resolved.messages, stats: resolved.stats });
      imageOffset += branchImageCount;
    }
    const allMessages = resolvedBranches.flatMap((branch) => branch.messages);
    const imageStats = ['imageCount', 'imageEmbeddedCount', 'imageExcludedCount', 'imageUnavailableCount', 'imageBytes', 'imageBudgetLimitedCount']
      .reduce((summary, key) => ({ ...summary, [key]: resolvedBranches.reduce((sum, branch) => sum + Number(branch.stats?.[key] ?? 0), 0) }), {});
    const branchTree = branchTreeFromBranches(resolvedBranches);
    const displayedMessages = branchTree.length > 0 ? messagesFromBranchTree(branchTree) : (resolvedBranches[0]?.messages ?? conversation.messages);
    return {
      ...conversation,
      messages: resolvedBranches[0]?.messages ?? conversation.messages,
      branches: resolvedBranches,
      branchTree,
      stats: { ...conversation.stats, ...imageStats, messageCount: displayedMessages.length },
    };
  }

  async function exportCurrentConversation(button, prefs = loadPrefs(), provider = providerForLocation()) {
    if (button?.dataset.state === 'busy') return;
    if (!provider) {
      showStatus('Export unavailable', 'Open a supported ChatGPT or Claude conversation first.', true);
      return;
    }
    if (button) {
      button.dataset.state = 'busy';
      button.textContent = 'Exporting…';
    }

    try {
      const conversationId = provider === 'Claude' ? getClaudeConversationIdFromUrl() : getConversationIdFromUrl();
      if (!conversationId) throw new Error(`Open a ${provider} conversation before exporting.`);
      showStatus('Loading conversation…', `${provider} conversation ID: ${provider === 'Claude' ? redactClaudeId(conversationId) : redactId(conversationId)}`);
      const raw = provider === 'Claude' ? await fetchClaudeConversation(conversationId) : await fetchConversation(conversationId);
      showStatus('Formatting messages…');
      const normalized = provider === 'Claude' ? normalizeClaudeConversation(raw, conversationId) : normalizeConversation(raw);
      const includeAllBranches = prefs.branchMode === 'all' && Array.isArray(normalized.branches) && normalized.branches.length > 1;
      let selectedImageIndices = null;
      let includeImages = true;
      if (provider === 'ChatGPT') {
        includeImages = prefs.imageMode !== 'none';
        if (prefs.imageMode === 'choose') {
          showStatus('Choose images…', 'Review the available images before any image downloads begin.');
          selectedImageIndices = await showImageSelection(normalized);
          if (selectedImageIndices === null) {
            showStatus('Export cancelled');
            return;
          }
        }
      }
      const conversation = provider === 'Claude'
        ? normalized
        : includeAllBranches
          ? await resolveAllConversationBranches(normalized, {
            conversationId,
            includeImages,
            selectedImageIndices,
            onProgress: (completed, total) => showStatus('Processing image choices…', `${completed}/${total} image(s) processed`),
          })
          : await resolveConversationImages(normalized, {
            conversationId,
            includeImages,
            selectedImageIndices,
            onProgress: (completed, total) => showStatus('Processing image choices…', `${completed}/${total} image(s) processed`),
          });
      const statsMessages = includeAllBranches
        ? (conversation.branchTree?.length ? messagesFromBranchTree(conversation.branchTree) : conversation.branches.flatMap((branch) => branch.messages))
        : conversation.messages;
      const statsBase = conversation.stats;
      const exportStats = deriveExportStats(statsMessages, statsBase, { model: conversation.model });
      const exportableConversation = { ...conversation, stats: exportStats };
      const exportedAt = new Date().toISOString();
      const html = renderConversationHtml(exportableConversation, {
        exportedAt,
        sourceUrl: prefs.url ? globalThis.location?.href : null,
        includeConversationId: prefs.conversationId,
        includeTitle: prefs.title,
        includeMessageModels: prefs.messageModels !== false,
        includeAllBranches,
      });
      downloadHtml(html, filenameFor(exportableConversation, prefs, exportedAt));
      const imageSummary = Number.isFinite(exportStats.imageCount) && exportStats.imageCount > 0
        ? ` ${exportStats.imageEmbeddedCount} image(s) embedded; ${exportStats.imageUnavailableCount} unavailable${exportStats.imageBudgetLimitedCount ? `; ${exportStats.imageBudgetLimitedCount} limited by export budget` : ''}.`
        : '';
      const localStats = `${exportStats.wordCount.toLocaleString('en-US')} words and ${exportStats.characterCount.toLocaleString('en-US')} characters counted locally.`;
      showStatus('Download ready', `${exportStats.messageCount} ${provider} message(s) exported; ${exportStats.omittedBlockCount} unsupported block(s) marked.${imageSummary} ${localStats}`);
    } catch (error) {
      const description = provider === 'Claude' ? describeClaudeError(error) : describeClientError(error);
      showStatus('Export failed', description, true);
      console.error('[ChatGPT Thread Archiver]', error?.code ?? 'unknown', description);
    } finally {
      if (button) {
        button.dataset.state = 'idle';
        button.textContent = 'Export HTML';
      }
    }
  }

  function install() {
    const provider = providerForLocation();
    const existing = document.getElementById(CONTROL_ID);
    if (!provider) {
      existing?.remove();
      return;
    }
    if (!document.body) return;
    if (existing?.dataset.provider === provider) return;
    existing?.remove();
    if (provider === 'ChatGPT') installAuthCacheInvalidation();
    addStyles();
    const button = document.createElement('button');
    button.id = CONTROL_ID;
    button.dataset.provider = provider;
    button.type = 'button';
    button.textContent = 'Export HTML';
    button.title = `Export the currently open ${provider} conversation as HTML`;
    button.addEventListener('click', () => showExportOptions(button, provider));
    document.body.appendChild(button);
  }

  function boot() {
    if (!document.body) return window.setTimeout(boot, 50);
    install();
    if (window.MutationObserver && document.documentElement) {
      const observer = new MutationObserver(() => install());
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  boot();
})();
