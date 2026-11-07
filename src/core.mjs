const ARCHIVER_VERSION = '0.18.0';
const ROLE_LABELS = {
  user: 'You',
  assistant: 'ChatGPT',
  system: 'System',
  tool: 'Tool',
};

export class ConversationShapeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ConversationShapeError';
    this.details = details;
  }
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('`', '&#96;');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function roleForMessage(message) {
  const role = message?.author?.role ?? message?.role ?? 'unknown';
  return typeof role === 'string' ? role.toLowerCase() : 'unknown';
}

function labelForRole(role) {
  return ROLE_LABELS[role] ?? (role ? role[0].toUpperCase() + role.slice(1) : 'Unknown');
}

function decodeEscapedText(value, { encodedPayload = false } = {}) {
  const text = String(value ?? '');
  if (!encodedPayload || !/\\(?:n|r|t|u[0-9a-f]{4}|["\\])/.test(text)) return text;
  try {
    const decoded = JSON.parse(`"${text}"`);
    return typeof decoded === 'string' ? decoded : text;
  } catch {
    return text;
  }
}

function stripToolLineMarkers(text) {
  return String(text ?? '').replace(/^\s*\[L\d+\]\s?/gm, '');
}

function parseStructuredToolText(text, { encodedPayload = false } = {}) {
  const raw = String(text ?? '');
  const rawCandidate = stripToolLineMarkers(raw).trim();
  if (!rawCandidate || !/^[\[{]/.test(rawCandidate)) return null;
  try {
    return JSON.parse(rawCandidate);
  } catch {
    if (!encodedPayload) return null;
    const decodedCandidate = stripToolLineMarkers(decodeEscapedText(raw, { encodedPayload: true })).trim();
    if (!decodedCandidate || decodedCandidate === rawCandidate) return null;
    try {
      return JSON.parse(decodedCandidate);
    } catch {
      return null;
    }
  }
}

const STRUCTURED_TEXT_KEYS = ['content', 'text', 'output', 'result', 'message'];

function structuredReadableEntry(value) {
  if (!isPlainObject(value)) return null;
  for (const key of STRUCTURED_TEXT_KEYS) {
    if (typeof value[key] === 'string' && value[key].trim()) return { key, text: value[key] };
  }
  return null;
}

function structuredReadableText(value) {
  return structuredReadableEntry(value)?.text ?? null;
}

function structuredRemainder(value) {
  const readable = structuredReadableEntry(value);
  if (!readable) return null;
  const remainder = Object.fromEntries(Object.entries(value).filter(([key]) => key !== readable.key));
  return Object.keys(remainder).length > 0 ? remainder : null;
}

function formatToolTranscript(text) {
  return String(text ?? '').split('\n').map((line) => {
    const marker = line.match(/^\s*\[L\d+\]\s*(.*)$/);
    if (!marker) return line;
    const payload = decodeEscapedText(marker[1], { encodedPayload: true });
    const parsed = parseStructuredToolText(payload, { encodedPayload: true });
    if (parsed === null) return payload;
    const readable = structuredReadableText(parsed);
    const remainder = structuredRemainder(parsed);
    if (readable && remainder) return `${readable}\n\n[additional structured fields]\n${JSON.stringify(remainder, null, 2)}`;
    return readable ?? JSON.stringify(parsed, null, 2);
  }).join('\n');
}

function displayTextItems(text, role, kind, language = '') {
  const rawText = String(text ?? '');
  const toolLike = ['tool', 'function', 'computer'].includes(role) || /^\s*\[L\d+\]/m.test(rawText);
  if (!toolLike) return [{ kind, text: rawText, language }];

  const parsed = parseStructuredToolText(rawText, { encodedPayload: true });
  if (parsed !== null) {
    const readable = structuredReadableText(parsed);
    if (readable !== null) {
      const blocks = [{ kind: 'text', text: readable, language: '' }];
      const remainder = structuredRemainder(parsed);
      if (remainder) blocks.push({ kind: 'code', text: JSON.stringify(remainder, null, 2), language: 'json' });
      return blocks;
    }
    return [{ kind: 'code', text: JSON.stringify(parsed, null, 2), language: 'json' }];
  }
  return [{ kind, text: formatToolTranscript(rawText), language }];
}

function imagePointerFromValue(value, depth = 0) {
  if (depth > 3 || value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!isPlainObject(value)) return null;
  for (const key of ['asset_pointer', 'assetPointer', 'image_url', 'imageUrl', 'download_url', 'downloadUrl', 'url', 'href', 'src', 'file_id', 'fileId', 'asset_pointer_link', 'watermarked_asset_pointer', 'image', 'asset']) {
    const pointer = imagePointerFromValue(value[key], depth + 1);
    if (pointer) return pointer;
  }
  return null;
}

function executionImageRecords(value, depth = 0, seen = new Set()) {
  if (depth > 4 || !isPlainObject(value) || seen.has(value)) return [];
  seen.add(value);
  const records = [];
  for (const messages of [value?.metadata?.aggregate_result?.messages, value?.aggregate_result?.messages]) {
    if (Array.isArray(messages)) records.push(...messages.filter((item) => isPlainObject(item)));
  }
  for (const key of ['metadata', 'aggregate_result', 'parts', 'content', 'messages']) {
    const nested = value[key];
    if (nested && typeof nested === 'object') {
      if (Array.isArray(nested)) for (const item of nested) records.push(...executionImageRecords(item, depth + 1, seen));
      else records.push(...executionImageRecords(nested, depth + 1, seen));
    }
  }
  return records;
}

function contentCandidates(message) {
  const content = message?.content;
  const candidates = [];
  const seen = new Set();
  const add = (candidate) => {
    let key;
    try {
      key = typeof candidate.value === 'string' ? `string:${candidate.value}` : `json:${JSON.stringify(candidate.value)}`;
    } catch {
      key = `object:${Object.prototype.toString.call(candidate.value)}`;
    }
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };
  if (typeof content === 'string') {
    add({ kind: 'text', value: content, source: 'content' });
  } else if (isPlainObject(content)) {
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const contentParts = Array.isArray(content.content) ? content.content : [];
    if (parts.length > 0) {
      for (const part of parts) add({ kind: 'part', value: part, source: 'parts' });
    } else if (contentParts.length > 0) {
      for (const part of contentParts) add({ kind: 'part', value: part, source: 'content' });
    } else if (typeof content.content === 'string') {
      add({ kind: 'text', value: content.content, source: 'content' });
    } else if (typeof content.text === 'string') {
      add({ kind: 'text', value: content.text, source: 'text' });
    }
  }
  const attachmentLists = [message?.metadata?.attachments, content?.metadata?.attachments].filter(Array.isArray);
  const attachments = [...new Set(attachmentLists.flat())];
  for (const attachment of attachments) add({ kind: 'attachment', value: attachment });

  const executionMessages = executionImageRecords(message);
  for (const executionMessage of executionMessages) {
    const executionType = String(executionMessage?.message_type ?? executionMessage?.type ?? executionMessage?.content_type ?? '').toLowerCase();
    if (!executionType.includes('image')) continue;
    const pointer = imagePointerFromValue(executionMessage);
    if (!pointer) continue;
    add({
      kind: 'part',
      value: {
        content_type: 'image_asset_pointer',
        asset_pointer: pointer,
        mime_type: executionMessage?.mime_type ?? executionMessage?.mimeType ?? '',
        width: executionMessage?.width,
        height: executionMessage?.height,
      },
      source: 'execution-output',
    });
  }
  return candidates;
}

const IMAGE_MODEL_KEYS = ['image_model', 'imageModel', 'generation_model', 'generationModel'];
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,120}$/;

function safeImageModelIdentifier(value) {
  const candidate = String(value ?? '').trim();
  return MODEL_ID_RE.test(candidate) ? candidate : null;
}

function imageModelFromValue(value, metadata = {}) {
  const candidates = [value, metadata, metadata?.dalle, metadata?.generation, value?.image_generation, value?.generation];
  for (const source of candidates) {
    if (!isPlainObject(source)) continue;
    for (const key of IMAGE_MODEL_KEYS) {
      const model = safeImageModelIdentifier(source[key]);
      if (model) return model;
    }
    const nestedModel = safeImageModelIdentifier(source.model);
    if (nestedModel && (source === metadata?.dalle || source === metadata?.generation || source === value?.image_generation || source === value?.generation)) return nestedModel;
  }
  return null;
}

export function discoverImageModelMetadata(value) {
  const metadata = isPlainObject(value?.metadata) ? value.metadata : {};
  const model = imageModelFromValue(value, metadata);
  return { found: Boolean(model), model: model ?? 'unknown / not found' };
}

function normalizePart(candidate, depth = 0) {
  const { kind: candidateKind, value } = candidate;
  if (candidateKind === 'attachment') return { kind: 'omitted', reason: 'attachment or file content' };
  if (depth > 16) return { kind: 'omitted', reason: 'nested content depth exceeded' };
  if (typeof value === 'string') return { kind: 'text', text: value };
  if (!isPlainObject(value)) return { kind: 'omitted', reason: 'non-text content part' };

  const type = String(value.content_type ?? value.type ?? value.kind ?? '').toLowerCase();
  const pointer = imagePointerFromValue(value);
  const imageShape = type.includes('image') || Object.prototype.hasOwnProperty.call(value, 'asset_pointer') || Object.prototype.hasOwnProperty.call(value, 'image_url');
  if (pointer && imageShape) {
    const metadata = isPlainObject(value.metadata) ? value.metadata : {};
    const generated = Boolean(metadata.dalle || metadata.generation || value.generated);
    return {
      kind: 'image',
      asset: {
        pointer,
        mimeType: value.mime_type ?? value.mimeType ?? '',
        sizeBytes: Number.isFinite(value.size_bytes) ? value.size_bytes : null,
        width: Number.isFinite(value.width) ? value.width : null,
        height: Number.isFinite(value.height) ? value.height : null,
        generated,
        imageModel: generated ? imageModelFromValue(value, metadata) : null,
      },
    };
  }
  const directText = [value.text, value.value, value.content].find((item) => typeof item === 'string');
  if (directText !== undefined && (type === '' || type.includes('text') || type.includes('code') || type.includes('output'))) {
    return { kind: type.includes('code') ? 'code' : 'text', text: directText, language: value.language ?? value.lang ?? '' };
  }
  if (Array.isArray(value.parts)) {
    const nested = value.parts.map((part) => normalizePart({ kind: 'part', value: part }, depth + 1));
    return { kind: 'nested', parts: nested };
  }
  return { kind: 'omitted', reason: type || 'non-text content part' };
}

function flattenPart(part, output) {
  if (part.kind === 'nested') {
    for (const nested of part.parts) flattenPart(nested, output);
    return;
  }
  output.push(part);
}

export function extractTextBlocks(message) {
  const normalized = [];
  const role = roleForMessage(message);
  const candidates = contentCandidates(message);
  for (const candidate of candidates) flattenPart(normalizePart(candidate), normalized);

  const blocks = [];
  let omittedCount = 0;
  for (const item of normalized) {
    if (item.kind === 'omitted') {
      omittedCount += 1;
      blocks.push({ type: 'omitted', reason: item.reason });
      continue;
    }
    if (item.kind === 'image') {
      blocks.push({ type: 'image', asset: item.asset });
      continue;
    }
    const text = String(item.text ?? '');
    if (!text && blocks.length === 0) continue;
    for (const display of displayTextItems(text, role, item.kind === 'code' ? 'code' : 'text', item.language || '')) {
      blocks.push({ type: display.kind, text: display.text, language: display.language || '' });
    }
  }

  if (blocks.length === 0 && candidates.length > 0) {
    return { blocks: [{ type: 'omitted', reason: 'no supported text representation' }], omittedCount: 1 };
  }
  // ChatGPT emits an uploaded image as a content part ahead of the text it was sent
  // with, so a faithful copy reads image-then-prompt. Put the person's own words first
  // and their attachments after. Assistant messages keep provider order: there the text
  // usually introduces the image that follows it.
  if (role === 'user' && blocks.some((block) => block.type === 'image') && blocks.some((block) => block.type !== 'image')) {
    const ordered = [...blocks.filter((block) => block.type !== 'image'), ...blocks.filter((block) => block.type === 'image')];
    return { blocks: ordered, omittedCount };
  }
  return { blocks, omittedCount };
}

function mappingEntries(raw) {
  if (!isPlainObject(raw?.mapping)) return [];
  return Object.entries(raw.mapping).map(([id, node]) => ({ id, ...(isPlainObject(node) ? node : {}) }));
}

function epochMilliseconds(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const numeric = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN);
  const candidate = Number.isFinite(numeric) ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric) : value;
  const time = new Date(candidate).getTime();
  return Number.isFinite(time) ? time : NaN;
}

function chooseLeaf(entries, currentNode) {
  if (currentNode && entries.some((entry) => entry.id === currentNode)) return currentNode;
  const withMessages = entries.filter((entry) => entry.message);
  const leaves = withMessages.filter((entry) => !Array.isArray(entry.children) || entry.children.length === 0);
  if (leaves.length <= 1) return (leaves[0] ?? withMessages.at(-1))?.id ?? null;
  const ranked = leaves.map((entry, index) => ({ entry, index, time: epochMilliseconds(entry.message?.create_time ?? entry.message?.createdAt ?? entry.message?.created_at) }));
  if (!ranked.some((item) => Number.isFinite(item.time))) return (leaves.at(-1) ?? withMessages.at(-1))?.id ?? null;
  ranked.sort((left, right) => (Number.isFinite(left.time) ? left.time : -Infinity) - (Number.isFinite(right.time) ? right.time : -Infinity) || left.index - right.index);
  return ranked.at(-1)?.entry.id ?? null;
}

function pathFromMapping(entries, leafId) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path = [];
  const seen = new Set();
  let cursor = leafId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node = byId.get(cursor);
    if (!node) throw new ConversationShapeError('The conversation tree references a missing parent node.', { missingNodeId: cursor });
    path.push(node);
    cursor = node.parent ?? null;
  }
  return path.reverse();
}

function branchPathsFromMapping(entries, activeLeafId) {
  const withMessages = entries.filter((entry) => entry.message);
  const leaves = withMessages.filter((entry) => !Array.isArray(entry.children) || entry.children.length === 0);
  const leafIds = leaves.map((entry) => entry.id);
  const orderedLeafIds = [activeLeafId, ...leafIds.filter((id) => id !== activeLeafId)].filter(Boolean);
  const paths = [];
  const seenPaths = new Set();
  for (const leafId of orderedLeafIds) {
    try {
      const nodes = pathFromMapping(entries, leafId);
      const key = nodes.map((node) => node.id).join('\\u0000');
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);
      paths.push(nodes);
    } catch {
      // A malformed alternate branch must not prevent the valid active branch from exporting.
    }
  }
  return paths;
}

function uniqueNormalizedMessages(messages) {
  const unique = [];
  const seen = new Set();
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    unique.push(message);
  }
  return unique;
}

export function branchTreeFromBranches(branches) {
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

export function messagesFromBranchTree(tree) {
  const messages = [];
  const visit = (node) => {
    if (!node?.message) return;
    messages.push(node.message);
    for (const child of node.children ?? []) visit(child);
  };
  for (const root of Array.isArray(tree) ? tree : []) visit(root);
  return messages;
}

function statsForBranch(nodes, messages) {
  const structuralNodeCount = nodes.filter((node) => !(Object.prototype.hasOwnProperty.call(node, 'message') && !node.message)).length;
  return {
    messageCount: messages.length,
    omittedBlockCount: messages.reduce((sum, message) => sum + message.omittedCount, 0),
    sourceNodeCount: nodes.length,
    droppedNodeCount: Math.max(0, structuralNodeCount - messages.length),
    duplicateMessageCount: Math.max(0, nodes.filter((node) => node.message).length - messages.length),
    hiddenMessageCount: messages.filter((message) => message.hidden).length,
  };
}

function arrayMessages(raw) {
  if (Array.isArray(raw?.messages)) return raw.messages.map((message, index) => ({ id: message?.id ?? `message-${index + 1}`, message }));
  if (Array.isArray(raw?.data?.messages)) return raw.data.messages.map((message, index) => ({ id: message?.id ?? `message-${index + 1}`, message }));
  return [];
}

function normalizeNode(node, index) {
  if (Object.prototype.hasOwnProperty.call(node, 'message') && !node.message) return null;
  const message = node.message ?? node;
  if (!isPlainObject(message)) return null;
  const role = roleForMessage(message);
  const extracted = extractTextBlocks(message);
  const hidden = Boolean(message.is_visually_hidden_from_conversation);
  return {
    id: String(node.id ?? message.id ?? `message-${index + 1}`),
    role,
    authorLabel: hidden ? `${labelForRole(role)} (hidden by ChatGPT)` : labelForRole(role),
    createdAt: message.create_time ?? message.createdAt ?? message.created_at ?? null,
    parentId: node.parent ?? message.parent ?? null,
    modelSlug: asNonEmptyString(message.model_slug) ?? asNonEmptyString(message.modelSlug) ?? asNonEmptyString(message.metadata?.model_slug) ?? asNonEmptyString(message.metadata?.model) ?? null,
    textBlocks: extracted.blocks,
    omittedCount: extracted.omittedCount,
    hidden,
  };
}

export function normalizeConversation(raw) {
  if (!isPlainObject(raw)) throw new ConversationShapeError('Conversation response was not a JSON object.');

  const title = asNonEmptyString(raw.title) ?? asNonEmptyString(raw.name) ?? 'ChatGPT conversation';
  const conversationId = asNonEmptyString(raw.conversation_id) ?? asNonEmptyString(raw.conversationId) ?? null;
  const model = asNonEmptyString(raw.model_slug) ?? asNonEmptyString(raw.modelSlug) ?? asNonEmptyString(raw.default_model_slug) ?? null;
  let nodes;
  let sourceShape;
  let activeBranch = true;
  let branchNodes = [];

  const entries = mappingEntries(raw);
  if (entries.length > 0) {
    const leafId = chooseLeaf(entries, raw.current_node ?? raw.currentNode);
    if (!leafId) throw new ConversationShapeError('Conversation mapping contains no usable message node.', { keys: Object.keys(raw) });
    nodes = pathFromMapping(entries, leafId);
    branchNodes = branchPathsFromMapping(entries, leafId);
    sourceShape = 'mapping-tree';
  } else {
    nodes = arrayMessages(raw);
    sourceShape = 'message-array';
    activeBranch = false;
  }

  const messages = nodes.map(normalizeNode).filter(Boolean);
  if (messages.length === 0) throw new ConversationShapeError('No message nodes with recognizable content were found.', { sourceShape, keys: Object.keys(raw) });

  const uniqueMessages = uniqueNormalizedMessages(messages);
  const branches = branchNodes.map((pathNodes, index) => {
    const branchMessages = uniqueNormalizedMessages(pathNodes.map(normalizeNode).filter(Boolean));
    return {
      index,
      leafId: pathNodes.at(-1)?.id ?? null,
      active: index === 0,
      messages: branchMessages,
      stats: statsForBranch(pathNodes, branchMessages),
    };
  });
  const branchCount = branches.length;
  const baseStats = statsForBranch(nodes, uniqueMessages);
  return {
    title,
    conversationId,
    model,
    provider: 'ChatGPT',
    sourceShape,
    activeBranch,
    activeBranchIndex: 0,
    branches: branchCount > 1 ? branches : [],
    branchTree: branchCount > 1 ? branchTreeFromBranches(branches) : [],
    messages: uniqueMessages,
    stats: { ...baseStats, branchCount },
  };
}

export function selectConversationBranch(conversation, index = 0) {
  const branches = Array.isArray(conversation?.branches) ? conversation.branches : [];
  if (branches.length === 0) return { ...conversation, activeBranchIndex: 0, messages: conversation?.messages ?? [] };
  const requested = Number.isInteger(index) ? index : 0;
  const branchIndex = Math.min(Math.max(requested, 0), branches.length - 1);
  const branch = branches[branchIndex];
  return {
    ...conversation,
    activeBranchIndex: branchIndex,
    messages: branch.messages,
    stats: { ...conversation.stats, ...branch.stats, branchCount: branches.length },
  };
}

// Emphasis only opens and closes at a word boundary and never next to a space, so
// `MAX_RETRY_COUNT`, `get_user_id()`, `2*3*4`, `x**2 + y**2` and `5 * 3 * 2` keep every
// character instead of losing their underscores and asterisks to italics.
function emphasis(text) {
  return text
    .replace(/(^|[^A-Za-z0-9_*])\*\*(?=[^\s*])([^*\n]*?[^\s*])\*\*(?![A-Za-z0-9_*])/g, '$1<strong>$2</strong>')
    .replace(/(^|[^A-Za-z0-9_])__(?=[^\s_])([^_\n]*?[^\s_])__(?![A-Za-z0-9_])/g, '$1<strong>$2</strong>')
    .replace(/(^|[^A-Za-z0-9_*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![A-Za-z0-9_*])/g, '$1<em>$2</em>')
    .replace(/(^|[^A-Za-z0-9_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![A-Za-z0-9_])/g, '$1<em>$2</em>');
}

function inlineFormatting(escapedText) {
  // Code spans are literal, so they are set aside before emphasis is matched and put
  // back afterwards. Emphasis can still wrap a whole code span.
  const spans = [];
  const guarded = escapedText
    .replace(/[\uE000\uE001]/g, (char) => `&#x${char.charCodeAt(0).toString(16).toUpperCase()};`)
    .replace(/`([^`\n]+)`/g, (match, code) => `\uE000${spans.push(code) - 1}\uE001`);
  return emphasis(guarded).replace(/\uE000(\d+)\uE001/g, (match, index) => `<code>${spans[Number(index)]}</code>`);
}

export function textToBlocks(text) {
  const lines = String(text ?? '').replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  let code = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ type: 'paragraph', html: paragraph.map((line) => inlineFormatting(escapeHtml(line))).join('<br>') });
    paragraph = [];
  };

  for (const line of lines) {
    const fence = line.match(/^\s*```\s*([^\s`]*)\s*$/);
    if (fence) {
      if (code) {
        blocks.push({ type: 'code', language: code.language, html: escapeHtml(code.lines.join('\n')) });
        code = null;
      } else {
        flushParagraph();
        code = { language: fence[1] || '', lines: [] };
      }
      continue;
    }
    if (code) {
      code.lines.push(line);
    } else if (/^\s*$/.test(line)) {
      flushParagraph();
    } else {
      paragraph.push(line);
    }
  }

  if (code) blocks.push({ type: 'code', language: code.language, html: escapeHtml(code.lines.join('\n')) });
  flushParagraph();
  if (blocks.length === 0) blocks.push({ type: 'paragraph', html: '' });
  return blocks;
}

function formatThinkingDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '';
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return ` for ${seconds}s`;
  return ` for ${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function toolLabel(block) {
  const name = String(block.toolName ?? '').trim();
  const integration = String(block.integration ?? '').trim();
  if (integration && name) return `${integration} · ${name}`;
  return integration || name || 'tool';
}

// Thinking and tool blocks are collapsed by default: they are supporting detail, and an
// agentic conversation carries more of them than answers. <details> needs no script, so
// they still open in a file viewed with JavaScript disabled.
function renderThinkingBlock(block) {
  const summaries = Array.isArray(block.summaries) ? block.summaries.filter((line) => String(line ?? '').trim()) : [];
  const text = String(block.text ?? '').trim();
  const label = `Thought${formatThinkingDuration(block.durationMs)}`;
  const truncated = block.truncated ? '<p class="thinking-note">Claude stopped this reasoning early.</p>' : '';
  // Claude's server sends an empty `thinking` string with `thinking_hidden: true`, so
  // saying the export omitted it would be wrong: it was never sent.
  const body = text
    ? `<div class="thinking-text" dir="auto">${textToBlocks(text).map((part) => (part.type === 'code' ? `<pre class="code-block"><code>${part.html}</code></pre>` : `<p>${part.html}</p>`)).join('')}</div>`
    : summaries.length
      ? `<ul class="thinking-steps">${summaries.map((line) => `<li dir="auto">${escapeHtml(line)}</li>`).join('')}</ul>`
      : '<p class="thinking-note">Claude did not send the reasoning for this step.</p>';
  const withheld = text || !block.withheldByProvider ? '' : '<p class="thinking-note">Full reasoning text is not provided by Claude; these are its own summary lines.</p>';
  return `<details class="thinking-block"><summary>${escapeHtml(label)}</summary>${body}${withheld}${truncated}</details>`;
}

function renderToolUseBlock(block) {
  const input = block.input && typeof block.input === 'object'
    ? `<pre class="tool-input"><code>${escapeHtml(safeJson(block.input))}</code></pre>`
    : '<p class="thinking-note">No input recorded.</p>';
  const status = String(block.status ?? '').trim();
  return `<div class="tool-block"><p class="tool-head"><span class="tool-tag">Tool</span> ${escapeHtml(toolLabel(block))}${status ? ` · ${escapeHtml(status)}` : ''}</p>${input}</div>`;
}

function renderToolResultBlock(block) {
  const text = String(block.text ?? '').trim();
  const label = `${block.isError ? 'Tool error' : 'Tool result'} · ${toolLabel(block)}${formatThinkingDuration(block.durationMs)}`;
  const body = text
    ? `<pre class="tool-output"><code>${escapeHtml(text)}</code></pre>`
    : '<p class="thinking-note">No output recorded.</p>';
  return `<details class="tool-block${block.isError ? ' tool-error' : ''}"><summary>${escapeHtml(label)}</summary>${body}</details>`;
}

// JSON.stringify throws on a cycle, and a tool input is provider data rather than ours.
function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '[input could not be serialized]';
  }
}

const THINKING_BLOCK_TYPES = new Set(['thinking', 'tool_use', 'tool_result']);

function renderBlock(block, includeMessageModels = true, includeThinking = false) {
  if (THINKING_BLOCK_TYPES.has(block.type)) {
    if (!includeThinking) return '';
    if (block.type === 'thinking') return renderThinkingBlock(block);
    if (block.type === 'tool_use') return renderToolUseBlock(block);
    return renderToolResultBlock(block);
  }
  if (block.type === 'omitted') return `<p class="omitted">[non-text content omitted: ${escapeHtml(block.reason)}]</p>`;
  if (block.type === 'image') {
    const asset = block.asset ?? {};
    if (asset.status === 'excluded') return '<p class="omitted">[image excluded by export settings]</p>';
    if (asset.status === 'embedded' && typeof asset.dataUrl === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(asset.dataUrl)) {
      const dimensions = Number.isFinite(asset.width) && Number.isFinite(asset.height) ? ` width="${escapeAttribute(String(Math.min(asset.width, 10000)))}" height="${escapeAttribute(String(Math.min(asset.height, 10000)))}"` : '';
      const label = asset.generated ? 'Generated image' : 'Uploaded/reference image';
      const modelLabel = asset.generated && includeMessageModels ? ` · Image model: ${escapeHtml(asset.imageModel || 'unknown / not found')}` : '';
      const size = Number.isFinite(asset.byteLength) ? ` · ${Math.round(asset.byteLength / 1024)} KB embedded` : '';
      return `<figure class="image-block"><img src="${escapeAttribute(asset.dataUrl)}" alt="${label}"${dimensions} loading="lazy"><figcaption>${label}${modelLabel}${size}</figcaption></figure>`;
    }
    return `<p class="omitted">[image unavailable: ${escapeHtml(asset.reason || 'asset expired or inaccessible')}]</p>`;
  }
  if (block.type === 'code') {
    const language = block.language ? ` data-language="${escapeAttribute(block.language)}"` : '';
    return `<pre class="code-block"${language}><code>${escapeHtml(block.text ?? '')}</code></pre>`;
  }
  return textToBlocks(block.text ?? '').map((part) => {
    if (part.type === 'code') {
      const language = part.language ? ` data-language="${escapeAttribute(part.language)}"` : '';
      return `<pre class="code-block"${language}><code>${part.html}</code></pre>`;
    }
    return `<p>${part.html}</p>`;
  }).join('');
}

function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN);
  const candidate = Number.isFinite(numeric) ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric) : value;
  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTimestamp(value) {
  return toDate(value)?.toLocaleString() ?? '';
}

function timestampIso(value) {
  return toDate(value)?.toISOString() ?? '';
}

function messagePlainText(message) {
  return (message.textBlocks ?? []).filter((block) => block.type === 'text' || block.type === 'code').map((block) => block.text ?? '').join('\n');
}

function roleCounts(messages, provider = 'ChatGPT') {
  const counts = new Map();
  for (const message of messages) counts.set(message.role, (counts.get(message.role) ?? 0) + 1);
  return [...counts.entries()].map(([role, count]) => `${count} ${role === 'assistant' ? provider : (ROLE_LABELS[role] ?? role)}`).join(', ');
}

// The token estimate is rounded to three significant figures (exact below 1,000): its
// last digits would claim more precision than an estimate has.
export function formatTokenEstimate(count) {
  const value = Math.max(0, Math.round(Number(count) || 0));
  if (value < 1000) return value.toLocaleString('en-US');
  const step = 10 ** (String(value).length - 3);
  return (Math.round(value / step) * step).toLocaleString('en-US');
}

const TOKEN_ESTIMATE_NOTE = 'Estimated in your browser for the tokenizer ChatGPT models have used since GPT-4o. It counts the exported text only: hidden reasoning, system instructions and uploaded files are not included.';

function formatLocalStats(stats) {
  if (!Number.isFinite(stats?.wordCount) || !Number.isFinite(stats?.characterCount)) return '';
  const words = Number(stats.wordCount).toLocaleString('en-US');
  const characters = Number(stats.characterCount).toLocaleString('en-US');
  const blocks = Number.isFinite(stats.textBlockCount) ? ` · ${Number(stats.textBlockCount).toLocaleString('en-US')} text blocks` : '';
  const tokens = Number.isFinite(stats.estimatedTokens) ? ` · <span title="${escapeAttribute(TOKEN_ESTIMATE_NOTE)}">about ${formatTokenEstimate(stats.estimatedTokens)} tokens (local estimate)</span>` : '';
  return `<p class="meta">Safe local stats: ${words} words · ${characters} characters${blocks}${tokens}. Counted from exported text only; provider token and context-window usage are not included.</p>`;
}

function safeModelLabel(value) {
  const model = String(value ?? '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(model) ? model : null;
}

function formatModels(conversation) {
  const models = Array.isArray(conversation?.stats?.modelsUsed) ? conversation.stats.modelsUsed.map(safeModelLabel).filter(Boolean) : [];
  if (models.length === 0) {
    const model = safeModelLabel(conversation?.model);
    if (model) models.push(model);
  }
  if (models.length === 0) return '';
  const uniqueModels = [...new Set(models)];
  // With no model on any reply, the one name left is the conversation's own model field.
  // A bare "Model:" read as the model of every reply: in the owner's test, a Claude chat
  // retried with Haiku, Sonnet and then Opus 5.5 named only Opus 5.5 there.
  const stats = conversation?.stats ?? {};
  if (conversation?.provider === 'Claude' && uniqueModels.length === 1 && stats.replyModelCount === 0 && stats.assistantMessageCount > 0) {
    return `<p class="meta" data-copy-meta>Chat model: ${escapeHtml(uniqueModels[0])} (Claude’s data names no model for individual replies)</p>`;
  }
  const label = uniqueModels.length === 1 ? 'Model' : 'Models used';
  return `<p class="meta" data-copy-meta>${label}: ${escapeHtml(uniqueModels.join(', '))}</p>`;
}

function messageModelLine(message, includeMessageModels) {
  if (!includeMessageModels || message.role !== 'assistant') return '';
  const model = safeModelLabel(message.modelSlug) ?? 'unknown / not found';
  return `<span class="msg-model">Model: ${escapeHtml(model)}</span>`;
}

function railLabel(text) {
  const flat = String(text ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > 72 ? `${flat.slice(0, 71)}…` : (flat || 'Untitled prompt');
}

// Copy chat (v0.17.0). The copied text is Markdown, which is what the chats were written
// in, and it goes on the clipboard twice: as plain text, and as HTML built from that
// Markdown. Rich-text apps (Google Docs, Word, Notion) read the HTML; Obsidian turns the
// HTML back into Markdown by default and takes the plain text with Ctrl/Cmd+Shift+V.
// Either way headings, lists, tables and code keep their structure.
//
// These two functions run inside the exported file. They are serialized into it with
// toString(), so they must not use anything else in this module. This one is pure, so the
// tests call it directly. Everything is escaped: nothing in a chat becomes live HTML.
export function copyMarkdownToHtml(markdown) {
  var MAX_DEPTH = 12;
  var FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
  var HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
  var RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  var QUOTE = /^ {0,3}> ?/;
  var LIST = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|[ \t]*$)/;
  var DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
  var BLANK = /^[ \t]*$/;

  function esc(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function safeHref(url) {
    var value = String(url || '').trim();
    return /^(?:https?:|mailto:)/i.test(value) ? value : '';
  }
  function link(href, html) {
    return '<a href="' + esc(href) + '">' + html + '</a>';
  }
  // Code spans, links and escapes are set aside as numbered tokens (private-use
  // characters) so emphasis cannot reach into them, then put back at the end. A link's
  // label can hold tokens of its own, so they share one list and are put back in passes.
  function inline(text, depth) {
    var slots = [];
    var html = inlineTokens(String(text).replace(/[]/g, ''), depth, slots);
    for (var pass = 0; pass < 8 && /\d+/.test(html); pass++) {
      html = html.replace(/(\d+)/g, function (match, index) { return slots[Number(index)]; });
    }
    return html;
  }
  function inlineTokens(text, depth, slots) {
    var keep = function (html) { slots.push(html); return '' + (slots.length - 1) + ''; };
    var out = text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, function (match, ticks, code) {
      var body = /^ [\s\S]* $/.test(code) && /[^ ]/.test(code) ? code.slice(1, -1) : code;
      return keep('<code>' + esc(body) + '</code>');
    });
    out = out.replace(/\\([!-\/:-@\[-`{-~])/g, function (match, character) { return keep(esc(character)); });
    // An image keeps only its description: the copy is text.
    out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, function (match, alt) { return alt ? keep(esc(alt)) : ''; });
    out = out.replace(/\[([^\]]+)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g, function (match, label, url) {
      var href = safeHref(url);
      var html = depth < MAX_DEPTH ? inlineTokens(label, depth + 1, slots) : esc(label);
      return keep(href ? link(href, html) : html);
    });
    out = out.replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/gi, function (match, url) { return keep(link(url, esc(url))); });
    // A bare address ends before trailing punctuation, and before a ")" it did not open,
    // so "(see https://x.org/a)" and "https://x.org/a_(b)" both come out right.
    out = out.replace(/\bhttps?:\/\/[^\s<>"']+/gi, function (match) {
      var url = match;
      for (;;) {
        var last = url.slice(-1);
        if (/[.,:;!?*_~\]}'"]/.test(last)) url = url.slice(0, -1);
        else if (last === ')' && url.split(')').length > url.split('(').length) url = url.slice(0, -1);
        else break;
      }
      return keep(link(url, esc(url))) + match.slice(url.length);
    });
    return esc(out)
      .replace(/(^|[^A-Za-z0-9_*])\*\*(?=[^\s*])([^*\n]*?[^\s*])\*\*(?![A-Za-z0-9_*])/g, '$1<strong>$2</strong>')
      .replace(/(^|[^A-Za-z0-9_])__(?=[^\s_])([^_\n]*?[^\s_])__(?![A-Za-z0-9_])/g, '$1<strong>$2</strong>')
      .replace(/(^|[^A-Za-z0-9_*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![A-Za-z0-9_*])/g, '$1<em>$2</em>')
      .replace(/(^|[^A-Za-z0-9_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![A-Za-z0-9_])/g, '$1<em>$2</em>')
      .replace(/~~(?=\S)([^~\n]*?\S)~~/g, '<del>$1</del>')
      .replace(/\n/g, '<br>');
  }
  function indentOf(line) {
    return line.match(/^ */)[0].length;
  }
  function splitRow(line) {
    var row = line.trim();
    if (row.charAt(0) === '|') row = row.slice(1);
    if (row.slice(-1) === '|' && row.slice(-2) !== '\\|') row = row.slice(0, -1);
    var cells = [];
    var cell = '';
    for (var k = 0; k < row.length; k++) {
      if (row.charAt(k) === '\\' && row.charAt(k + 1) === '|') { cell += '\\|'; k++; continue; }
      if (row.charAt(k) === '|') { cells.push(cell.trim()); cell = ''; continue; }
      cell += row.charAt(k);
    }
    cells.push(cell.trim());
    return cells;
  }
  function isTableStart(src, i) {
    return i + 1 < src.length && src[i].indexOf('|') >= 0 && DELIMITER.test(src[i + 1]) && splitRow(src[i]).length === splitRow(src[i + 1]).length;
  }
  function startsBlock(src, i) {
    var line = src[i];
    var item = line.match(LIST);
    return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || Boolean(item && item[3] && item[3].trim()) || isTableStart(src, i);
  }
  function table(src, i, depth) {
    var head = splitRow(src[i]);
    var align = splitRow(src[i + 1]).map(function (cell) {
      var left = cell.charAt(0) === ':';
      var right = cell.slice(-1) === ':';
      return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
    });
    var cellHtml = function (tag, text, index) {
      var style = align[index] ? ' style="text-align:' + align[index] + '"' : '';
      return '<' + tag + style + '>' + inline(text || '', depth) + '</' + tag + '>';
    };
    var html = '<table><thead><tr>' + head.map(function (text, index) { return cellHtml('th', text, index); }).join('') + '</tr></thead><tbody>';
    i += 2;
    while (i < src.length && !BLANK.test(src[i]) && src[i].indexOf('|') >= 0) {
      var cells = splitRow(src[i]);
      html += '<tr>' + head.map(function (unused, index) { return cellHtml('td', cells[index], index); }).join('') + '</tr>';
      i++;
    }
    return { html: html + '</tbody></table>', next: i };
  }
  function list(src, i, depth) {
    var first = src[i].match(LIST);
    var ordered = /\d/.test(first[2]);
    var base = first[1].length;
    var start = ordered ? parseInt(first[2], 10) : 1;
    var items = [];
    var loose = false;
    while (i < src.length) {
      var marker = src[i].match(LIST);
      if (!marker || RULE.test(src[i]) || /\d/.test(marker[2]) !== ordered || marker[1].length > base + 3) break;
      var contentIndent = marker[1].length + marker[2].length + 1;
      var lines = [marker[3] || ''];
      i++;
      while (i < src.length) {
        var line = src[i];
        if (BLANK.test(line)) {
          var after = i + 1;
          while (after < src.length && BLANK.test(src[after])) after++;
          if (after < src.length && indentOf(src[after]) > base) {
            for (; i < after; i++) lines.push('');
            loose = true;
            continue;
          }
          break;
        }
        var indent = indentOf(line);
        if (indent > base) { lines.push(line.slice(Math.min(indent, contentIndent))); i++; continue; }
        if (LIST.test(line) || startsBlock(src, i)) break;
        lines.push(line);
        i++;
      }
      items.push(lines);
      var next = i;
      while (next < src.length && BLANK.test(src[next])) next++;
      var sibling = next < src.length ? src[next].match(LIST) : null;
      if (next > i && sibling && !RULE.test(src[next]) && /\d/.test(sibling[2]) === ordered && sibling[1].length <= base + 3) { loose = true; i = next; }
    }
    var tag = ordered ? 'ol' : 'ul';
    var html = '<' + tag + (ordered && start !== 1 ? ' start="' + start + '"' : '') + '>' + items.map(function (lines) {
      var task = lines[0].match(/^\[([ xX])\][ \t]+/);
      var box = '';
      if (task) {
        box = '<input type="checkbox" disabled' + (task[1] === ' ' ? '' : ' checked') + '> ';
        lines = [lines[0].slice(task[0].length)].concat(lines.slice(1));
      }
      return '<li>' + box + blocks(lines, !loose, depth + 1) + '</li>';
    }).join('') + '</' + tag + '>';
    return { html: html, next: i };
  }
  function blocks(src, tight, depth) {
    if (depth > MAX_DEPTH) return '<p>' + esc(src.join('\n')).replace(/\n/g, '<br>') + '</p>';
    var out = [];
    var i = 0;
    while (i < src.length) {
      var line = src[i];
      var match;
      if (BLANK.test(line)) { i++; continue; }
      if ((match = line.match(FENCE))) {
        var fence = match[1];
        var close = new RegExp('^ {0,3}' + (fence.charAt(0) === '`' ? '`' : '~') + '{' + fence.length + ',}[ \\t]*$');
        var body = [];
        for (i++; i < src.length && !close.test(src[i]); i++) body.push(src[i]);
        i++;
        out.push('<pre><code' + (match[2] ? ' class="language-' + esc(match[2]) + '"' : '') + '>' + esc(body.join('\n')) + '</code></pre>');
        continue;
      }
      if ((match = line.match(HEADING))) {
        var level = match[1].length;
        out.push('<h' + level + '>' + inline(match[2] || '', depth) + '</h' + level + '>');
        i++;
        continue;
      }
      if (RULE.test(line)) { out.push('<hr>'); i++; continue; }
      if (QUOTE.test(line)) {
        var quoted = [];
        while (i < src.length && QUOTE.test(src[i])) quoted.push(src[i++].replace(QUOTE, ''));
        out.push('<blockquote>' + blocks(quoted, false, depth + 1) + '</blockquote>');
        continue;
      }
      if (isTableStart(src, i)) {
        var parsedTable = table(src, i, depth);
        out.push(parsedTable.html);
        i = parsedTable.next;
        continue;
      }
      if (LIST.test(line)) {
        var parsedList = list(src, i, depth);
        out.push(parsedList.html);
        i = parsedList.next;
        continue;
      }
      var paragraph = [line.trim()];
      for (i++; i < src.length && !BLANK.test(src[i]) && !startsBlock(src, i); i++) paragraph.push(src[i].trim());
      var html = inline(paragraph.join('\n'), depth);
      out.push(tight ? html : '<p>' + html + '</p>');
    }
    return out.join('');
  }
  var source = String(markdown || '').replace(/\r\n?/g, '\n').split('\n').map(function (line) {
    return line.replace(/^[ \t]+/, function (lead) { return lead.replace(/\t/g, '    '); });
  });
  return blocks(source, false, 0);
}

// The exported file's copy buttons. It rebuilds each message's Markdown from the page:
// the export keeps the chat's own lines (headings, list markers, table rows) as text and
// turns only bold, italics, inline code and code blocks into tags, so those are turned
// back. Choices are kept in this browser's storage, like the theme.
function exportCopyRuntime(markdownToHtml) {
  var STORE = 'chatgpt-thread-archiver-copy-options';
  var DEFAULTS = { speakers: true, thinking: false, tools: false, times: false, models: false, title: true, details: false, placeholders: false, hidden: false };
  var options = {};
  var name;
  for (name in DEFAULTS) options[name] = DEFAULTS[name];
  try {
    var saved = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (saved && typeof saved === 'object') for (name in DEFAULTS) if (typeof saved[name] === 'boolean') options[name] = saved[name];
  } catch (error) {}
  var bar = document.getElementById('copy-bar');

  // A choice whose content is not in this file is shown greyed out and counts as off.
  function on(option) {
    var box = bar && bar.querySelector('[data-copy-opt="' + option + '"]');
    return options[option] === true && !(box && box.disabled);
  }
  function repeat(text, count) {
    return new Array(count + 1).join(text);
  }
  function longestRun(text, character) {
    var runs = text.match(new RegExp('\\' + character + '+', 'g')) || [];
    var longest = 0;
    for (var r = 0; r < runs.length; r++) longest = Math.max(longest, runs[r].length);
    return longest;
  }
  function fence(text, language) {
    var ticks = repeat('`', Math.max(3, longestRun(text, '`') + 1));
    return ticks + (language || '') + '\n' + text.replace(/\n+$/, '') + '\n' + ticks;
  }
  function codeSpan(text) {
    var ticks = repeat('`', longestRun(text, '`') + 1);
    var pad = /^`|`$/.test(text) ? ' ' : '';
    return ticks + pad + text + pad + ticks;
  }
  function inlineMarkdown(node) {
    var out = '';
    for (var child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) { out += child.nodeValue; continue; }
      if (child.nodeType !== 1) continue;
      var tag = child.tagName;
      if (tag === 'BR') out += '\n';
      else if (tag === 'STRONG' || tag === 'B') out += '**' + inlineMarkdown(child) + '**';
      else if (tag === 'EM' || tag === 'I') out += '*' + inlineMarkdown(child) + '*';
      else if (tag === 'CODE') out += codeSpan(child.textContent);
      else if (tag === 'A') {
        var href = child.getAttribute('href') || '';
        var label = inlineMarkdown(child);
        out += !href ? label : href === label ? '<' + href + '>' : '[' + label + '](' + href + ')';
      } else out += inlineMarkdown(child);
    }
    return out;
  }
  function note(text) {
    return '*' + String(text).trim() + '*';
  }
  function quote(markdown) {
    return markdown.split('\n').map(function (line) { return line ? '> ' + line : '>'; }).join('\n');
  }
  function thinkingMarkdown(block) {
    var summary = block.querySelector(':scope > summary');
    var parts = ['**' + (summary ? summary.textContent.trim() : 'Thinking') + '**'];
    for (var child = summary ? summary.nextElementSibling : block.firstElementChild; child; child = child.nextElementSibling) {
      if (child.tagName === 'UL') {
        var steps = child.querySelectorAll('li');
        var lines = [];
        for (var s = 0; s < steps.length; s++) lines.push('- ' + steps[s].textContent.trim());
        parts.push(lines.join('\n'));
      } else if (child.classList.contains('thinking-text')) {
        for (var t = child.firstElementChild; t; t = t.nextElementSibling) parts.push(t.tagName === 'PRE' ? fence(t.textContent, '') : inlineMarkdown(t));
      } else if (child.classList.contains('thinking-note')) parts.push(note(child.textContent));
    }
    return quote(parts.join('\n\n'));
  }
  function toolMarkdown(block) {
    var head = block.querySelector(':scope > .tool-head');
    var summary = block.querySelector(':scope > summary');
    var title;
    if (head) {
      var tag = head.querySelector('.tool-tag');
      title = '**Tool call:** ' + head.textContent.slice(tag ? tag.textContent.length : 0).trim();
    } else title = '**' + (summary ? summary.textContent.trim() : 'Tool') + '**';
    var parts = [title];
    var pre = block.querySelector('pre');
    var empty = block.querySelector('.thinking-note');
    if (pre) parts.push(fence(pre.textContent, pre.classList.contains('tool-input') ? 'json' : ''));
    else if (empty) parts.push(note(empty.textContent));
    return parts.join('\n\n');
  }
  function blockMarkdown(block) {
    var tag = block.tagName;
    var classes = block.classList;
    if (classes.contains('thinking-block')) return on('thinking') ? thinkingMarkdown(block) : '';
    if (classes.contains('tool-block')) return on('tools') ? toolMarkdown(block) : '';
    if (tag === 'FIGURE') {
      var image = block.querySelector('img');
      return on('placeholders') ? note('[' + ((image && image.getAttribute('alt')) || 'Image') + ' not copied]') : '';
    }
    if (classes.contains('omitted') || classes.contains('empty-message')) return on('placeholders') ? note(block.textContent) : '';
    if (tag === 'PRE') return fence((block.querySelector('code') || block).textContent, block.getAttribute('data-language') || '');
    if (tag === 'P') return inlineMarkdown(block);
    return block.textContent.trim();
  }
  function messageHeader(article) {
    var heading = article.querySelector('.message-header h2');
    if (!heading) return '';
    var speaker = '';
    for (var child = heading.firstChild; child; child = child.nextSibling) if (child.nodeType === 3) speaker += child.nodeValue;
    var bits = [];
    if (on('speakers') && speaker.trim()) bits.push('**' + speaker.trim() + '**');
    var model = heading.querySelector('.msg-model');
    var modelName = model ? model.textContent.replace(/^Model:\s*/, '').trim() : '';
    if (on('models') && modelName && modelName !== 'unknown / not found') bits.push(modelName);
    var time = heading.querySelector('time');
    if (on('times') && time) bits.push(time.textContent.trim());
    return bits.join(' · ');
  }
  // The message's text, without its header; empty when every block was left out.
  function messageBody(article) {
    var content = article.querySelector('.content');
    var parts = [];
    for (var block = content ? content.firstElementChild : null; block; block = block.nextElementSibling) {
      var markdown = blockMarkdown(block);
      if (markdown && markdown.trim()) parts.push(markdown);
    }
    return parts.join('\n\n');
  }
  // What is on screen: one version of each fork, as the reader has set them.
  function shownMessages() {
    var all = document.querySelectorAll('article.message');
    var shown = [];
    for (var m = 0; m < all.length; m++) {
      var article = all[m];
      if (article.parentNode && article.parentNode.closest && article.parentNode.closest('[hidden]')) continue;
      if (article.classList.contains('message-hidden') && !on('hidden')) continue;
      if (article.classList.contains('message-tool') && !on('tools')) continue;
      shown.push(article);
    }
    return shown;
  }
  function chatMarkdown() {
    var parts = [];
    var title = document.querySelector('.export-head h1');
    if (on('title') && title && title.textContent.trim()) parts.push('# ' + title.textContent.trim());
    if (on('details')) {
      var details = document.querySelectorAll('.export-head [data-copy-meta]');
      var lines = [];
      for (var d = 0; d < details.length; d++) lines.push('- ' + inlineMarkdown(details[d]).trim());
      if (lines.length) parts.push(lines.join('\n'));
    }
    var messages = shownMessages();
    var chunks = [];
    for (var m = 0; m < messages.length; m++) {
      var body = messageBody(messages[m]);
      if (!body) continue;
      var header = messageHeader(messages[m]);
      chunks.push(header ? header + '\n\n' + body : body);
    }
    if (chunks.length) parts.push(chunks.join('\n\n---\n\n'));
    return { markdown: parts.join('\n\n') + '\n', count: chunks.length };
  }

  // The copy event is the one path that puts both formats on the clipboard in every
  // browser, file:// pages included. It needs a selection to fire in some browsers,
  // hence the throwaway text area. The Clipboard API is the fallback, then plain text.
  function writeClipboard(markdown, done, fail) {
    var html = '<meta charset="utf-8">' + markdownToHtml(markdown);
    var handled = false;
    var onCopy = function (event) {
      if (!event.clipboardData) return;
      event.clipboardData.setData('text/plain', markdown);
      event.clipboardData.setData('text/html', html);
      event.preventDefault();
      handled = true;
    };
    var focused = document.activeElement;
    var holder = document.createElement('textarea');
    holder.value = ' ';
    holder.setAttribute('readonly', '');
    holder.setAttribute('aria-hidden', 'true');
    holder.tabIndex = -1;
    holder.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(holder);
    holder.select();
    document.addEventListener('copy', onCopy, true);
    var copied = false;
    try { copied = document.execCommand('copy'); } catch (error) { copied = false; }
    document.removeEventListener('copy', onCopy, true);
    holder.remove();
    if (focused && focused.focus) { try { focused.focus({ preventScroll: true }); } catch (error) {} }
    if (copied && handled) { done(false); return; }
    var plainOnly = function () {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(markdown).then(function () { done(true); }, fail);
      else fail();
    };
    if (navigator.clipboard && navigator.clipboard.write && window.ClipboardItem) {
      try {
        navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([markdown], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]).then(function () { done(false); }, plainOnly);
        return;
      } catch (error) {}
    }
    plainOnly();
  }
  function flash(button, text) {
    var label = button.querySelector('[data-copy-label]') || button;
    if (!button.hasAttribute('data-idle-label')) button.setAttribute('data-idle-label', label.textContent);
    label.textContent = text;
    clearTimeout(button.copyTimer);
    button.copyTimer = setTimeout(function () { label.textContent = button.getAttribute('data-idle-label'); }, 1800);
  }

  document.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('.copy-btn') : null;
    if (!button) return;
    var article = button.closest('article.message');
    var markdown = article ? messageBody(article) : '';
    if (!markdown) { flash(button, 'Nothing to copy'); return; }
    writeClipboard(markdown + '\n', function () { flash(button, 'Copied'); }, function () { flash(button, 'Copy failed'); });
  });

  if (!bar) return;
  var main = document.getElementById('copy-chat');
  var toggle = document.getElementById('copy-options-toggle');
  var panel = document.getElementById('copy-options');
  var status = document.getElementById('copy-status');
  var statusTimer = 0;
  var boxes = panel ? panel.querySelectorAll('[data-copy-opt]') : [];
  function say(text) {
    if (!status) return;
    status.textContent = text;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { status.textContent = ''; }, 6000);
  }
  for (var b = 0; b < boxes.length; b++) (function (box) {
    var option = box.getAttribute('data-copy-opt');
    if (!box.disabled) box.checked = options[option] === true;
    box.addEventListener('change', function () {
      options[option] = box.checked;
      try { localStorage.setItem(STORE, JSON.stringify(options)); } catch (error) {}
    });
  })(boxes[b]);
  function setOpen(open) {
    if (!panel || !toggle) return;
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  if (toggle) toggle.addEventListener('click', function () { setOpen(panel.hidden); });
  document.addEventListener('click', function (event) {
    if (panel && !panel.hidden && !bar.contains(event.target)) setOpen(false);
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && panel && !panel.hidden) {
      setOpen(false);
      if (toggle) toggle.focus();
    }
  });
  if (main) main.addEventListener('click', function () {
    var result = chatMarkdown();
    setOpen(false);
    if (!result.count) {
      flash(main, 'Nothing to copy');
      say('Every message is left out by the copy options.');
      return;
    }
    var counted = result.count + ' message' + (result.count === 1 ? '' : 's');
    writeClipboard(result.markdown, function (plainOnly) {
      flash(main, 'Copied');
      say(plainOnly ? 'Copied ' + counted + ' as Markdown text. This browser allowed only plain text.' : 'Copied ' + counted + '. Paste it into any app.');
    }, function () {
      flash(main, 'Copy failed');
      say('The browser blocked the clipboard. Try again, or select the text and copy it.');
    });
  });
}

const EXPORT_COPY_JS = `(${exportCopyRuntime.toString()})(${copyMarkdownToHtml.toString()});`;

const EXPORT_CSS = `
:root { color-scheme: light; --bg: #f9f9f9; --surface: #fff; --text: #24292f; --muted: #57606a; --border: #e0e0e0; --user: #eef2ff; --assistant: #fff; --accent: #10a37f; --link: #0969da; --code-bg: #1f2328; --code-text: #e6edf3; --shadow: rgb(0 0 0 / .05); --btn: #0b7a5e; --btn-hover: #09664f; --btn-text: #fff; --btn-divider: rgb(255 255 255 / .35); }
	html.dark { color-scheme: dark; --bg: #0f1115; --surface: #171a21; --text: #e6edf3; --muted: #9aa4b2; --border: #303744; --user: #25213d; --assistant: #171a21; --accent: #35c89e; --link: #7ab7ff; --code-bg: #090c11; --code-text: #e6edf3; --shadow: rgb(0 0 0 / .3); --btn: #35c89e; --btn-hover: #5ad4b0; --btn-text: #06231a; --btn-divider: rgb(6 35 26 / .3); }
	* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--text); font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.wrap { max-width: 820px; margin: 0 auto; }
header.export-head { margin-bottom: 24px; }
.export-head h1 { font-size: 1.5em; margin: 0 0 6px; word-wrap: break-word; }
.meta { color: var(--muted); font-size: .85em; margin: 0 0 4px; }
.meta a { color: var(--link); }
.flag-ok { color: #1a7f37; font-weight: 600; }
.flag-warn { color: #9a6700; font-weight: 600; }
.warn-box { border: 1px solid #d4a72c; background: #fff8c5; color: #633c01; border-radius: 6px; padding: 10px 14px; margin: 12px 0; font-size: .9em; }
	html.dark .warn-box { border-color: #9e7a1a; background: #3a2f13; color: #ffdf82; }
.message { background: var(--assistant); border: 1px solid var(--border); border-radius: 8px; padding: 15px 18px; margin-bottom: 20px; position: relative; box-shadow: 0 2px 4px var(--shadow); scroll-margin-top: 16px; }
	.message.user { background: var(--user); border-color: #d1d8ff; }
	html.dark .message.user { border-color: #514c80; }
.message:target { outline: 2px solid var(--accent); outline-offset: 2px; }
.message h2 { margin: 0; font-size: .95em; color: var(--muted); font-weight: 600; letter-spacing: .02em; }
.msg-model { display: inline-block; margin-left: 8px; font-size: .88em; font-weight: 400; letter-spacing: 0; color: #8b949e; }
.msg-time { font-weight: 400; letter-spacing: 0; color: #8b949e; margin-left: 8px; font-size: .92em; }
.content { overflow-wrap: anywhere; margin-top: 10px; }
.content a { color: var(--link); }
.content p { margin: 0 0 12px; }
.content p:last-child { margin-bottom: 0; }
.content code { background: rgb(175 184 193 / .2); padding: .15em .35em; border-radius: 4px; font-size: .9em; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.thinking-block, .tool-block { margin: 12px 0; border: 1px solid var(--border); border-left: 3px solid var(--muted); border-radius: 6px; background: var(--surface); padding: 8px 12px; }
.thinking-block > summary, .tool-block > summary { cursor: pointer; color: var(--muted); font-size: .9em; }
.thinking-block[open] > summary, .tool-block[open] > summary { margin-bottom: 8px; }
.thinking-steps { margin: 0; padding-left: 20px; color: var(--muted); font-size: .92em; }
.thinking-steps li { margin: 3px 0; }
.thinking-text p { margin: 6px 0; color: var(--muted); }
.thinking-note { margin: 6px 0 0; color: var(--muted); font-size: .85em; font-style: italic; }
.tool-head { margin: 0 0 6px; font-size: .9em; color: var(--muted); }
.tool-tag { display: inline-block; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border); font-size: .82em; }
.tool-input, .tool-output { max-height: 320px; overflow: auto; margin: 0; }
.tool-block.tool-error { border-left-color: #c0392b; }
.image-block { margin: 14px 0; text-align: center; }
.image-block img { display: inline-block; max-width: 100%; height: auto; border-radius: 6px; border: 1px solid var(--border); background: #fff; }
.image-block figcaption { margin-top: 6px; color: var(--muted); font-size: .82em; }

.content pre { white-space: pre; overflow-x: auto; background: var(--code-bg); color: var(--code-text); padding: 12px 14px; border-radius: 6px; margin: 12px 0; }
.content pre code { background: none; padding: 0; color: inherit; font-size: .88em; }
.omitted, .empty-message { color: var(--muted); font-style: italic; }
.export-footer { margin-top: 28px; color: var(--muted); font-size: .82rem; }
.copy-btn { position: absolute; top: 12px; right: 12px; padding: 4px 10px; background: var(--btn); color: var(--btn-text); border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
.copy-btn:hover { background: var(--btn-hover); }
.copy-btn:focus-visible, .copy-split button:focus-visible, .copy-options input:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
.copy-bar { display: none; position: relative; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin: 12px 0 14px; }
html.js .copy-bar { display: flex; }
.copy-split { display: inline-flex; border-radius: 8px; box-shadow: 0 1px 3px var(--shadow); }
.copy-split button { display: inline-flex; align-items: center; gap: 7px; margin: 0; padding: 8px 13px; border: 0; background: var(--btn); color: var(--btn-text); font-family: inherit; font-size: 14px; font-weight: 600; line-height: 1.2; cursor: pointer; }
.copy-split button:hover { background: var(--btn-hover); }
.copy-split svg { width: 16px; height: 16px; flex: none; }
.copy-main { border-radius: 8px 0 0 8px; }
.copy-more { border-radius: 0 8px 8px 0; padding: 8px 9px !important; border-left: 1px solid var(--btn-divider) !important; }
.copy-more[aria-expanded="true"] svg { transform: rotate(180deg); }
.copy-status { color: var(--muted); font-size: .85em; }
.copy-options { position: absolute; top: calc(100% + 6px); left: 0; z-index: 40; width: min(340px, calc(100vw - 32px)); padding: 12px 14px; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 10px 30px rgb(0 0 0 / .18); font-size: .9rem; }
.copy-options[hidden] { display: none; }
.copy-options-title { margin: 0 0 4px; font-weight: 600; }
.copy-options label { display: flex; align-items: baseline; gap: 8px; padding: 4px 0; cursor: pointer; }
.copy-options label.is-off { color: var(--muted); cursor: default; }
.copy-opt-note { font-size: .88em; font-style: italic; }
.copy-hint { margin: 8px 0 0; padding-top: 8px; border-top: 1px solid var(--border); color: var(--muted); font-size: .88em; line-height: 1.45; }
	#theme-toggle { position: fixed; top: 12px; left: 10px; padding: 3px 8px; border: 1px solid var(--border); background: var(--surface); color: var(--muted); border-radius: 4px; cursor: pointer; z-index: 51; }
	#theme-toggle:hover { color: var(--text); }
	.branch-view[hidden] { display: none; }
.branch-nav { display: flex; align-items: center; justify-content: center; gap: 10px; margin: 10px 0 0; }
.branch-nav button { min-width: 34px; padding: 4px 9px; border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 6px; cursor: pointer; font-size: 18px; line-height: 1; }
.branch-nav button:disabled { opacity: .4; cursor: default; }
	.branch-nav span { color: var(--muted); font-size: .85em; }
	.branch-option[hidden] { display: none; }
	.branch-fork { margin: 0 0 20px; }
	.branch-choice { display: flex; align-items: center; justify-content: center; gap: 10px; margin: 0 0 12px; }
	.branch-choice button { min-width: 30px; padding: 2px 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 6px; cursor: pointer; font-size: 18px; line-height: 1; }
	.branch-choice button:disabled { opacity: .4; cursor: default; }
	.branch-choice span { color: var(--muted); font-size: .85em; min-width: 30px; text-align: center; }
#rail { max-width: 820px; margin: 0 auto 24px; padding: 12px 16px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
#rail h2 { margin: 0 0 8px; color: var(--muted); font-size: .9rem; }
#rail ol { margin: 0; padding-left: 1.4em; font-size: .9rem; }
#rail li { margin: 2px 0; }
#rail a { color: var(--accent); text-decoration: none; }
#rail a:hover { text-decoration: underline; }
#rail-toggle { display: none; }
#rail-tip { position: fixed; z-index: 60; transform: translateY(-50%); max-width: 44vw; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: #1f2328; color: #fff; font-size: 12px; padding: 4px 9px; border-radius: 4px; pointer-events: none; opacity: 0; transition: opacity .12s ease; }
#rail-tip.on { opacity: 1; }
html.js #rail { position: fixed; top: 0; right: 0; bottom: 0; width: 56px; max-width: none; margin: 0; padding: 0; background: none; border: 0; border-radius: 0; z-index: 50; display: flex; flex-direction: column; justify-content: center; align-items: flex-end; pointer-events: none; }
html.js #rail ol { pointer-events: auto; list-style: none; padding: 4px 0; margin: 0; max-height: calc(100vh - 96px); overflow-y: auto; overflow-x: visible; scrollbar-width: none; }
html.js #rail ol::-webkit-scrollbar { display: none; }
html.js #rail h2 { display: none; }
html.js #rail li { margin: 0; }
html.js #rail a { display: block; position: relative; padding: 4px 16px 4px 12px; }
html.js #rail a::before { content: ""; display: block; height: 3px; width: 16px; margin-left: auto; background: #b9bec4; border-radius: 1px; transition: width .12s ease, background .12s ease; }
html.js #rail a:hover::before, html.js #rail a:focus-visible::before { width: 26px; background: #6e7781; }
html.js #rail li.active a::before { width: 30px; background: var(--accent); }
html.js #rail li.alt a::before { opacity: .4; }
.rail-step { display: none; }
html.js .rail-step { display: block; pointer-events: auto; margin: 6px 12px 6px 0; width: 32px; height: 28px; padding: 0; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--muted); font-size: 13px; line-height: 1; cursor: pointer; }
html.js .rail-step:hover, html.js .rail-step:focus-visible { color: var(--text); border-color: var(--muted); }
html.js .rail-step:disabled { opacity: .35; cursor: default; }
html.js #rail.hidden .rail-step { display: none; }
html.js #rail a span { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
html.js #rail.hidden ol { display: none; }
html.js #rail-toggle { display: block; position: fixed; top: 12px; right: 10px; padding: 3px 8px; border: 1px solid var(--border); background: var(--surface); color: var(--muted); border-radius: 4px; cursor: pointer; z-index: 51; }
html.js .wrap { padding-right: 44px; }
@media (prefers-reduced-motion: no-preference) { html { scroll-behavior: smooth; } }
@media (max-width: 700px) { html.js #rail { display: none; } html.js .wrap { padding-right: 0; } }
`;

const EXPORT_JS = [
  '(function () {',
  '  var root = document.documentElement;',
  "  root.className = root.className ? root.className + ' js' : 'js';",
  '  var themeToggle = document.getElementById("theme-toggle");',
  '  function setDark(dark) { root.classList.toggle("dark", dark); if (themeToggle) { themeToggle.textContent = dark ? "Light mode" : "Dark mode"; themeToggle.setAttribute("aria-pressed", dark ? "true" : "false"); } try { localStorage.setItem("chatgpt-thread-archiver-theme", dark ? "dark" : "light"); } catch (e) {} }',
  '  var storedTheme = "light"; try { storedTheme = localStorage.getItem("chatgpt-thread-archiver-theme") || "light"; } catch (e) {} setDark(storedTheme === "dark");',
  '  if (themeToggle) themeToggle.addEventListener("click", function () { setDark(!root.classList.contains("dark")); });',
  '  // The copy buttons are wired by the copy script that follows this one.',
  '  var onBranchChange = function () {};',
  '  var branchNav = document.getElementById("branch-nav"), branchViews = document.querySelectorAll(".branch-view"), branchPosition = document.getElementById("branch-position"), branchPrev = document.getElementById("branch-prev"), branchNext = document.getElementById("branch-next"), branchCurrent = 0;',
  '  function showBranch(index) { if (!branchViews.length) return; branchCurrent = Math.max(0, Math.min(index, branchViews.length - 1)); for (var b = 0; b < branchViews.length; b++) branchViews[b].hidden = b !== branchCurrent; if (branchPosition) branchPosition.textContent = "Branch " + (branchCurrent + 1) + "/" + branchViews.length; if (branchPrev) branchPrev.disabled = branchCurrent === 0; if (branchNext) branchNext.disabled = branchCurrent === branchViews.length - 1; onBranchChange(); }',
  '  if (branchNav && branchViews.length > 1) { branchPrev.addEventListener("click", function () { showBranch(branchCurrent - 1); }); branchNext.addEventListener("click", function () { showBranch(branchCurrent + 1); }); showBranch(0); }',
  '  var localForks = document.querySelectorAll(".branch-fork");',
  '  for (var f = 0; f < localForks.length; f++) (function (fork) {',
  '    var options = fork.querySelectorAll(":scope > .branch-option"), choice = fork.querySelector(":scope > .branch-choice"), position = choice && choice.querySelector("[data-branch-position]"), prev = choice && choice.querySelector("[data-branch-prev]"), next = choice && choice.querySelector("[data-branch-next]"), current = choice ? Number(choice.getAttribute("data-active-index")) || 0 : 0;',
  '    function showLocal(index) { if (!options.length) return; current = Math.max(0, Math.min(index, options.length - 1)); for (var o = 0; o < options.length; o++) options[o].hidden = o !== current; if (position) position.textContent = (current + 1) + "/" + options.length; if (prev) prev.disabled = current === 0; if (next) next.disabled = current === options.length - 1; onBranchChange(); }',
  '    fork.showOption = showLocal;',
  '    if (options.length > 1) { if (prev) prev.addEventListener("click", function () { showLocal(current - 1); }); if (next) next.addEventListener("click", function () { showLocal(current + 1); }); showLocal(current); }',
  '  })(localForks[f]);',
  '  var rail = document.getElementById("rail"), toggle = document.getElementById("rail-toggle");',
  '  if (!rail) return;',
  '  function setHidden(hidden) { rail.className = hidden ? "hidden" : ""; if (toggle) { toggle.textContent = hidden ? "Nav" : "Hide"; toggle.setAttribute("aria-expanded", hidden ? "false" : "true"); } try { sessionStorage.setItem("chatgpt-thread-archiver-rail-hidden", hidden ? "1" : "0"); } catch (e) {} }',
  '  var stored = "0"; try { stored = sessionStorage.getItem("chatgpt-thread-archiver-rail-hidden") || "0"; } catch (e) {} setHidden(stored === "1");',
  '  if (toggle) toggle.addEventListener("click", function () { setHidden(rail.className !== "hidden"); });',
  '  var links = rail.querySelectorAll(\'ol a[href^="#"]\'), items = [], tip = document.createElement("div");',
  '  tip.id = "rail-tip"; document.body.appendChild(tip);',
  '  for (var i = 0; i < links.length; i++) { var target = document.getElementById(links[i].getAttribute("href").slice(1)); if (target) items.push({ a: links[i], li: links[i].parentNode, el: target }); }',
  '  if (!items.length) return;',
  '  function showTip(a) { var r = a.getBoundingClientRect(); tip.textContent = a.textContent; tip.style.top = (r.top + r.height / 2) + "px"; tip.style.right = (window.innerWidth - r.left + 8) + "px"; tip.className = "on"; }',
  '  function hideTip() { tip.className = ""; }',
  '  var list = rail.querySelector("ol"), steps = rail.querySelectorAll(".rail-step"), current = -1, pinned = -1, pinUntil = 0, visible = Object.create(null), queued = false;',
  '  list.addEventListener("mouseover", function (e) { var a = e.target.closest ? e.target.closest("a") : null; if (a && list.contains(a)) showTip(a); });',
  '  list.addEventListener("mouseleave", hideTip); list.addEventListener("focusin", function (e) { if (e.target.tagName === "A") showTip(e.target); }); list.addEventListener("focusout", hideTip);',
  '  // A prompt inside a version that is not on screen has no layout; the rail dims it, and choosing it switches to that version first.',
  '  function shown(i) { return !items[i].el.closest("[hidden]"); }',
  '  function inView(i) { var r = items[i].el.getBoundingClientRect(); return r.height > 0 && r.bottom > 0 && r.top < window.innerHeight; }',
  '  function mark() { for (var i = 0; i < items.length; i++) items[i].li.classList.toggle("alt", !shown(i)); }',
  '  function step(delta) { var i = current < 0 ? (delta > 0 ? -1 : items.length) : current; do { i += delta; } while (i >= 0 && i < items.length && !shown(i)); return i >= 0 && i < items.length ? i : -1; }',
  '  function paint(i) { if (i >= 0 && i !== current) { if (current >= 0) items[current].li.classList.remove("active"); items[i].li.classList.add("active"); current = i; var lr = items[i].li.getBoundingClientRect(), r = list.getBoundingClientRect(); if (lr.top < r.top) list.scrollTop += lr.top - r.top; else if (lr.bottom > r.bottom) list.scrollTop += lr.bottom - r.bottom; } if (steps.length === 2) { steps[0].disabled = step(-1) < 0; steps[1].disabled = step(1) < 0; } }',
  '  // Near the end of the page the last prompts can never reach the top band, so the last one on screen wins there; a prompt just chosen stays lit while it is on screen.',
  '  function recompute() { queued = false; if (pinned >= 0 && (Date.now() < pinUntil || inView(pinned))) { paint(pinned); return; } pinned = -1; var atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4, pick = -1; for (var i = 0; i < items.length; i++) if (shown(i) && (atEnd ? inView(i) : visible[items[i].el.id])) { pick = i; if (!atEnd) break; } paint(pick); }',
  '  function schedule() { if (!queued) { queued = true; (window.requestAnimationFrame || setTimeout)(recompute); } }',
  '  if (window.IntersectionObserver) { var io = new IntersectionObserver(function (entries) { for (var k = 0; k < entries.length; k++) { var e = entries[k]; if (e.isIntersecting) visible[e.target.id] = 1; else delete visible[e.target.id]; } schedule(); }, { rootMargin: "-8% 0px -55% 0px", threshold: 0 }); for (var j = 0; j < items.length; j++) io.observe(items[j].el); }',
  '  window.addEventListener("scroll", schedule, { passive: true });',
  '  function release() { if (pinned >= 0) { pinned = -1; pinUntil = 0; schedule(); } }',
  '  window.addEventListener("wheel", release, { passive: true }); window.addEventListener("touchmove", release, { passive: true });',
  '  function reveal(el) { for (var guard = 0; guard < 20; guard++) { var box = el.closest(".branch-option[hidden], .branch-view[hidden]"); if (!box) break; var index = Number(box.getAttribute("data-branch-index")) || 0; if (box.classList.contains("branch-view")) showBranch(index); else if (box.parentNode && box.parentNode.showOption) box.parentNode.showOption(index); else break; } }',
  '  function jump(i) { if (i < 0) return; reveal(items[i].el); pinned = i; pinUntil = Date.now() + 1200; items[i].el.scrollIntoView({ behavior: "smooth", block: "start" }); paint(i); }',
  '  function go(delta) { jump(step(delta)); }',
  '  list.addEventListener("click", function (e) { var a = e.target.closest ? e.target.closest("a") : null; if (!a || !list.contains(a)) return; for (var i = 0; i < items.length; i++) if (items[i].a === a) { e.preventDefault(); jump(i); return; } });',
  '  for (var s = 0; s < steps.length; s++) steps[s].addEventListener("click", function (e) { go(Number(e.currentTarget.getAttribute("data-rail-step")) || 1); });',
  '  onBranchChange = function () { mark(); schedule(); };',
  '  mark(); paint(step(1));',
  '  document.addEventListener("keydown", function (e) { var t = e.target; if (e.ctrlKey || e.metaKey || (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))) return; if (e.key === "j" || e.key === "n" || (e.altKey && e.key === "ArrowDown")) { e.preventDefault(); go(1); } else if (e.key === "k" || e.key === "p" || (e.altKey && e.key === "ArrowUp")) { e.preventDefault(); go(-1); } });',
  '})();',
].join('\n');

const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 3h9a2 2 0 0 1 2 2v12h-2V5H8V3Zm-3 4h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Zm0 2v10h9V9H5Z"/></svg>';
const CHEVRON_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M7.4 9 12 13.6 16.6 9 18 10.4l-6 6-6-6L7.4 9Z"/></svg>';

// The Copy chat button and its options. A choice is offered only for content this chat
// has. Thinking and tool calls that the export left out are still listed, greyed out, so
// it is clear why they cannot be copied.
function renderCopyBar(messages, { provider, includeThinking, includeMessageModels, forked }) {
  const blocks = messages.flatMap((message) => message.textBlocks ?? []);
  const hasType = (...types) => blocks.some((block) => types.includes(block.type));
  const options = [];
  const option = (name, label, { checked = false, missing = '' } = {}) => {
    const note = missing ? ` <span class="copy-opt-note">${escapeHtml(missing)}</span>` : '';
    options.push(`<label${missing ? ' class="is-off"' : ''}><input type="checkbox" data-copy-opt="${name}"${checked && !missing ? ' checked' : ''}${missing ? ' disabled' : ''}><span>${escapeHtml(label)}${note}</span></label>`);
  };
  const leftOut = 'not in this export';
  option('speakers', `Names (You, ${provider})`, { checked: true });
  if (hasType('thinking')) option('thinking', 'Thinking', { missing: includeThinking ? '' : leftOut });
  if (hasType('tool_use', 'tool_result')) option('tools', 'Tool calls and results', { missing: includeThinking ? '' : leftOut });
  else if (messages.some((message) => message.role === 'tool')) option('tools', 'Tool messages');
  if (messages.some((message) => formatTimestamp(message.createdAt))) option('times', 'Timestamps');
  if (includeMessageModels && messages.some((message) => message.role === 'assistant')) option('models', 'Model names');
  option('title', 'Chat title', { checked: true });
  option('details', 'Export date, model and link');
  if (hasType('image', 'omitted')) option('placeholders', 'Notes where images or other content were left out');
  if (messages.some((message) => message.hidden)) option('hidden', `Messages hidden by ${provider}`);
  const shownOnly = forked ? ' Only the versions shown on screen are copied.' : '';
  return `<div class="copy-bar" id="copy-bar"><div class="copy-split"><button id="copy-chat" class="copy-main" type="button" title="Copy the whole chat as formatted text">${COPY_ICON}<span data-copy-label>Copy chat</span></button><button id="copy-options-toggle" class="copy-more" type="button" aria-expanded="false" aria-controls="copy-options" aria-label="Copy options" title="Choose what Copy chat includes">${CHEVRON_ICON}</button></div><span id="copy-status" class="copy-status" role="status" aria-live="polite"></span><div id="copy-options" class="copy-options" role="group" aria-labelledby="copy-options-title" hidden><p id="copy-options-title" class="copy-options-title">Copy chat includes</p>${options.join('')}<p class="copy-hint">Copies the text, without images. Headings, lists, tables and code keep their format in apps like Obsidian, Notion, Google Docs and Word.${shownOnly}</p></div></div>`;
}

function renderMessageArticle(message, id, messageIndex, includeMessageModels, railItems, branchLabel = '', includeThinking = false) {
  const timestamp = formatTimestamp(message.createdAt);
  const timestampValue = timestampIso(message.createdAt);
  const blocks = message.textBlocks.map((block) => renderBlock(block, includeMessageModels, includeThinking)).join('') || '<p class="empty-message">[empty message]</p>';
  const copyButton = '<button class="copy-btn" type="button" title="Copy this message as formatted text">Copy</button>';
  if (message.role === 'user') {
    railItems.push(`<li><a href="#${id}"><span>${escapeHtml(branchLabel + railLabel(messagePlainText(message)))}</span></a></li>`);
  }
  const hiddenClass = message.hidden ? ' message-hidden' : '';
  const datetime = timestampValue ? ` datetime="${escapeAttribute(timestampValue)}"` : '';
  return `<article class="message ${escapeAttribute(message.role)} message-${escapeAttribute(message.role)}${hiddenClass}" id="${id}" data-message-index="${messageIndex}" data-message-id="${escapeAttribute(message.id)}" dir="auto"><header class="message-header"><h2>${escapeHtml(message.authorLabel)}${messageModelLine(message, includeMessageModels)}${timestamp ? `<span class="msg-time"><time${datetime}>${escapeHtml(timestamp)}</time></span>` : ''}</h2></header>${copyButton}<div class="content message-body">${blocks}</div></article>`;
}

function renderMessageList(messages, branchIndex, branchCount, includeMessageModels, railItems, includeThinking = false) {
  return messages.map((message, index) => {
    const id = branchCount > 1
      ? `m-b${String(branchIndex + 1).padStart(2, '0')}-${String(index + 1).padStart(4, '0')}`
      : `m-${String(index + 1).padStart(4, '0')}`;
    const branchPrefix = branchCount > 1 ? `Branch ${branchIndex + 1} · ` : '';
    return renderMessageArticle(message, id, index + 1, includeMessageModels, railItems, branchPrefix, includeThinking);
  }).join('\n');
}

function renderBranchTree(tree, activeIds, includeMessageModels, railItems, includeThinking = false) {
  const state = { messageIndex: 0, forkIndex: 0 };
  const containsActive = (node) => Boolean(node && (activeIds.has(node.message.id) || node.children.some(containsActive)));
  // One set of `‹ n/m ›` controls over a list of alternatives. Used for a fork below a
  // message and for the root list itself: editing the very first prompt forks the
  // conversation at the root, with no parent message to hang the controls under, and
  // those alternatives need the same switcher as any other fork rather than being
  // stacked one after the other.
  const renderFork = (children) => {
    const forkId = `fork-${String(++state.forkIndex).padStart(3, '0')}`;
    let activeIndex = children.findIndex(containsActive);
    if (activeIndex < 0) activeIndex = 0;
    const options = children.map((child, index) => `<div class="branch-option" data-fork-id="${forkId}" data-branch-index="${index}"${index === activeIndex ? ' data-active="true"' : ''}>${renderNode(child)}</div>`).join('');
    const controls = `<div class="branch-choice" data-fork-id="${forkId}" data-active-index="${activeIndex}" role="group" aria-label="Conversation alternatives"><button type="button" data-branch-prev aria-label="Previous alternative">‹</button><span data-branch-position>${activeIndex + 1}/${children.length}</span><button type="button" data-branch-next aria-label="Next alternative">›</button></div>`;
    // The switcher sits above the alternatives it governs. Below them, two nested forks
    // put both switchers at the foot of the document with nothing saying which is which.
    return `<div class="branch-fork" data-fork-id="${forkId}">${controls}${options}</div>`;
  };
  const renderNode = (node) => {
    const id = `m-tree-${String(++state.messageIndex).padStart(4, '0')}`;
    const article = renderMessageArticle(node.message, id, state.messageIndex, includeMessageModels, railItems, '', includeThinking);
    if (!Array.isArray(node.children) || node.children.length <= 1) {
      return `${article}${node.children?.[0] ? renderNode(node.children[0]) : ''}`;
    }
    return `${article}${renderFork(node.children)}`;
  };
  return tree.length > 1 ? renderFork(tree) : tree.map(renderNode).join('\n');
}

export function renderConversationHtml(conversation, { exportedAt = new Date().toISOString(), sourceUrl = null, includeConversationId = false, includeTitle = true, includeMessageModels = true, includeAllBranches = false, includeThinking = false } = {}) {
  const provider = typeof conversation.provider === 'string' && conversation.provider.trim() ? conversation.provider.trim() : 'ChatGPT';
  const availableBranches = Array.isArray(conversation.branches) && conversation.branches.length > 1 ? conversation.branches : [];
  const localTree = includeAllBranches && Array.isArray(conversation.branchTree) && conversation.branchTree.length > 0 ? conversation.branchTree : [];
  const useLocalTree = localTree.length > 0;
  const branchRecords = includeAllBranches && availableBranches.length > 1 && !useLocalTree
    ? availableBranches
    : [{ index: 0, messages: conversation.messages, active: true, stats: conversation.stats }];
  const branchCount = branchRecords.length;
  const availableBranchCount = availableBranches.length || (conversation.stats?.branchCount ?? 0);
  const railItems = [];
  const activeBranchMessages = availableBranches[conversation.activeBranchIndex ?? 0]?.messages ?? conversation.messages;
  const activeIds = new Set((activeBranchMessages ?? []).map((message) => message.id));
  const renderedMessages = useLocalTree ? messagesFromBranchTree(localTree) : branchRecords.flatMap((branch) => branch.messages ?? []);
  const messagesHtml = useLocalTree
    ? renderBranchTree(localTree, activeIds, includeMessageModels, railItems, includeThinking)
    : branchRecords.map((branch, index) => `<div class="branch-view" data-branch-index="${index}">${renderMessageList(branch.messages, index, branchCount, includeMessageModels, railItems, includeThinking)}</div>`).join('\n');
  const branchNavigator = !useLocalTree && branchCount > 1
    ? `<div id="branch-nav" class="branch-nav" role="group" aria-label="Conversation branches"><button id="branch-prev" type="button" aria-label="Previous branch">‹</button><span id="branch-position">Branch 1/${branchCount}</span><button id="branch-next" type="button" aria-label="Next branch">›</button></div>`
    : '';
  const branchNote = useLocalTree
    ? `All ${provider} conversation branches exported with local fork controls.`
    : branchCount > 1
      ? `All ${provider} conversation branches exported.`
      : conversation.activeBranch
        ? (availableBranchCount > 1 ? `Active ${provider} conversation branch exported; ${availableBranchCount - 1} alternate branch${availableBranchCount === 2 ? '' : 'es'} available (edited prompts or regenerated replies).` : `Active ${provider} conversation branch exported.`)
        : `${provider} message array exported.`;
  const rawTitle = includeTitle ? conversation.title : `${provider} conversation`;
  const title = escapeHtml(rawTitle);
  const idMeta = includeConversationId && conversation.conversationId ? `<meta name="conversation-id" content="${escapeAttribute(conversation.conversationId)}">` : '';
  const sourceBlock = sourceUrl ? `<p class="meta" data-copy-meta>Source: <a href="${escapeAttribute(sourceUrl)}" rel="noopener noreferrer">${escapeHtml(sourceUrl)}</a></p>` : '';
  const metadata = `<p class="meta" data-copy-meta>Exported ${escapeHtml(exportedAt)} · ${renderedMessages.length} message${renderedMessages.length === 1 ? '' : 's'} (${escapeHtml(roleCounts(renderedMessages, provider))})</p>`;
  const copyBar = renderCopyBar(renderedMessages, { provider, includeThinking, includeMessageModels, forked: useLocalTree || branchCount > 1 });
  const branchLine = availableBranchCount > 1 ? `<p class="meta">Branches: ${useLocalTree ? `${availableBranchCount} available; local fork controls shown` : branchCount > 1 ? `${branchCount} exported` : `1 of ${availableBranchCount} exported`}</p>` : '';
  const modelLine = formatModels(conversation);
  const statsLine = formatLocalStats(conversation.stats);
  const omissionLine = conversation.stats.omittedBlockCount > 0
    ? `<p class="meta flag-warn">${conversation.stats.omittedBlockCount} omitted non-text block${conversation.stats.omittedBlockCount === 1 ? '' : 's'}</p>`
    : '<p class="meta flag-ok">Text blocks complete</p>';
  const imageLine = Number.isFinite(conversation.stats.imageCount) && conversation.stats.imageCount > 0
    ? `<p class="meta">Images: ${conversation.stats.imageEmbeddedCount ?? 0} embedded, ${conversation.stats.imageExcludedCount ?? 0} excluded, ${conversation.stats.imageUnavailableCount ?? 0} unavailable${conversation.stats.imageBudgetLimitedCount ? `; ${conversation.stats.imageBudgetLimitedCount} limited by export budget` : ''}${Number(conversation.stats.imageBytes) > 0 ? ` · ${Math.ceil(Number(conversation.stats.imageBytes) / 1024)} KB embedded` : ''}</p>`
    : '';
  const coverageLine = (conversation.stats.droppedNodeCount ?? 0) > 0 || (conversation.stats.duplicateMessageCount ?? 0) > 0
    ? `<p class="meta flag-warn">Coverage: ${conversation.stats.droppedNodeCount ?? 0} dropped node${conversation.stats.droppedNodeCount === 1 ? '' : 's'}, ${conversation.stats.duplicateMessageCount ?? 0} duplicate message${conversation.stats.duplicateMessageCount === 1 ? '' : 's'} removed</p>`
    : '';
  const historyLine = conversation.stats.historyIncomplete === true
    ? `<p class="meta flag-warn">Coverage: ${escapeHtml(provider)} did not return the earliest part of this chat, so this export starts partway through.</p>`
    : '';
  // A conversation with tool calls carries more supporting blocks than answers, so an
  // export that leaves them out says so once rather than marking each one.
  const reasoningCount = renderedMessages.reduce((sum, message) => sum + (message.textBlocks ?? []).filter((block) => THINKING_BLOCK_TYPES.has(block.type)).length, 0);
  const reasoningLine = reasoningCount > 0 && !includeThinking
    ? `<p class="meta">Not exported: ${reasoningCount} thinking and tool block${reasoningCount === 1 ? '' : 's'}. Re-export with &quot;Include Claude thinking and tool calls&quot; to keep them.</p>`
    : '';

  // Messages on branches this export did not take are withheld by choice, not lost, so
  // they get a neutral line rather than the coverage warning. An export that already
  // carries every branch is withholding nothing, whatever the source count says.
  const withheldCount = !useLocalTree && branchCount === 1 ? (conversation.stats.alternateBranchMessageCount ?? 0) : 0;
  const alternateLine = withheldCount > 0
    ? `<p class="meta">Not exported: ${withheldCount} message${withheldCount === 1 ? '' : 's'} on ${availableBranchCount - 1} other branch${availableBranchCount === 2 ? '' : 'es'}. Re-export with &quot;Include edited and regenerated branches&quot; to keep them.</p>`
    : '';
  const hiddenLine = (conversation.stats.hiddenMessageCount ?? 0) > 0
    ? `<p class="meta flag-warn">${conversation.stats.hiddenMessageCount} message${conversation.stats.hiddenMessageCount === 1 ? '' : 's'} marked hidden by ${escapeHtml(provider)}; included unchanged</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="chatgpt-thread-archiver ${ARCHIVER_VERSION}">
<meta name="exported-at" content="${escapeAttribute(exportedAt)}">
${idMeta}
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">
<title>${title}</title>
<style>${EXPORT_CSS}</style>
</head>
<body>
<button id="theme-toggle" type="button" aria-pressed="false">Dark mode</button>
<button id="rail-toggle" type="button" aria-controls="rail" aria-expanded="true">Hide</button>
<nav id="rail" aria-label="Prompts"><h2>Prompts</h2><button class="rail-step" type="button" data-rail-step="-1" aria-label="Previous prompt" title="Previous prompt (k)">▲</button><ol>${railItems.join('')}</ol><button class="rail-step" type="button" data-rail-step="1" aria-label="Next prompt" title="Next prompt (j)">▼</button></nav>
<div class="wrap">
<header class="export-head">
  <h1>${title}</h1>
  ${copyBar}
  ${metadata}
  ${branchLine}
  ${modelLine}
  ${statsLine}
  ${sourceBlock}
  ${omissionLine}
  ${imageLine}
  ${reasoningLine}
  ${coverageLine}
  ${historyLine}
  ${alternateLine}
  ${hiddenLine}
  ${branchNavigator}
</header>
<main>
<section aria-label="Conversation messages">
${messagesHtml}
</section>
<footer class="export-footer">${escapeHtml(branchNote)} Generated locally by chatgpt-thread-archiver ${ARCHIVER_VERSION}. This file was generated locally and is designed to work offline.</footer>
</main>
</div>
<script>${EXPORT_JS}
${EXPORT_COPY_JS}</script>
</body>
</html>`;
}

const WINDOWS_DEVICE_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function sanitizeFilename(value, fallback = 'chatgpt-conversation') {
  const cleaned = String(value ?? '')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001F\u202A-\u202E\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 120);
  if (!cleaned) return fallback;
  return WINDOWS_DEVICE_NAME_RE.test(cleaned) ? `_${cleaned}` : cleaned;
}
