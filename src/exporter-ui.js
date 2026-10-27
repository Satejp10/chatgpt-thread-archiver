(() => {
  const CONTROL_ID = 'chatgpt-chats-exporter-control';
  const PANEL_ID = 'chatgpt-chats-exporter-panel';
  const OPTIONS_ID = 'chatgpt-chats-exporter-options';
  const HOST_ID = 'chatgpt-thread-archiver-ui';
  const PREF_KEY = 'chatgpt-thread-archiver-prefs';
  const LEGACY_PREF_KEY = 'chatgpt-chats-exporter-prefs';
  const PREFS_VERSION = 1;

  const STYLES = `
    #${CONTROL_ID} { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647; border: 0; border-radius: 999px; padding: 10px 15px; background: #111827; color: white; box-shadow: 0 6px 22px rgb(0 0 0 / .2); font: 600 13px/1.2 system-ui, sans-serif; cursor: pointer; }
    #${CONTROL_ID}:hover { background: #1f2937; }
    @media (max-width: 700px) {
      #${CONTROL_ID} { right: 12px; bottom: calc(84px + env(safe-area-inset-bottom, 0px)); }
      #${PANEL_ID} { right: 12px; bottom: calc(138px + env(safe-area-inset-bottom, 0px)); max-width: calc(100vw - 24px); }
    }
    #${CONTROL_ID}[data-state="busy"] { opacity: .7; cursor: wait; }
    #${PANEL_ID} { position: fixed; right: 18px; bottom: 64px; z-index: 2147483647; max-width: min(420px, calc(100vw - 36px)); max-height: 60vh; overflow: auto; border: 1px solid rgb(156 163 175 / .45); border-radius: 12px; padding: 12px 14px; background: Canvas; color: CanvasText; box-shadow: 0 8px 30px rgb(0 0 0 / .2); font: 13px/1.45 system-ui, sans-serif; white-space: normal; overflow-wrap: anywhere; }
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
    #${OPTIONS_ID} .cge-selection-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-top: 16px; }
    #${OPTIONS_ID} .cge-select-all { font-weight: 600; }
    #${OPTIONS_ID} .cge-selection-summary { margin: 0; font-size: 12px; opacity: .75; }
    #${OPTIONS_ID} .cge-selection-toolbar + fieldset { margin-top: 8px; }
    #${OPTIONS_ID} button { border: 0; border-radius: 8px; padding: 9px 13px; cursor: pointer; font: inherit; }
    #${OPTIONS_ID} .cge-primary { background: #111827; color: white; }
    #${OPTIONS_ID} .cge-secondary { background: rgb(127 127 127 / .16); color: CanvasText; }
  `;

  // The button, status panel and dialogs live in a shadow root, out of reach of the host
  // page's stylesheet. ChatGPT's CSS made every checkbox and radio button in the export
  // dialog invisible, though they still worked. The host's own inline style resets
  // anything the page could pass down, except the colour scheme, so the dialog still
  // follows the site's light or dark theme.
  function uiRoot() {
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('chatgpt-thread-archiver');
      host.id = HOST_ID;
      host.style.cssText = 'all: initial !important; color-scheme: inherit !important;';
      document.body.appendChild(host);
    }
    if (!host.shadowRoot) {
      const style = document.createElement('style');
      style.textContent = STYLES;
      host.attachShadow({ mode: 'open' }).appendChild(style);
    }
    return host.shadowRoot;
  }

  function uiElement(id) {
    return document.getElementById(HOST_ID)?.shadowRoot?.getElementById(id) ?? null;
  }

  // One timer for the panel: a status that hides itself must not, seconds later, hide an
  // error shown after it.
  let statusTimer = null;

  function showStatus(title, detail = '', isError = false) {
    let panel = uiElement(PANEL_ID);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      uiRoot().appendChild(panel);
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
    window.clearTimeout(statusTimer);
    statusTimer = isError ? null : window.setTimeout(() => { panel.hidden = true; }, 6000);
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
    return { url: true, title: true, conversationId: false, imageMode: 'all', messageModels: true, branchMode: 'all', thinking: false, prefsVersion: PREFS_VERSION };
  }

  function parsePrefs(raw) {
    if (!raw) return null;
    try {
      const value = JSON.parse(raw);
      const keys = ['url', 'title', 'conversationId'];
      if (!value || typeof value !== 'object' || keys.some((key) => typeof value[key] !== 'boolean')) return null;
      const imageMode = ['all', 'none', 'choose'].includes(value.imageMode) ? value.imageMode : 'all';
      const messageModels = typeof value.messageModels === 'boolean' ? value.messageModels : true;
      // Reasoning and tool detail stays out unless the person asks for it: an export gets
      // shared, and a stored preference that predates this option must not opt them in.
      const thinking = value.thinking === true;
      const branchMode = ['active', 'all'].includes(value.branchMode) ? value.branchMode : 'active';
      const prefsVersion = Number.isInteger(value.prefsVersion) ? value.prefsVersion : 0;
      return { url: value.url, title: value.title, conversationId: value.conversationId, imageMode, messageModels, branchMode, thinking, prefsVersion };
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
      // Installs saved before v0.13.0 kept the old current-branch-only default, which
      // silently dropped edited and regenerated versions. Move them to the new default
      // once; a choice saved after the upgrade carries PREFS_VERSION and is left alone.
      if (prefs.prefsVersion < PREFS_VERSION) {
        prefs.branchMode = 'all';
        prefs.prefsVersion = PREFS_VERSION;
        savePrefs(prefs);
      }
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
        thinking: prefs.thinking === true,
        prefsVersion: PREFS_VERSION,
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

  // One entry per image occurrence, counted branch by branch exactly as the resolver counts
  // them, so `index` lines up with `imageIndexOffset`. A message shared by several branches
  // carries its images into each of them; `key` ties those occurrences together.
  function imageEntries(conversation, { allBranches = true } = {}) {
    const branchRecords = allBranches && Array.isArray(conversation?.branches) && conversation.branches.length > 1
      ? conversation.branches
      : [{ index: 0, messages: conversation?.messages ?? [] }];
    let index = 0;
    const entries = [];
    for (const branch of branchRecords) {
      let turnIndex = 0;
      for (const message of branch.messages ?? []) {
        if (message.role !== 'unknown') turnIndex += 1;
        for (const [blockIndex, block] of (message.textBlocks ?? []).entries()) {
          if (block.type !== 'image') continue;
          entries.push({
            index: index++,
            key: `${message.id}\u0000${blockIndex}\u0000${block.asset?.pointer ?? ''}`,
            branchIndex: branch.index ?? 0,
            messageIndex: turnIndex,
            speaker: message.authorLabel ?? (message.role === 'user' ? 'You' : 'ChatGPT'),
            generated: Boolean(block.asset?.generated),
            imageModel: block.asset?.imageModel || 'unknown / not found',
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
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function showImageSelection(conversation, allBranches) {
    const occurrences = imageEntries(conversation, { allBranches });
    if (occurrences.length === 0) return Promise.resolve(new Set());
    const branchTotal = allBranches && Array.isArray(conversation?.branches) && conversation.branches.length > 1 ? conversation.branches.length : 1;
    const branchesByKey = new Map();
    for (const entry of occurrences) branchesByKey.set(entry.key, [...(branchesByKey.get(entry.key) ?? []), entry.branchIndex]);
    // An image in a message that several branches share is listed once; choosing it
    // includes or excludes it everywhere it occurs.
    const listed = new Set();
    const entries = occurrences.filter((entry) => !listed.has(entry.key) && listed.add(entry.key));
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
      const toolbar = document.createElement('div');
      toolbar.className = 'cge-selection-toolbar';
      const selectAll = checkbox('cge-image-select-all', 'Select all', true);
      selectAll.wrapper.className = 'cge-select-all';
      const summary = document.createElement('p');
      summary.className = 'cge-selection-summary';
      summary.setAttribute('aria-live', 'polite');
      toolbar.append(selectAll.wrapper, summary);

      const fieldset = document.createElement('fieldset');
      const legend = document.createElement('legend');
      legend.textContent = `${entries.length} image${entries.length === 1 ? '' : 's'} found`;
      fieldset.appendChild(legend);
      const inputs = [];
      for (const [position, entry] of entries.entries()) {
        const inBranches = [...new Set(branchesByKey.get(entry.key))].sort((left, right) => left - right);
        const branchLabel = branchTotal > 1 && inBranches.length < branchTotal ? ` · branch ${inBranches.map((branch) => branch + 1).join(', ')}` : '';
        const modelLabel = entry.generated ? ` · ${entry.imageModel}` : '';
        const image = checkbox(`cge-image-${position}`, `Image ${position + 1}${branchLabel} · message ${entry.messageIndex} · ${entry.speaker} · ${entry.generated ? 'generated' : 'uploaded/reference'}${modelLabel} · ${formatImageSize(entry.sizeBytes)}`, true);
        image.input.dataset.imageKey = entry.key;
        image.input.dataset.sizeBytes = Number.isFinite(entry.sizeBytes) ? String(entry.sizeBytes) : '';
        inputs.push(image.input);
        fieldset.appendChild(image.wrapper);
      }

      // The export no longer caps embedded images, so the running total is the
      // only signal that a selection will produce an unwieldy file.
      const refreshSummary = () => {
        const checked = inputs.filter((input) => input.checked);
        const known = checked.filter((input) => input.dataset.sizeBytes !== '');
        const bytes = known.reduce((total, input) => total + Number(input.dataset.sizeBytes), 0);
        const approximate = known.length < checked.length ? ' at least ' : ' ';
        summary.textContent = checked.length === 0
          ? `No images selected · the export will contain none.`
          : `${checked.length} of ${inputs.length} selected ·${approximate}${formatImageSize(bytes)} to embed`;
        selectAll.input.checked = checked.length === inputs.length;
        selectAll.input.indeterminate = checked.length > 0 && checked.length < inputs.length;
      };
      selectAll.input.addEventListener('change', () => {
        const next = selectAll.input.checked;
        for (const input of inputs) input.checked = next;
        refreshSummary();
      });
      for (const input of inputs) input.addEventListener('change', refreshSummary);
      refreshSummary();

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
      card.append(heading, intro, toolbar, fieldset, actions);
      overlay.appendChild(card);
      uiRoot().appendChild(overlay);
      const close = (selection) => { overlay.remove(); resolve(selection); };
      cancel.addEventListener('click', () => close(null));
      overlay.addEventListener('click', (event) => { if (event.target === overlay) close(null); });
      continueButton.addEventListener('click', () => {
        const chosen = new Set(inputs.filter((input) => input.checked).map((input) => input.dataset.imageKey));
        close(new Set(occurrences.filter((entry) => chosen.has(entry.key)).map((entry) => entry.index)));
      });
      continueButton.focus();
    });
  }

  function showExportOptions(button, provider) {
    if (uiElement(OPTIONS_ID)) return;
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
    const thinking = checkbox('cge-pref-thinking', 'Include Claude thinking and tool calls (collapsed in the file)', prefs.thinking === true);
    const imageChoices = [];
    const branchChoices = [];
    const branchFieldset = document.createElement('fieldset');
    const branchLegend = document.createElement('legend');
    branchLegend.textContent = 'Conversation branches';
    branchFieldset.appendChild(branchLegend);
    for (const choice of [['all', 'Include edited and regenerated branches'], ['active', 'Export current branch only']]) {
      const branchRadio = radio('cge-branch-mode', `cge-branch-mode-${choice[0]}`, choice[1], choice[0], prefs.branchMode === choice[0]);
      branchChoices.push(branchRadio.input);
      branchFieldset.appendChild(branchRadio.wrapper);
    }
    const imageFieldset = document.createElement('fieldset');
    const imageLegend = document.createElement('legend');
    imageLegend.textContent = 'Images';
    imageFieldset.appendChild(imageLegend);
    for (const choice of [['all', 'Include all images'], ['none', 'Exclude all images'], ['choose', 'Choose images after loading the conversation']]) {
      const imageRadio = radio('cge-image-mode', `cge-image-mode-${choice[0]}`, choice[1], choice[0], prefs.imageMode === choice[0]);
      imageChoices.push(imageRadio.input);
      imageFieldset.appendChild(imageRadio.wrapper);
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
    card.append(heading, intro, url.wrapper, title.wrapper, conversationId.wrapper, messageModels.wrapper, thinking.wrapper, branchFieldset, imageFieldset, actions);
    overlay.appendChild(card);
    uiRoot().appendChild(overlay);

    const close = () => overlay.remove();
    cancel.addEventListener('click', close);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
    exportButton.addEventListener('click', () => {
      const chosen = {
        url: url.input.checked,
        title: title.input.checked,
        conversationId: conversationId.input.checked,
        messageModels: messageModels.input.checked,
        thinking: thinking.input.checked,
        imageMode: imageChoices.find((input) => input.checked)?.value ?? prefs.imageMode,
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

  async function resolveAllConversationBranches(conversation, options = {}, resolve = resolveConversationImages) {
    const branches = Array.isArray(conversation?.branches) && conversation.branches.length > 1 ? conversation.branches : [];
    if (branches.length === 0) return resolve(conversation, options);
    const totalImages = imageEntries(conversation).length;
    // Branches share their common messages, so one cache fetches each image once rather
    // than once per branch.
    const imageCache = new Map();
    let imageOffset = 0;
    let completed = 0;
    const resolvedBranches = [];
    for (const branch of branches) {
      const branchConversation = { ...conversation, messages: branch.messages, branches: [], stats: branch.stats };
      const branchImageCount = imageEntries(branchConversation).length;
      const resolved = await resolve(branchConversation, {
        ...options,
        imageCache,
        imageIndexOffset: imageOffset,
        onProgress: () => options.onProgress?.(++completed, totalImages),
      });
      resolvedBranches.push({ ...branch, messages: resolved.messages, stats: resolved.stats });
      imageOffset += branchImageCount;
    }
    const branchTree = branchTreeFromBranches(resolvedBranches);
    const displayedMessages = branchTree.length > 0 ? messagesFromBranchTree(branchTree) : (resolvedBranches[0]?.messages ?? conversation.messages);
    // Counted from what the file shows: a shared message appears there once, so its
    // images count once, not once per branch that passes through it.
    const shownMessages = branchTree.length > 0 ? displayedMessages : resolvedBranches.flatMap((branch) => branch.messages);
    return {
      ...conversation,
      messages: resolvedBranches[0]?.messages ?? conversation.messages,
      branches: resolvedBranches,
      branchTree,
      stats: { ...conversation.stats, ...summarizeImageStats(shownMessages), messageCount: displayedMessages.length },
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
      // The image preferences are provider-neutral: Claude uploads go through the same
      // chooser, the same "none" switch and the same embedding path as ChatGPT images.
      let selectedImageIndices = null;
      const includeImages = prefs.imageMode !== 'none';
      if (prefs.imageMode === 'choose') {
        showStatus('Choose images…', 'Review the available images before any image downloads begin.');
        selectedImageIndices = await showImageSelection(normalized, includeAllBranches);
        if (selectedImageIndices === null) {
          showStatus('Export cancelled');
          return;
        }
      }
      const resolveImages = provider === 'Claude' ? resolveClaudeConversationImages : resolveConversationImages;
      const imageOptions = {
        conversationId,
        includeImages,
        selectedImageIndices,
        onProgress: (completed, total) => showStatus('Processing image choices…', `${completed}/${total} image(s) processed`),
      };
      const conversation = includeAllBranches
        ? await resolveAllConversationBranches(normalized, imageOptions, resolveImages)
        : await resolveImages(normalized, imageOptions);
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
        includeThinking: prefs.thinking === true,
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
    const existing = uiElement(CONTROL_ID);
    if (!provider) {
      existing?.remove();
      return;
    }
    if (!document.body) return;
    if (existing?.dataset.provider === provider) return;
    existing?.remove();
    if (provider === 'ChatGPT') installAuthCacheInvalidation();
    const button = document.createElement('button');
    button.id = CONTROL_ID;
    button.dataset.provider = provider;
    button.type = 'button';
    button.textContent = 'Export HTML';
    button.title = `Export the currently open ${provider} conversation as HTML`;
    button.addEventListener('click', () => showExportOptions(button, provider));
    uiRoot().appendChild(button);
  }

  function boot() {
    if (!document.body) return window.setTimeout(boot, 50);
    if (isChatGPTHost()) installTemporaryChatObserver();
    if (isClaudeHost()) installClaudeIncognitoObserver();
    install();
    if (window.MutationObserver && document.documentElement) {
      const observer = new MutationObserver(() => install());
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  boot();
})();
