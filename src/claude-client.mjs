const CLAUDE_TIMEOUT_MS = 20_000;
const CLAUDE_ROUTE_RE = /^\/chat\/[A-Za-z0-9_-]{16,120}$/;

export class ClaudeClientError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ClaudeClientError';
    this.code = code;
    this.details = details;
  }
}

function currentClaudeOrigin() {
  return globalThis.location?.origin ?? 'https://claude.ai';
}

function redactClaudeId(value) {
  const text = String(value ?? '');
  return text ? `<id:${text.length}>` : '<missing>';
}

// Only the send-message request names the incognito chat for certain; other requests on
// the page (sidebar, prefetches) can carry the ids of other conversations.
const CLAUDE_INCOGNITO_ID_RE = /^\/api\/organizations\/[A-Za-z0-9_-]{1,120}\/chat_conversations\/([A-Za-z0-9_-]{16,120})\/(?:completion|retry_completion)$/;
const claudeIncognitoState = { key: undefined, since: 0, observed: [], observer: null };

function isClaudeIncognitoUrl(parsed) {
  return parsed.pathname.replace(/\/$/, '') === '/new' && parsed.searchParams.has('incognito');
}

function claudeIncognitoWindowStart(key) {
  // Requests made before the user entered this incognito chat belong to another chat.
  // The first route the script sees is the page load itself, so nothing precedes it.
  if (claudeIncognitoState.key === undefined) claudeIncognitoState.since = 0;
  else if (claudeIncognitoState.key !== key) claudeIncognitoState.since = globalThis.performance?.now?.() ?? 0;
  claudeIncognitoState.key = key;
  return claudeIncognitoState.since;
}

export function installClaudeIncognitoObserver() {
  // The resource-timing buffer stops recording once full; an observer does not.
  if (claudeIncognitoState.observer || typeof globalThis.PerformanceObserver !== 'function') return;
  try {
    claudeIncognitoState.observer = new globalThis.PerformanceObserver((list) => {
      for (const entry of list.getEntries()) claudeIncognitoState.observed.push({ name: entry.name, startTime: entry.startTime });
      claudeIncognitoState.observed.splice(0, Math.max(0, claudeIncognitoState.observed.length - 200));
    });
    claudeIncognitoState.observer.observe({ type: 'resource', buffered: true });
  } catch {
    claudeIncognitoState.observer = null;
  }
}

function claudeIncognitoConversationId(url, options) {
  // Keyed on the route, not the full address: Claude may rewrite the address after the
  // first message, and that must not discard the request that named the chat.
  const since = options.resourceEntries ? 0 : claudeIncognitoWindowStart('incognito');
  const entries = options.resourceEntries
    ?? [...(globalThis.performance?.getEntriesByType?.('resource') ?? []), ...claudeIncognitoState.observed];
  let latest = null;
  for (const entry of entries) {
    if (!(Number(entry?.startTime) >= since)) continue;
    let parsed;
    try {
      parsed = new URL(String(entry?.name ?? ''), currentClaudeOrigin());
    } catch {
      continue;
    }
    if (parsed.origin !== currentClaudeOrigin()) continue;
    const id = parsed.pathname.match(CLAUDE_INCOGNITO_ID_RE)?.[1];
    if (id && (!latest || entry.startTime >= latest.startTime)) latest = { id, startTime: entry.startTime };
  }
  return latest?.id ?? null;
}

export function parseClaudeConversationRoute(url = globalThis.location?.href ?? '', options = {}) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/$/, '');
    if (parsed.hostname !== 'claude.ai') return { kind: 'not-claude', conversationId: null, pathname, reason: 'host is not claude.ai' };
    if (isClaudeIncognitoUrl(parsed)) {
      // An incognito chat keeps its id out of the address bar; the page's own request
      // that sent the message carries it.
      const conversationId = claudeIncognitoConversationId(url, options);
      if (!conversationId) return { kind: 'incognito-pending', conversationId: null, pathname, reason: 'incognito chat has no message yet' };
      return { kind: 'conversation', conversationId, pathname, incognito: true };
    }
    if (!options.resourceEntries) claudeIncognitoWindowStart('');
    if (!CLAUDE_ROUTE_RE.test(pathname)) {
      return { kind: 'not-conversation', conversationId: null, pathname, reason: 'path is not a Claude conversation route' };
    }
    const conversationId = pathname.split('/').at(-1) ?? null;
    return { kind: 'conversation', conversationId, pathname };
  } catch {
    return { kind: 'invalid-url', conversationId: null, pathname: '', reason: 'invalid URL' };
  }
}

export function getClaudeConversationIdFromUrl(url = globalThis.location?.href ?? '') {
  const route = parseClaudeConversationRoute(url);
  return route.kind === 'conversation' ? route.conversationId : null;
}

export function isClaudeHost(locationLike = globalThis.location) {
  return locationLike?.hostname === 'claude.ai';
}

export function isClaudeExporterRoute(url = globalThis.location?.href ?? '') {
  return parseClaudeConversationRoute(url).kind === 'conversation';
}

function getClaudeCookie(name) {
  try {
    const prefix = `${name}=`;
    const raw = String(globalThis.document?.cookie ?? '').split(';').map((item) => item.trim()).find((item) => item.startsWith(prefix));
    if (!raw) return null;
    const value = decodeURIComponent(raw.slice(prefix.length));
    return value.slice(0, 200) || null;
  } catch {
    return null;
  }
}

export function getClaudeOrganizationId() {
  return getClaudeCookie('lastActiveOrg');
}

export function claudeConversationPath(organizationId, conversationId) {
  const org = String(organizationId ?? '');
  const id = String(conversationId ?? '');
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(org) || !/^[A-Za-z0-9_-]{16,120}$/.test(id)) return null;
  const query = 'tree=true&rendering_mode=messages&render_all_tools=true';
  return `/api/organizations/${encodeURIComponent(org)}/chat_conversations/${encodeURIComponent(id)}?${query}`;
}

async function fetchClaudeWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new ClaudeClientError('timeout', `Claude did not respond within ${timeoutMs / 1000} seconds.`);
    throw new ClaudeClientError('network', 'The browser could not reach Claude.');
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchClaudeConversation(conversationId, { fetchImpl = globalThis.fetch, timeoutMs = CLAUDE_TIMEOUT_MS, organizationId = getClaudeOrganizationId() } = {}) {
  if (!conversationId) throw new ClaudeClientError('missing-id', 'Open a Claude conversation before exporting.');
  if (typeof fetchImpl !== 'function') throw new ClaudeClientError('no-fetch', 'This browser does not provide fetch().');
  if (!organizationId) throw new ClaudeClientError('missing-organization', 'Claude session information was not found. Sign in, reload the conversation, and retry.');

  const path = claudeConversationPath(organizationId, conversationId);
  if (!path) throw new ClaudeClientError('invalid-route', 'The Claude conversation route is not recognized.');
  const url = new URL(path, currentClaudeOrigin()).toString();
  let response;
  try {
    response = await fetchClaudeWithTimeout(fetchImpl, url, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    }, timeoutMs);
  } catch (error) {
    if (error instanceof ClaudeClientError) throw error;
    throw new ClaudeClientError('network', 'The browser could not reach Claude.');
  }

  if (response.status === 401 || response.status === 403) throw new ClaudeClientError('auth', `Claude rejected the conversation request (${response.status}). Sign in again, then retry.`);
  if (response.status === 404) throw new ClaudeClientError('not-found', 'Claude could not find this conversation. The internal request path may have changed.');
  if (response.status === 429) throw new ClaudeClientError('rate-limit', 'Claude is rate-limiting the request. Wait briefly and retry.');
  if (!response.ok) throw new ClaudeClientError('http', `Claude returned HTTP ${response.status}.`);

  const contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase();
  if (!contentType.includes('json')) throw new ClaudeClientError('content-type', 'Claude did not return conversation JSON.');
  try {
    return await response.json();
  } catch {
    throw new ClaudeClientError('invalid-json', 'Claude returned an unreadable conversation response.');
  }
}

function textBlock(text) {
  return { type: 'text', text: String(text ?? '') };
}

function omittedBlock(reason) {
  return { type: 'omitted', reason };
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

// `size_bytes` is the size of the file the person uploaded, not of the preview variant
// the exporter embeds, so the image chooser's running total reads high for Claude. It is
// the only size the payload gives before the bytes are fetched.
function claudeImageBlock(file, previewUrl) {
  const preview = file?.preview_asset && typeof file.preview_asset === 'object' ? file.preview_asset : {};
  return {
    type: 'image',
    asset: {
      pointer: previewUrl,
      mimeType: '',
      sizeBytes: finiteOrNull(file?.size_bytes),
      width: finiteOrNull(preview?.image_width),
      height: finiteOrNull(preview?.image_height),
      // Claude has no image generation, so every image here is one the person uploaded.
      generated: false,
      imageModel: null,
    },
  };
}

function claudeString(value) {
  return typeof value === 'string' ? value : '';
}

// Every thinking and tool block carries an ISO start and stop timestamp, which is where
// Claude's own "Thought for 56s" comes from. Missing or malformed ones give null rather
// than a fabricated duration.
function claudeDurationMs(block) {
  const start = Date.parse(claudeString(block?.start_timestamp));
  const stop = Date.parse(claudeString(block?.stop_timestamp));
  return Number.isFinite(start) && Number.isFinite(stop) && stop >= start ? stop - start : null;
}

// Confirmed live on 2026-09-18: a thinking block arrives with `thinking_hidden: true` and
// an EMPTY `thinking` string. Claude's server withholds the raw reasoning, so the summary
// lines are the whole of what any export can carry. `thinking` is still read, because a
// payload that does carry it should not be thrown away.
function claudeThinkingBlock(block) {
  const summaries = (Array.isArray(block?.summaries) ? block.summaries : [])
    .map((entry) => claudeString(typeof entry === 'string' ? entry : entry?.summary).trim())
    .filter(Boolean);
  return {
    type: 'thinking',
    summaries,
    text: claudeString(block?.thinking).trim(),
    withheldByProvider: Boolean(block?.thinking_hidden),
    truncated: Boolean(block?.truncated || block?.cut_off),
    durationMs: claudeDurationMs(block),
  };
}

// `name` is the raw tool identifier; `integration_name` names the connector it belongs to
// ("Consensus"). Both are shown when they differ, because a bare MCP tool name often does
// not say whose tool it is.
function claudeToolUseBlock(block) {
  return {
    type: 'tool_use',
    toolName: claudeString(block?.name).trim(),
    integration: claudeString(block?.integration_name).trim(),
    status: claudeString(block?.message).trim(),
    input: block?.input && typeof block.input === 'object' && !Array.isArray(block.input) ? block.input : null,
    durationMs: claudeDurationMs(block),
  };
}

// A result's `content` is an array of text parts; `display_content.json_block` repeats the
// same payload formatted for Claude's own UI, so it is not read — carrying both would
// double the size of an export for nothing.
function claudeToolResultBlock(block) {
  const parts = (Array.isArray(block?.content) ? block.content : [])
    .map((entry) => claudeString(typeof entry === 'string' ? entry : entry?.text))
    .filter((text) => text.trim());
  return {
    type: 'tool_result',
    toolName: claudeString(block?.name).trim(),
    integration: claudeString(block?.integration_name).trim(),
    isError: Boolean(block?.is_error),
    text: parts.join('\n\n'),
    durationMs: claudeDurationMs(block),
  };
}

function normalizeClaudeMessage(message, index) {
  const sender = String(message?.sender ?? 'unknown').toLowerCase();
  const role = sender === 'human' ? 'user' : sender === 'assistant' ? 'assistant' : 'unknown';
  const label = role === 'user' ? 'You' : role === 'assistant' ? 'Claude' : (sender || 'Unknown');
  const hidden = Boolean(message?.is_visually_hidden_from_conversation || message?.hidden);
  const textBlocks = [];
  let omittedCount = 0;
  const content = Array.isArray(message?.content) ? message.content : [];

  for (const block of content) {
    if (typeof block === 'string') {
      textBlocks.push(textBlock(block));
      continue;
    }
    if (!block || typeof block !== 'object') {
      textBlocks.push(omittedBlock('Claude returned an unsupported content block'));
      omittedCount += 1;
      continue;
    }
    if (block.type === 'thinking') {
      textBlocks.push(claudeThinkingBlock(block));
      continue;
    }
    if (block.type === 'tool_use') {
      textBlocks.push(claudeToolUseBlock(block));
      continue;
    }
    if (block.type === 'tool_result') {
      textBlocks.push(claudeToolResultBlock(block));
      continue;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      textBlocks.push(textBlock(block.text));
      continue;
    }
    const type = typeof block.type === 'string' && block.type.trim() ? block.type.trim() : 'unknown';
    textBlocks.push(omittedBlock(`Claude ${type} content`));
    omittedCount += 1;
  }

  // An uploaded image carries `file_kind: "image"` and a `preview_url` pointing at the
  // largest variant Claude stores; there is no original-size route in the payload, so the
  // preview is the best available copy. Anything else attached (a PDF, a text file) still
  // has no fetchable representation here and stays an omission marker.
  for (const file of Array.isArray(message?.files) ? message.files : []) {
    const previewUrl = typeof file?.preview_url === 'string' ? file.preview_url.trim() : '';
    if (String(file?.file_kind ?? '').toLowerCase() === 'image' && previewUrl) {
      textBlocks.push(claudeImageBlock(file, previewUrl));
      continue;
    }
    textBlocks.push(omittedBlock('Claude attachment or file content'));
    omittedCount += 1;
  }
  if (Array.isArray(message?.attachments) && message.attachments.length > 0) {
    textBlocks.push(omittedBlock('Claude extracted attachment content'));
    omittedCount += 1;
  }
  if (textBlocks.length === 0) {
    textBlocks.push(omittedBlock('Claude message had no text content'));
    omittedCount += 1;
  }

  return {
    id: String(message?.uuid ?? message?.id ?? `claude-message-${index + 1}`),
    role,
    authorLabel: hidden ? `${label} (hidden by Claude)` : label,
    createdAt: message?.created_at ?? message?.createdAt ?? null,
    parentId: message?.parent_message_uuid ?? message?.parent ?? null,
    modelSlug: typeof message?.model === 'string' && message.model.trim() ? message.model.trim() : (typeof message?.model_slug === 'string' && message.model_slug.trim() ? message.model_slug.trim() : null),
    textBlocks,
    omittedCount,
    hidden,
  };
}

function claudeMessageId(message) {
  return String(message?.uuid ?? message?.id ?? '');
}

function claudePathToLeaf(byId, leafId) {
  const path = [];
  const seen = new Set();
  let current = leafId && byId.has(leafId) ? byId.get(leafId) : null;
  while (current && !seen.has(claudeMessageId(current))) {
    seen.add(claudeMessageId(current));
    path.push(current);
    const parentId = String(current?.parent_message_uuid ?? current?.parent ?? '');
    current = parentId ? byId.get(parentId) : null;
  }
  return path.reverse();
}

function orderedClaudeMessages(raw) {
  const all = Array.isArray(raw?.chat_messages) ? raw.chat_messages : [];
  if (all.length === 0) throw new ClaudeClientError('shape', 'Claude returned no conversation messages.');
  const byId = new Map(all.map((message) => [claudeMessageId(message), message]));
  const currentLeaf = String(raw?.current_leaf_message_uuid ?? '');
  const children = new Set(all.map((message) => String(message?.parent_message_uuid ?? message?.parent ?? '')).filter(Boolean));
  const leaves = all.filter((message) => !children.has(claudeMessageId(message)));
  const orderedLeafIds = [currentLeaf, ...leaves.map(claudeMessageId).filter((id) => id !== currentLeaf)].filter(Boolean);
  const branchPaths = [];
  const seenPaths = new Set();
  for (const leafId of orderedLeafIds) {
    const path = claudePathToLeaf(byId, leafId);
    const key = path.map(claudeMessageId).join('\\u0000');
    if (!path.length || seenPaths.has(key)) continue;
    seenPaths.add(key);
    branchPaths.push(path);
  }
  if (branchPaths.length > 0) return { messages: branchPaths[0], branchPaths, activeBranch: Boolean(currentLeaf && byId.has(currentLeaf)) };
  const fallback = [...all].sort((left, right) => Number(left?.index ?? 0) - Number(right?.index ?? 0));
  return { messages: fallback, branchPaths: [fallback], activeBranch: false };
}

function claudeBranchTreeFromBranches(branches) {
  const records = Array.isArray(branches) ? branches : [];
  const byId = new Map();
  const order = [];
  for (const branch of records) {
    for (const message of Array.isArray(branch?.messages) ? branch.messages : []) {
      const id = String(message?.id ?? '');
      if (!id || byId.has(id)) continue;
      byId.set(id, { message, children: [] });
      order.push(id);
    }
  }
  const childIds = new Set();
  for (const id of order) {
    const node = byId.get(id);
    const parentId = String(node?.message?.parentId ?? '');
    if (!parentId || !byId.has(parentId) || parentId === id) continue;
    const parent = byId.get(parentId);
    if (!parent.children.some((child) => child.message.id === id)) parent.children.push(node);
    childIds.add(id);
  }
  const roots = order.filter((id) => !childIds.has(id)).map((id) => byId.get(id));
  return roots.length > 0 ? roots : order.slice(0, 1).map((id) => byId.get(id));
}

export function normalizeClaudeConversation(raw, conversationId = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ClaudeClientError('shape', 'Claude returned an invalid conversation object.');
  const ordered = orderedClaudeMessages(raw);
  const normalizePath = (path) => {
    const normalized = path.map(normalizeClaudeMessage);
    const unique = [];
    const seen = new Set();
    for (const message of normalized) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      unique.push(message);
    }
    return unique;
  };
  const messages = normalizePath(ordered.messages);
  const branches = ordered.branchPaths.map((path, index) => {
    const branchMessages = normalizePath(path);
    const sourceNodeCount = path.length;
    return {
      index,
      leafId: claudeMessageId(path.at(-1)),
      active: index === 0,
      messages: branchMessages,
      stats: {
        messageCount: branchMessages.length,
        omittedBlockCount: branchMessages.reduce((sum, message) => sum + message.omittedCount, 0),
        sourceNodeCount,
        droppedNodeCount: Math.max(0, sourceNodeCount - branchMessages.length),
        duplicateMessageCount: Math.max(0, sourceNodeCount - branchMessages.length),
        hiddenMessageCount: branchMessages.filter((message) => message.hidden).length,
        imageCount: 0,
        imageEmbeddedCount: 0,
        imageExcludedCount: 0,
        imageUnavailableCount: 0,
        imageBytes: 0,
        imageBudgetLimitedCount: 0,
      },
    };
  });
  const uniqueMessages = messages;
  const allCount = Array.isArray(raw.chat_messages) ? raw.chat_messages.length : uniqueMessages.length;
  return {
    title: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : (typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : 'Claude conversation'),
    conversationId: conversationId ?? raw.conversation_id ?? raw.id ?? null,
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : null,
    provider: 'Claude',
    sourceShape: 'claude-message-tree',
    activeBranch: ordered.activeBranch,
    activeBranchIndex: 0,
    branches: branches.length > 1 ? branches : [],
    branchTree: branches.length > 1 ? claudeBranchTreeFromBranches(branches) : [],
    messages: uniqueMessages,
    stats: {
      ...branches[0]?.stats,
      messageCount: uniqueMessages.length,
      sourceNodeCount: allCount,
      // Every Claude node is a real message, so nothing is structurally dropped here.
      // Messages sitting on branches this export did not take are reported separately:
      // they are withheld by choice, not lost.
      droppedNodeCount: 0,
      alternateBranchMessageCount: ordered.activeBranch ? Math.max(0, allCount - ordered.messages.length) : 0,
      duplicateMessageCount: branches[0]?.stats?.duplicateMessageCount ?? 0,
      hiddenMessageCount: uniqueMessages.filter((message) => message.hidden).length,
      branchCount: branches.length,
      imageCount: 0,
      imageEmbeddedCount: 0,
      imageExcludedCount: 0,
      imageUnavailableCount: 0,
      imageBytes: 0,
      imageBudgetLimitedCount: 0,
    },
  };
}

export function describeClaudeError(error) {
  if (!(error instanceof ClaudeClientError)) return error?.message ?? String(error);
  return error.message;
}
