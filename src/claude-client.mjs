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

export function parseClaudeConversationRoute(url = globalThis.location?.href ?? '') {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/$/, '');
    if (parsed.hostname !== 'claude.ai') return { kind: 'not-claude', conversationId: null, pathname, reason: 'host is not claude.ai' };
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
    if (block.type === 'thinking' || block.type === 'tool_result') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      textBlocks.push(textBlock(block.text));
      continue;
    }
    const type = typeof block.type === 'string' && block.type.trim() ? block.type.trim() : 'unknown';
    textBlocks.push(omittedBlock(`Claude ${type} content`));
    omittedCount += 1;
  }

  if (Array.isArray(message?.files) && message.files.length > 0) {
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
    messages: uniqueMessages,
    stats: {
      ...branches[0]?.stats,
      messageCount: uniqueMessages.length,
      sourceNodeCount: allCount,
      droppedNodeCount: ordered.activeBranch ? Math.max(0, allCount - ordered.messages.length) : 0,
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
