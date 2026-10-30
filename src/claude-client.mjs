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
      for (const entry of list.getEntries()) claudeIncognitoState.observed.push({ name: entry.name, startTime: entry.startTime, responseStatus: entry.responseStatus, initiatorType: entry.initiatorType });
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

const CLAUDE_ORG_RE = /^[A-Za-z0-9_-]{1,200}$/;
const CLAUDE_CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{16,120}$/;
const CLAUDE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FALLBACK_ORGANIZATIONS = 5;

export function claudeConversationPath(organizationId, conversationId) {
  const org = String(organizationId ?? '');
  const id = String(conversationId ?? '');
  if (!CLAUDE_ORG_RE.test(org) || !CLAUDE_CONVERSATION_ID_RE.test(id)) return null;
  const query = 'tree=true&rendering_mode=messages&render_all_tools=true';
  return `/api/organizations/${encodeURIComponent(org)}/chat_conversations/${encodeURIComponent(id)}?${query}`;
}

// What a 404 report may say about the conversation id: whether it is a chat UUID, and a
// short type prefix such as `cse_` when it has one. Never the id itself.
export function claudeIdFormat(conversationId) {
  const value = String(conversationId ?? '');
  if (CLAUDE_UUID_RE.test(value)) return 'chat UUID';
  const prefix = value.match(/^([a-z]{2,12})_/)?.[1];
  return `${prefix ? `"${prefix}_" prefix, ` : ''}${value.length} characters, not a chat UUID`;
}

// A static API segment is lowercase words, optionally versioned (`chat_conversations_v2`).
// Anything else long enough to be an identifier is replaced, keeping only a type prefix.
function claudeSegmentShape(segment, conversationId) {
  if (conversationId && segment === conversationId) return '<this-chat>';
  if (segment.length < 8 || /^[a-z]+(?:[_-][a-z]+)*(?:[_-]v\d{1,2})?$/.test(segment)) return segment;
  const prefix = segment.match(/^([a-z]{2,12})_/)?.[1];
  return prefix ? `<${prefix}_id>` : '<id>';
}

// An RPC path carries no identifier, only a dotted service name and a method name
// (`/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline`). v0.16.3
// reported both as `<id>`, which hid which call Claude's page made.
const CLAUDE_RPC_NAME_RE = /^(?:[a-z][a-z0-9]*\.){2,8}[A-Z][A-Za-z0-9]{2,60}$|^(?:[A-Z][a-z]+){2,8}$/;

export function redactClaudePath(pathname, conversationId = '') {
  const segments = String(pathname ?? '').split('/');
  const rpc = segments[1] === 'claudeai-rpc';
  return segments.map((segment) => (rpc && CLAUDE_RPC_NAME_RE.test(segment) ? segment : claudeSegmentShape(segment, String(conversationId ?? '')))).join('/');
}

function claudeNow() {
  const now = Number(globalThis.performance?.now?.());
  return Number.isFinite(now) ? now : 0;
}

// The exporter's own requests land in the same Resource Timing buffer as the page's. Each
// is remembered with its time window so a 404 report never lists one of them as a request
// Claude's page made. v0.16.2's report did, and it read as the page using the same address.
const claudeOwnRequests = [];

function isOwnClaudeRequest(entry, own) {
  const start = Number(entry?.startTime);
  return own.some((request) => request.url === String(entry?.name ?? '') && start >= request.start - 1 && start <= request.end + 1);
}

// The page's own same-origin API requests, newest first, plus any other data request it
// made with fetch or XHR: a chat that is not loaded through the API may come through a
// page-data request instead. A status is present only where the browser reports one:
// Chromium does, some other browsers do not.
function claudePageRequests(conversationId, entries = null, own = claudeOwnRequests) {
  const id = String(conversationId ?? '');
  const source = entries ?? [...(globalThis.performance?.getEntriesByType?.('resource') ?? []), ...claudeIncognitoState.observed];
  const ordered = [...source].reverse().sort((left, right) => (Number(right?.startTime) || 0) - (Number(left?.startTime) || 0));
  const seen = new Set();
  const requests = [];
  for (const entry of ordered) {
    const key = `${entry?.name}\u0000${entry?.startTime}`;
    if (seen.has(key) || isOwnClaudeRequest(entry, own)) continue;
    seen.add(key);
    let parsed;
    try {
      parsed = new URL(String(entry?.name ?? ''), currentClaudeOrigin());
    } catch {
      continue;
    }
    if (parsed.origin !== currentClaudeOrigin()) continue;
    if (!/^\/(?:api|v1|claudeai-rpc)\//.test(parsed.pathname) && !['fetch', 'xmlhttprequest'].includes(String(entry?.initiatorType ?? ''))) continue;
    const status = Number(entry?.responseStatus);
    const organization = parsed.pathname.match(/^\/api\/organizations\/([^/]+)\//)?.[1] ?? '';
    requests.push({
      parsed,
      status: Number.isInteger(status) && status > 0 ? status : null,
      organization: CLAUDE_ORG_RE.test(organization) ? organization : null,
      namesChat: Boolean(id) && (parsed.pathname.split('/').includes(id) || [...parsed.searchParams.values()].includes(id)),
      loadsChat: Boolean(id) && Boolean(organization) && parsed.pathname === `/api/organizations/${organization}/chat_conversations/${id}`,
    });
  }
  return requests;
}

// The page's own API requests, reduced to path shapes with every identifier replaced and
// query values dropped. Requests naming this conversation come first: they show which
// endpoint Claude's page itself used to load it.
export function claudeRequestShapes(conversationId, entries = null, limit = 8, own = claudeOwnRequests) {
  const id = String(conversationId ?? '');
  const naming = [];
  const other = [];
  for (const request of claudePageRequests(id, entries, own)) {
    const keys = [...new Set(request.parsed.searchParams.keys())].filter((key) => /^[A-Za-z_]{1,40}$/.test(key)).slice(0, 6);
    const shape = `${redactClaudePath(request.parsed.pathname, id)}${keys.length ? `?${keys.join(',')}` : ''}${request.status ? ` (HTTP ${request.status})` : ''}`;
    const list = request.namesChat ? naming : other;
    if (!list.includes(shape)) list.push(shape);
  }
  return { naming: naming.slice(0, limit), other: other.slice(0, limit) };
}

const CLAUDE_QUERY_KEY_RE = /^[A-Za-z_]{1,40}$/;
const CLAUDE_QUERY_VALUE_RE = /^[A-Za-z0-9_.-]{0,40}$/;

// Retries after a 404, each built from evidence. Claude's page names the organization it
// used in its requests for this chat, and its own conversation request shows the query it
// sent. Both are evidence only: same origin, the allowlisted path shape, validated
// identifiers and a short allowlisted query. Resource Timing does not record a method, so
// the page's request is never repeated as such: the exporter sends a GET, and only for a
// query asking for the message tree the normalizer reads. Claude's page also asks with
// `consistency=strong` (seen in a September 2026 capture); the plain request does not.
function claudeRetryPaths(conversationId, fallbackOrganization, entries = null) {
  const id = String(conversationId ?? '');
  const paths = [];
  for (const request of claudePageRequests(id, entries)) {
    if (!request.namesChat || !request.organization) continue;
    paths.push({ label: 'organization Claude’s page used', organization: request.organization, path: claudeConversationPath(request.organization, id) });
    const pairs = [...request.parsed.searchParams];
    const asksForTree = /^true$/i.test(request.parsed.searchParams.get('tree') ?? '') && request.parsed.searchParams.get('rendering_mode') === 'messages';
    if (request.loadsChat && asksForTree && pairs.length <= 8 && pairs.every(([key, value]) => CLAUDE_QUERY_KEY_RE.test(key) && CLAUDE_QUERY_VALUE_RE.test(value))) {
      const query = new URLSearchParams(pairs).toString();
      paths.push({ label: 'exact request Claude’s page made', organization: request.organization, path: `/api/organizations/${encodeURIComponent(request.organization)}/chat_conversations/${encodeURIComponent(id)}${query ? `?${query}` : ''}` });
    }
  }
  const organization = paths[0]?.organization ?? fallbackOrganization;
  const plain = claudeConversationPath(organization, id);
  if (plain) paths.push({ label: 'consistency=strong', organization, path: `${plain}&consistency=strong` });
  return paths;
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

function rememberOwnClaudeRequest(url) {
  const own = { url, start: claudeNow(), end: Number.POSITIVE_INFINITY };
  claudeOwnRequests.push(own);
  claudeOwnRequests.splice(0, Math.max(0, claudeOwnRequests.length - 50));
  return own;
}

async function claudeGet(fetchImpl, path, timeoutMs) {
  const url = new URL(path, currentClaudeOrigin()).toString();
  const own = rememberOwnClaudeRequest(url);
  try {
    return await fetchClaudeWithTimeout(fetchImpl, url, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    }, timeoutMs);
  } catch (error) {
    if (error instanceof ClaudeClientError) throw error;
    throw new ClaudeClientError('network', 'The browser could not reach Claude.');
  } finally {
    own.end = claudeNow();
  }
}

// The `lastActiveOrg` cookie names one organization. An account with two (a personal plan
// and a Team, say) gets a 404 for a chat that lives in the other one, so the account's
// organization list is the fallback. A failure here only means there is nothing to add.
async function listClaudeOrganizations(fetchImpl, timeoutMs) {
  try {
    const response = await claudeGet(fetchImpl, '/api/organizations', timeoutMs);
    if (!response.ok || !String(response.headers?.get?.('content-type') ?? '').toLowerCase().includes('json')) return [];
    const body = await response.json();
    return [...new Set((Array.isArray(body) ? body : []).map((org) => String(org?.uuid ?? org?.id ?? '')).filter((id) => CLAUDE_ORG_RE.test(id)))];
  } catch {
    return [];
  }
}

// Claude's new chat layout (chat and Cowork merged) loads chats through a Connect RPC
// service, and the chat API answers 404 for the ones that live only there. Nothing about
// the service is published: the method, header and field names here come from a
// third-party extraction of its schema (claude-ext-common's bard-schema.js, snapshot
// 2026-10-07). It takes Connect's JSON codec, a POST of camelCase fields, and answers in
// protojson: enum names, int64 values as strings, RFC 3339 timestamps, defaults left out.
const CLAUDE_RPC_PATH = '/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/';
const MAX_CLAUDE_HISTORY_PAGES = 100;

// The headers Claude's page sends with these calls. The service also checks Origin,
// which a same-origin fetch from the page carries.
async function claudeRpc(fetchImpl, method, organizationId, body, timeoutMs) {
  const url = new URL(`${CLAUDE_RPC_PATH}${method}`, currentClaudeOrigin()).toString();
  const own = rememberOwnClaudeRequest(url);
  try {
    return await fetchClaudeWithTimeout(fetchImpl, url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'X-Organization-Uuid': organizationId,
        'Anthropic-Client-Platform': 'web_claude_ai',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    }, timeoutMs);
  } finally {
    own.end = claudeNow();
  }
}

async function claudeRpcBody(response) {
  if (!String(response.headers?.get?.('content-type') ?? '').toLowerCase().includes('json')) return null;
  try {
    const body = await response.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

// A Connect error body is `{ code, message }`. Only the code is reported: the message is
// free text from Claude.
async function claudeRpcErrorCode(response) {
  const code = (await claudeRpcBody(response))?.code;
  return typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? code : null;
}

// protojson writes lowerCamelCase names unless the server asks for the .proto names, and
// enum names unless it asks for numbers. Each is read either way.
function bardField(record, camel, snake) {
  return record && typeof record === 'object' ? (record[camel] ?? record[snake]) : undefined;
}

function bardEnum(value, prefix, names) {
  if (Number.isInteger(value)) return names[value] ?? '';
  return typeof value === 'string' && value.startsWith(prefix) ? value.slice(prefix.length) : '';
}

function bardList(value) {
  return Array.isArray(value) ? value : [];
}

function bardTimestamp(value) {
  if (typeof value === 'string') return Number.isFinite(Date.parse(value)) ? value : null;
  const seconds = Number(value?.seconds);
  const ms = seconds * 1000 + (Number(value?.nanos) || 0) / 1e6;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
}

const BARD_ROLES = ['UNSPECIFIED', 'USER', 'ASSISTANT', 'SYSTEM'];
const BARD_BLOCK_STATES = ['UNSPECIFIED', 'RUNNING', 'COMPLETE', 'ERROR', 'PENDING_APPROVAL', 'CANCELLED'];
const BARD_TEXT_STYLES = ['UNSPECIFIED', 'PLAIN', 'MARKDOWN', 'CODE'];
const BARD_FILE_KINDS = ['UNSPECIFIED', 'IMAGE', 'BLOB', 'DOCUMENT'];
const BARD_INPUT_KINDS = ['UNSPECIFIED', 'TEXT', 'COMMAND', 'FILE_PATH', 'PATTERN', 'URL', 'QUERY', 'UNNAMED_WEB_PAGE', 'SKILL_NAME', 'JAVASCRIPT'];
const CLAUDE_SAFE_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

function bardIndexOrder(left, right) {
  return (Number(left?.index) || 0) - (Number(right?.index) || 0);
}

// A rich card (weather, a map, a recipe) is named by the one field its display content
// sets; the card itself is not exported.
function bardCardKind(block) {
  const content = bardField(block, 'displayContent', 'display_content');
  const key = content && typeof content === 'object' ? Object.keys(content).find((name) => /^[A-Za-z_]{1,40}$/.test(name)) : null;
  return key ? key.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() : null;
}

// `input_summary` can be cut short; the input table holds each value in full. Built with
// Object.fromEntries so a key such as `__proto__` stays a plain field.
function bardToolInput(block, inputSummary, inputKind) {
  const table = bardField(bardField(block, 'inputDisplay', 'input_display'), 'table', 'table');
  const entries = [];
  for (const row of bardList(table?.rows)) {
    const key = claudeString(bardField(row, 'inputKey', 'input_key')).trim() || claudeString(row?.label).trim();
    if (key && typeof row?.value === 'string' && !entries.some(([other]) => other === key)) entries.push([key, row.value]);
  }
  if (entries.length > 0) return Object.fromEntries(entries);
  return inputSummary.trim() ? { [inputKind && inputKind !== 'UNSPECIFIED' ? inputKind.toLowerCase() : 'input']: inputSummary } : null;
}

// A web search's results come as a list of titles and addresses, which is also all the
// chat API keeps of them.
function bardResultText(block, text) {
  if (text.trim()) return text;
  const list = bardField(bardField(block, 'displayContent', 'display_content'), 'richItems', 'rich_items');
  return bardList(list?.items)
    .map((item) => [claudeString(item?.title).trim(), claudeString(item?.url).trim()].filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n');
}

// A content block has no type field: which fields are set says what it is. Thinking has
// summary lines or thinking timestamps, a tool step has a tool name, an input summary or a
// row kind, and the rest is text. Each becomes the chat API's block of the same kind, so
// one normalizer reads both.
function bardContentBlocks(block) {
  const text = claudeString(block?.text);
  const summaries = bardList(block?.summaries).map((entry) => ({ summary: claudeString(entry?.summary) }));
  const thinking = bardField(block, 'thinkingDisplay', 'thinking_display');
  if (summaries.length > 0 || (thinking && typeof thinking === 'object')) {
    return [{
      type: 'thinking',
      thinking: text,
      // Only an absent reasoning text with summary lines in its place reads as withheld.
      thinking_hidden: !text.trim() && summaries.some((entry) => entry.summary.trim()),
      summaries,
      truncated: Boolean(bardField(block, 'isTruncated', 'is_truncated')),
      start_timestamp: bardTimestamp(bardField(thinking, 'startedAt', 'started_at')),
      stop_timestamp: bardTimestamp(bardField(thinking, 'completedAt', 'completed_at')),
    }];
  }
  const toolName = claudeString(bardField(block, 'toolDisplayName', 'tool_display_name')).trim();
  const inputSummary = claudeString(bardField(block, 'inputSummary', 'input_summary'));
  const rowKind = bardField(block, 'rowKind', 'row_kind');
  const isToolRow = Number.isInteger(rowKind) ? rowKind > 0 : typeof rowKind === 'string' && rowKind.startsWith('TOOL_ROW_KIND_') && rowKind !== 'TOOL_ROW_KIND_UNSPECIFIED';
  if (toolName || inputSummary.trim() || isToolRow) {
    const title = claudeString(block?.title).trim();
    const name = toolName || title || 'tool';
    const inputKind = bardEnum(bardField(block, 'inputSummaryKind', 'input_summary_kind'), 'INPUT_SUMMARY_KIND_', BARD_INPUT_KINDS);
    const failed = bardEnum(block?.state, 'CONTENT_BLOCK_STATE_', BARD_BLOCK_STATES) === 'ERROR';
    const result = bardResultText(block, text);
    const blocks = [{ type: 'tool_use', name, message: title && title !== name ? title : '', input: bardToolInput(block, inputSummary, inputKind) }];
    if (result.trim() || failed) blocks.push({ type: 'tool_result', name, is_error: failed, content: [{ type: 'text', text: result }] });
    return blocks;
  }
  if (text.trim()) {
    const format = bardField(block, 'textFormat', 'text_format');
    const language = claudeString(format?.language).trim();
    // A code block is fenced so the renderer shows it as code; one that holds a fence of
    // its own stays plain text rather than breaking out of it.
    if (bardEnum(format?.style, 'STYLE_', BARD_TEXT_STYLES) === 'CODE' && !/^\s*```/m.test(text)) {
      return [{ type: 'text', text: `\`\`\`${/^[A-Za-z0-9_+.#-]{1,30}$/.test(language) ? language : ''}\n${text}\n\`\`\`` }];
    }
    return [{ type: 'text', text }];
  }
  const card = bardCardKind(block);
  return card ? [{ type: `${card} card` }] : [];
}

// Only an uploaded image on an approved same-origin route is ever fetched (see assets.mjs);
// any other attachment stays an omission marker, as on the chat API.
function bardAttachment(attachment) {
  const kind = bardEnum(bardField(attachment, 'fileKind', 'file_kind'), 'FILE_KIND_', BARD_FILE_KINDS);
  const mediaType = claudeString(bardField(attachment, 'mediaType', 'media_type'));
  const image = (kind === 'IMAGE' || /^image\//i.test(mediaType)) && !attachment?.unavailable;
  const size = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null);
  const addresses = [claudeString(attachment?.url).trim(), claudeString(bardField(attachment, 'thumbnailUrl', 'thumbnail_url')).trim()].filter(Boolean);
  return {
    file_kind: image ? 'image' : 'file',
    preview_url: addresses.find((address) => /\/files\/[^/?#]+\/(?:preview|thumbnail)$/.test(address)) ?? addresses[0] ?? '',
    size_bytes: size(bardField(attachment, 'fileSize', 'file_size')),
    preview_asset: { image_width: size(bardField(attachment, 'previewWidth', 'preview_width')), image_height: size(bardField(attachment, 'previewHeight', 'preview_height')) },
  };
}

function bardGroupBy(records, key) {
  const groups = new Map();
  for (const record of records) {
    const id = key(record);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(record);
  }
  return groups;
}

// The service's messages, display groups and content blocks, rebuilt as the chat API's
// conversation: each message's groups in order, each group's blocks in order.
function claudeTimelineConversation(updates, historyComplete) {
  const records = { messages: new Map(), groups: new Map(), blocks: new Map() };
  const deleted = new Set();
  let conversation = null;
  const collect = (map, list) => {
    for (const record of bardList(list)) {
      const id = claudeString(record?.id);
      // The first answer is the newest state; history pages only add what it lacks.
      if (id && !map.has(id)) map.set(id, record);
    }
  };
  for (const update of updates) {
    if (!conversation && update?.conversation && typeof update.conversation === 'object') conversation = update.conversation;
    collect(records.messages, update?.messages);
    collect(records.groups, bardField(update, 'displayGroups', 'display_groups'));
    collect(records.blocks, bardField(update, 'contentBlocks', 'content_blocks'));
    for (const [camel, snake] of [['deletedMessageIds', 'deleted_message_ids'], ['deletedDisplayGroupIds', 'deleted_display_group_ids'], ['deletedContentBlockIds', 'deleted_content_block_ids']]) {
      for (const id of bardList(bardField(update, camel, snake))) deleted.add(String(id));
    }
  }
  const live = (map) => [...map.values()].filter((record) => !deleted.has(claudeString(record?.id)));
  const blocksByGroup = bardGroupBy(live(records.blocks), (block) => claudeString(bardField(block, 'displayGroupId', 'display_group_id')));
  const groupsByMessage = bardGroupBy(live(records.groups), (group) => claudeString(bardField(group, 'messageId', 'message_id')));
  const chatMessages = live(records.messages).map((message) => {
    const id = claudeString(message?.id);
    const role = bardEnum(message?.role, 'ROLE_', BARD_ROLES);
    const fallback = bardField(message, 'turnModelFallback', 'turn_model_fallback');
    const served = claudeString(bardField(fallback, 'servedModel', 'served_model')).trim();
    return {
      uuid: id,
      sender: role === 'USER' ? 'human' : role === 'ASSISTANT' ? 'assistant' : (role.toLowerCase() || 'unknown'),
      index: Number(message?.index) || 0,
      created_at: bardTimestamp(bardField(message, 'createdAt', 'created_at')),
      parent_message_uuid: claudeString(bardField(message, 'parentMessageId', 'parent_message_id')) || null,
      content: [...(groupsByMessage.get(id) ?? [])].sort(bardIndexOrder)
        .flatMap((group) => [...(blocksByGroup.get(claudeString(group?.id)) ?? [])].sort(bardIndexOrder).flatMap(bardContentBlocks)),
      files: bardList(message?.attachments).map(bardAttachment),
      // The service names a model on a reply only when Claude answered with another model
      // than the one asked for; `served_model` is the one that wrote it.
      model: CLAUDE_SAFE_MODEL_RE.test(served) ? served : undefined,
    };
  });
  // With no parent links at all, the messages are one line in index order.
  if (chatMessages.length > 1 && chatMessages.every((message) => !message.parent_message_uuid)) {
    chatMessages.sort(bardIndexOrder).forEach((message, index) => { message.parent_message_uuid = index > 0 ? chatMessages[index - 1].uuid : null; });
  }
  const model = conversation?.model;
  const identifier = claudeString(typeof model === 'string' ? model : model?.identifier).trim();
  return {
    name: claudeString(conversation?.title).trim(),
    model: CLAUDE_SAFE_MODEL_RE.test(identifier) ? identifier : null,
    current_leaf_message_uuid: claudeString(bardField(conversation, 'currentLeafMessageId', 'current_leaf_message_id')) || null,
    chat_messages: chatMessages,
    source_shape: 'claude-rpc-timeline',
    history_incomplete: !historyComplete,
  };
}

function claudeCursor(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 ? value : null;
}

// The first answer may hold only the latest part of a long chat, with a cursor for the
// part before it. Pages are read until there is no cursor, at most 100 of them; stopping
// early is reported in the export rather than passed off as the whole chat.
async function readClaudeHistory(fetchImpl, conversationId, organization, first, timeoutMs) {
  const updates = [];
  const seen = new Set();
  let cursor = claudeCursor(bardField(first, 'olderHistoryCursor', 'older_history_cursor'));
  while (cursor) {
    if (seen.has(cursor) || seen.size >= MAX_CLAUDE_HISTORY_PAGES) return { updates, complete: false };
    seen.add(cursor);
    let response;
    try {
      response = await claudeRpc(fetchImpl, 'ReadConversationHistory', organization, { conversationId, cursor }, timeoutMs);
    } catch {
      return { updates, complete: false };
    }
    const body = response.ok ? await claudeRpcBody(response) : null;
    if (!body || (body.outcome !== undefined && body.outcome !== 'OUTCOME_PAGE' && body.outcome !== 1)) return { updates, complete: false };
    if (body.update && typeof body.update === 'object') updates.push(body.update);
    cursor = claudeCursor(bardField(body, 'olderCursor', 'older_cursor') ?? bardField(body.update, 'olderHistoryCursor', 'older_history_cursor'));
  }
  return { updates, complete: true };
}

// Asked only after the chat API refused the chat in every organization. Each organization
// it was asked in is asked again here, in the same order, until one serves the chat.
async function readClaudeTimeline(fetchImpl, conversationId, organizations, timeoutMs) {
  const attempts = [];
  for (const organization of organizations) {
    let response;
    try {
      response = await claudeRpc(fetchImpl, 'ReadConversation', organization, { conversationId }, timeoutMs);
    } catch {
      attempts.push('ReadConversation (no response)');
      break;
    }
    if (!response.ok) {
      const code = await claudeRpcErrorCode(response);
      attempts.push(`ReadConversation (HTTP ${response.status}${code ? `, ${code}` : ''})`);
      if (response.status === 403 || response.status === 404) continue;
      break;
    }
    const body = await claudeRpcBody(response);
    const update = body?.update && typeof body.update === 'object' ? body.update : null;
    if (!update) {
      const outcome = typeof body?.outcome === 'string' && /^[A-Z_]{1,40}$/.test(body.outcome) ? `, ${body.outcome}` : '';
      attempts.push(`ReadConversation (HTTP ${response.status}, ${body ? `no conversation${outcome}` : 'unreadable response'})`);
      continue;
    }
    const history = await readClaudeHistory(fetchImpl, conversationId, organization, update, timeoutMs);
    return { raw: claudeTimelineConversation([update, ...history.updates], history.complete), attempts };
  }
  return { raw: null, attempts };
}

// Cowork sessions have been reported (not documented) to use `cse_` ids and to be absent
// from the chat API. Since the September 2026 merge they open from the same conversation
// list as chats, so the button can appear on one. Where the browser recorded what Claude's
// own page got when it asked the chat API for this chat, the message follows that instead.
function claudeNotFoundError(conversationId, { tried, retries, timeline = [], entries = null }) {
  const id = String(conversationId ?? '');
  const pageRequests = claudePageRequests(id, entries);
  const pageLoad = pageRequests.find((request) => request.loadsChat && request.status);
  const pageOrganizations = [...new Set(pageRequests.filter((request) => request.namesChat && request.organization).map((request) => request.organization))];
  const pageUsesRpc = pageRequests.some((request) => request.parsed.pathname.startsWith('/claudeai-rpc/'));
  let message;
  if (pageLoad && pageLoad.status >= 200 && pageLoad.status < 300) message = 'Claude’s page loaded this chat from the same chat API, but Claude refused every request the exporter made for it. Claude’s page sends something the exporter does not.';
  else if (pageLoad) message = `Claude’s chat API also answered ${pageLoad.status} to Claude’s own page for this chat, so the page loads it from somewhere else. Its other requests are listed below.`;
  else if (pageUsesRpc && timeline.length) message = 'Claude’s page loads this chat through Claude’s new chat service, not the chat API. The exporter asked that service too, and it did not return the chat.';
  else if (CLAUDE_UUID_RE.test(id)) message = 'Claude’s chat API has no conversation with this ID in any organization on this account. Since chat and Cowork merged, a conversation that ran as a Cowork task may be stored outside the chat API this exporter reads.';
  else if (id.startsWith('cse_')) message = 'This ID has the shape of a Cowork task (“cse_…”), and Claude’s chat API has no conversation with it. Claude stores Cowork tasks outside the chat API this exporter reads, so it cannot export them yet.';
  else message = 'This is not a regular Claude chat ID, and Claude’s chat API has no conversation with it. Since chat and Cowork merged, some conversations are stored outside the chat API this exporter reads.';
  const requests = claudeRequestShapes(id, entries);
  const query = [...new URLSearchParams(globalThis.location?.search ?? '').keys()].filter((key) => CLAUDE_QUERY_KEY_RE.test(key)).slice(0, 4);
  return new ClaudeClientError('not-found', message, {
    pagePath: `${redactClaudePath(globalThis.location?.pathname ?? '', id)}${query.length ? `?${query.join(',')}` : ''}`,
    idFormat: claudeIdFormat(id),
    organizationsTried: tried.size,
    pageOrganizationChecked: pageOrganizations.length ? pageOrganizations.every((organization) => tried.has(organization)) : null,
    retries,
    timeline,
    pageRequests: requests.naming,
    recentRequests: requests.other.slice(0, 6),
  });
}

export async function fetchClaudeConversation(conversationId, { fetchImpl = globalThis.fetch, timeoutMs = CLAUDE_TIMEOUT_MS, organizationId = getClaudeOrganizationId(), resourceEntries = null } = {}) {
  if (!conversationId) throw new ClaudeClientError('missing-id', 'Open a Claude conversation before exporting.');
  if (typeof fetchImpl !== 'function') throw new ClaudeClientError('no-fetch', 'This browser does not provide fetch().');
  if (!CLAUDE_CONVERSATION_ID_RE.test(String(conversationId))) throw new ClaudeClientError('invalid-route', 'The Claude conversation route is not recognized.');

  const tried = new Set();
  const requested = new Set();
  const request = (org, path = claudeConversationPath(org, conversationId)) => {
    tried.add(org);
    requested.add(path);
    return claudeGet(fetchImpl, path, timeoutMs);
  };
  let response = organizationId && CLAUDE_ORG_RE.test(organizationId) ? await request(organizationId) : null;
  if (!response || response.status === 403 || response.status === 404) {
    const others = (await listClaudeOrganizations(fetchImpl, timeoutMs)).filter((org) => !tried.has(org)).slice(0, MAX_FALLBACK_ORGANIZATIONS);
    let fallbackError = null;
    for (const org of others) {
      let candidate;
      try {
        candidate = await request(org);
      } catch (error) {
        fallbackError = error;
        continue;
      }
      if (candidate.ok) {
        response = candidate;
        break;
      }
      response ??= candidate;
    }
    if (!response && fallbackError) throw fallbackError;
  }
  // Still refused in every organization the account lists: ask the way Claude's own page
  // asks, at most three more times. A conversation that already exports never gets here,
  // so its request is unchanged.
  const retries = [];
  if (response?.status === 403 || response?.status === 404) {
    const fallbackOrganization = organizationId && CLAUDE_ORG_RE.test(organizationId) ? organizationId : [...tried][0];
    const candidates = [];
    for (const candidate of claudeRetryPaths(conversationId, fallbackOrganization, resourceEntries)) {
      if (candidate.path && !requested.has(candidate.path) && !candidates.some((other) => other.path === candidate.path)) candidates.push(candidate);
    }
    for (const candidate of candidates.slice(0, 3)) {
      let next;
      try {
        next = await request(candidate.organization, candidate.path);
      } catch {
        retries.push(`${candidate.label} (no response)`);
        continue;
      }
      retries.push(`${candidate.label} (HTTP ${next.status})`);
      if (next.ok) {
        response = next;
        break;
      }
    }
  }
  if (!response) throw new ClaudeClientError('missing-organization', 'Claude session information was not found. Sign in, reload the conversation, and retry.');

  if (response.status === 401 || response.status === 403) throw new ClaudeClientError('auth', `Claude rejected the conversation request (${response.status}). Sign in again, then retry.`);
  if (response.status === 404) {
    const timeline = await readClaudeTimeline(fetchImpl, conversationId, [...tried].slice(0, MAX_FALLBACK_ORGANIZATIONS + 1), timeoutMs);
    if (timeline.raw) return timeline.raw;
    throw claudeNotFoundError(conversationId, { tried, retries, timeline: timeline.attempts, entries: resourceEntries });
  }
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

// No published source shows a model on a Claude reply: a September 2026 capture of this
// response has `model` only at the top, for the whole chat, and other exporters read only
// that. A reply retried with another model may still carry one under a name nobody has
// published, so any field whose name mentions a model is read, outside the reply's own
// content, and only when its value is a Claude model identifier.
const CLAUDE_MODEL_ID_RE = /^claude[A-Za-z0-9._:-]{1,100}$/i;
const CLAUDE_CONTENT_KEYS = new Set(['content', 'text', 'attachments', 'files', 'files_v2', 'sync_sources']);

function claudeReplyModel(value, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 2) return null;
  for (const [key, field] of Object.entries(value)) {
    if (CLAUDE_CONTENT_KEYS.has(key)) continue;
    if (/model/i.test(key)) {
      const candidates = typeof field === 'string' ? [field] : [field?.id, field?.name, field?.slug, field?.model];
      const model = candidates.map((candidate) => (typeof candidate === 'string' ? candidate.trim() : '')).find((candidate) => CLAUDE_MODEL_ID_RE.test(candidate));
      if (model) return model;
    }
    const nested = claudeReplyModel(field, depth + 1);
    if (nested) return nested;
  }
  return null;
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
    modelSlug: typeof message?.model === 'string' && message.model.trim() ? message.model.trim() : (typeof message?.model_slug === 'string' && message.model_slug.trim() ? message.model_slug.trim() : (role === 'assistant' ? claudeReplyModel(message) : null)),
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
    sourceShape: raw.source_shape === 'claude-rpc-timeline' ? 'claude-rpc-timeline' : 'claude-message-tree',
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
      // Set when Claude's new chat service stopped giving older pages of the chat.
      historyIncomplete: raw.history_incomplete === true,
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
  const details = error.details ?? {};
  const lines = [error.message];
  if (details.pagePath) lines.push(`Page path: ${details.pagePath}`);
  if (details.idFormat) lines.push(`Conversation ID: ${details.idFormat}`);
  if (Number.isInteger(details.organizationsTried)) {
    const pageOrganization = details.pageOrganizationChecked === true ? ', including the one Claude’s page used' : details.pageOrganizationChecked === false ? ', not including the one Claude’s page used' : '';
    lines.push(`Organizations checked: ${details.organizationsTried}${pageOrganization}`);
  }
  if (details.retries?.length) lines.push(`Retries: ${details.retries.join(' | ')}`);
  if (details.timeline?.length) lines.push(`Claude’s new chat service: ${details.timeline.join(' | ')}`);
  if (details.pageRequests?.length) lines.push(`Claude’s page, requests naming this chat: ${details.pageRequests.join(' | ')}`);
  else if (details.pageRequests) lines.push('Claude’s page made no recorded request naming this chat.');
  if (details.recentRequests?.length) lines.push(`Claude’s page, other recent API requests: ${details.recentRequests.join(' | ')}`);
  return lines.join('\n');
}
