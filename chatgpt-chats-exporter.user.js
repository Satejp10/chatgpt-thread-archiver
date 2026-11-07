// ==UserScript==
// @name         ChatGPT Thread Archiver
// @namespace    local.chatgpt-thread-archiver
// @version      0.19.0
// @description  Export ChatGPT or Claude.ai conversations to self-contained HTML with branch choices, uncapped image selection, quick export, formatted copy, collapsible messages, and safe local statistics with a token estimate and context gauge.
// @match        https://chatgpt.com/*
// @match        https://claude.ai/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
'use strict';
const ARCHIVER_VERSION = '0.19.0';
const ROLE_LABELS = {
  user: 'You',
  assistant: 'ChatGPT',
  system: 'System',
  tool: 'Tool',
};

class ConversationShapeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ConversationShapeError';
    this.details = details;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(value) {
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

function discoverImageModelMetadata(value) {
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

function extractTextBlocks(message) {
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

function branchTreeFromBranches(branches) {
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

function messagesFromBranchTree(tree) {
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

function normalizeConversation(raw) {
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

function selectConversationBranch(conversation, index = 0) {
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

function textToBlocks(text) {
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
function formatTokenEstimate(count) {
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

// Context gauge (v0.19.0). `stats.context` is the local estimate from
// src/context-estimate.mjs; the page shows it as a share of a window size the reader picks.
// The file is written for 1M, so it reads correctly with scripts off; the page script
// redraws it for another size and remembers the choice in this browser, like the theme.
const CONTEXT_WINDOW_SIZES = [32000, 128000, 200000, 256000, 400000, 500000, 1000000];
const DEFAULT_CONTEXT_WINDOW = 1000000;

// 2237 → "2.24K", 22345 → "22.3K", 1000000 → "1M": three significant figures at most.
function formatCompactTokens(count) {
  const value = Math.max(0, Math.round(Number(count) || 0));
  if (value < 1000) return String(value);
  const [unit, size] = value < 999500 ? ['K', 1e3] : ['M', 1e6];
  const scaled = value / size;
  return `${Number(scaled.toFixed(scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2))}${unit}`;
}

// Also runs inside the exported page (see EXPORT_CONTEXT_JS), so it is plain ES5.
function formatContextShare(tokens, windowSize) {
  var share = windowSize > 0 ? (Number(tokens) || 0) / windowSize * 100 : 0;
  if (!(share > 0)) return '0%';
  if (share < 0.1) return '<0.1%';
  if (share < 9.95) return share.toFixed(1) + '%';
  return Math.round(share) + '%';
}

function formatSeconds(seconds) {
  const whole = Math.round(seconds);
  return whole < 60 ? `${whole}s` : `${Math.floor(whole / 60)}m ${whole % 60}s`;
}

// The gauge's tooltip: what the estimate added up, and what it could not see.
function contextBreakdown(context, provider, branchCount) {
  const about = (count) => `about ${formatTokenEstimate(count)}`;
  const lines = [`Local estimate, not ${provider}’s own figure.`];
  if (provider === 'Claude') {
    lines.push(`Messages: ${about(context.messages)} (counted locally, × ${context.textFactor} for Claude’s tokenizer)`);
    if (context.thinkingSteps > 0) {
      const untimed = context.untimedThinkingSteps > 0 ? `; ${context.untimedThinkingSteps} step${context.untimedThinkingSteps === 1 ? '' : 's'} without a time not counted` : '';
      lines.push(`Thinking: ${about(context.thinking)} (${formatSeconds(context.thinkingSeconds)} at about ${context.thinkingTokensPerSecond} tokens a second${untimed})`);
    }
    if (context.tools > 0) lines.push(`Tool calls and results: ${about(context.tools)}`);
    if (context.imageCount > 0) {
      const unsized = context.unsizedImageCount > 0 ? `; ${context.unsizedImageCount} without a known size not counted` : '';
      lines.push(`Images: ${about(context.images)} (${context.imageCount} image${context.imageCount === 1 ? '' : 's'}${unsized})`);
    }
    lines.push(`Claude’s published instructions: ${about(context.instructions)}`);
    lines.push('Not counted: tool descriptions, memory, preferences, project knowledge and attached files. In long chats Claude may summarize earlier messages and hold less.');
  } else {
    lines.push(`Messages: ${about(context.messages)} (the exported text, counted locally)`);
    lines.push(`Not counted: ${provider}’s system instructions, memory, hidden reasoning, images and uploaded files.`);
  }
  if (branchCount > 1) lines.push('Counted on the chat’s current branch only.');
  return lines.join('\n');
}

function renderContextGauge(context, provider, branchCount) {
  const total = Number(context?.total);
  if (!Number.isFinite(total) || total < 0) return '';
  const tokens = Math.round(total);
  const share = (tokens / DEFAULT_CONTEXT_WINDOW) * 100;
  const level = share >= 100 ? ' ctx-over' : share >= 80 ? ' ctx-high' : '';
  const options = CONTEXT_WINDOW_SIZES.map((size) => `<option value="${size}"${size === DEFAULT_CONTEXT_WINDOW ? ' selected' : ''}>${formatCompactTokens(size)}</option>`).join('');
  return `<div class="context-gauge${level}" id="context-gauge" data-context-tokens="${tokens}" title="${escapeAttribute(contextBreakdown(context, provider, branchCount))}"><div class="ctx-top"><span class="ctx-label">Context used</span><span class="ctx-share" data-ctx-share>${formatContextShare(tokens, DEFAULT_CONTEXT_WINDOW)}</span></div><div class="ctx-bar" aria-hidden="true"><span class="ctx-fill" data-ctx-fill style="width: ${Math.min(100, share).toFixed(2)}%"></span></div><div class="ctx-sub"><span>≈${formatCompactTokens(tokens)} of <span class="ctx-static">${formatCompactTokens(DEFAULT_CONTEXT_WINDOW)}</span><select class="ctx-window" aria-label="Context window size">${options}</select> tokens</span><span class="ctx-note">local estimate</span></div></div>`;
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
function copyMarkdownToHtml(markdown) {
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

// The context gauge's window picker. The count is in the gauge's data attribute; this
// redraws the share for the window picked and keeps that choice in this browser.
function exportContextRuntime(formatShare) {
  var STORE = 'chatgpt-thread-archiver-context-window';
  var gauge = document.getElementById('context-gauge');
  var select = gauge && gauge.querySelector('select');
  var share = gauge && gauge.querySelector('[data-ctx-share]');
  var fill = gauge && gauge.querySelector('[data-ctx-fill]');
  if (!select || !share || !fill) return;
  var tokens = Number(gauge.getAttribute('data-context-tokens')) || 0;
  function paint() {
    var size = Number(select.value) || 1000000;
    var percent = tokens / size * 100;
    share.textContent = formatShare(tokens, size);
    fill.style.width = Math.min(100, percent).toFixed(2) + '%';
    gauge.classList.toggle('ctx-high', percent >= 80 && percent < 100);
    gauge.classList.toggle('ctx-over', percent >= 100);
  }
  try {
    var saved = localStorage.getItem(STORE);
    for (var i = 0; i < select.options.length; i++) if (select.options[i].value === saved) select.selectedIndex = i;
  } catch (error) {}
  select.addEventListener('change', function () {
    try { localStorage.setItem(STORE, select.value); } catch (error) {}
    paint();
  });
  paint();
}

const EXPORT_CONTEXT_JS = `(${exportContextRuntime.toString()})(${formatContextShare.toString()});`;

const EXPORT_CSS = `
:root { color-scheme: light; --bg: #f9f9f9; --surface: #fff; --text: #24292f; --muted: #57606a; --border: #e0e0e0; --user: #eef2ff; --assistant: #fff; --accent: #10a37f; --link: #0969da; --code-bg: #1f2328; --code-text: #e6edf3; --shadow: rgb(0 0 0 / .05); --btn: #0b7a5e; --btn-hover: #09664f; --btn-text: #fff; --btn-divider: rgb(255 255 255 / .35); }
	html.dark { color-scheme: dark; --bg: #0f1115; --surface: #171a21; --text: #e6edf3; --muted: #9aa4b2; --border: #303744; --user: #25213d; --assistant: #171a21; --accent: #35c89e; --link: #7ab7ff; --code-bg: #090c11; --code-text: #e6edf3; --shadow: rgb(0 0 0 / .3); --btn: #35c89e; --btn-hover: #5ad4b0; --btn-text: #06231a; --btn-divider: rgb(6 35 26 / .3); }
	* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--text); font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.wrap { max-width: 820px; margin: 0 auto; }
header.export-head { margin-bottom: 24px; }
.export-head h1 { font-size: 1.5em; margin: 0 0 6px; word-wrap: break-word; }
.export-title { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px 20px; }
.export-title h1 { flex: 1 1 300px; min-width: 0; }
.context-gauge { flex: 0 0 auto; width: 292px; margin-bottom: 6px; padding: 8px 12px 9px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); box-shadow: 0 1px 3px var(--shadow); color: var(--muted); font-size: 12px; line-height: 1.4; cursor: help; }
.ctx-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.ctx-label { font-weight: 600; letter-spacing: .02em; }
.ctx-share { color: var(--text); font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
.ctx-bar { height: 6px; margin: 4px 0 6px; border-radius: 999px; background: var(--border); overflow: hidden; }
.ctx-fill { display: block; height: 100%; min-width: 2px; border-radius: inherit; background: var(--accent); transition: width .2s ease; }
.context-gauge.ctx-high .ctx-fill { background: #d4a72c; }
.context-gauge.ctx-over .ctx-fill { background: #cf222e; }
.context-gauge.ctx-over .ctx-share { color: #cf222e; }
	html.dark .context-gauge.ctx-over .ctx-share { color: #ff8182; }
.ctx-sub { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 2px 8px; }
.ctx-note { white-space: nowrap; }
.ctx-static { color: var(--text); font-weight: 600; }
.ctx-window { display: none; margin: 0 1px; padding: 0 2px; font: inherit; font-weight: 600; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 4px; cursor: pointer; }
.ctx-window:focus-visible { outline: 2px solid var(--link); outline-offset: 1px; }
html.js .ctx-window { display: inline-block; }
html.js .ctx-static { display: none; }
@media (max-width: 560px) { .context-gauge { width: 100%; } }
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
.message-fold > summary { display: flex; align-items: baseline; gap: 4px 10px; padding-right: 60px; cursor: pointer; list-style: none; border-radius: 4px; }
.message-fold > summary::-webkit-details-marker { display: none; }
.message-fold > summary::before { content: ""; flex: none; align-self: flex-start; margin-top: .45em; width: 0; height: 0; border-style: solid; border-width: 5px 0 5px 8px; border-color: transparent transparent transparent var(--muted); transition: transform .12s ease; }
.message-fold[open] > summary::before { transform: rotate(90deg); }
.message-fold > summary:hover h2 { color: var(--text); }
.message-fold > summary:focus-visible { outline: 2px solid var(--link); outline-offset: 3px; }
.message-fold > summary h2 { min-width: 0; }
.message-peek { flex: 1 1 0; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--muted); font-size: .88em; }
.message-fold[open] .message-peek { display: none; }
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
  '  document.addEventListener("keydown", function (e) { var t = e.target; if (e.ctrlKey || e.metaKey || (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable))) return; if (e.key === "j" || e.key === "n" || (e.altKey && e.key === "ArrowDown")) { e.preventDefault(); go(1); } else if (e.key === "k" || e.key === "p" || (e.altKey && e.key === "ArrowUp")) { e.preventDefault(); go(-1); } });',
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
  // Each message folds like a thinking block (v0.19.0): its header is the <summary>, so a
  // click or Enter on it hides the body, with no script needed. Tool messages start folded,
  // like Claude's tool blocks: they are supporting output, often long. A folded message
  // shows the start of its text. The copy button sits outside the summary so that copying
  // does not fold the message, and copying a folded message still copies all of it.
  const peek = messagePeek(message);
  const open = message.role === 'tool' ? '' : ' open';
  return `<article class="message ${escapeAttribute(message.role)} message-${escapeAttribute(message.role)}${hiddenClass}" id="${id}" data-message-index="${messageIndex}" data-message-id="${escapeAttribute(message.id)}" dir="auto"><details class="message-fold"${open}><summary class="message-header"><h2>${escapeHtml(message.authorLabel)}${messageModelLine(message, includeMessageModels)}${timestamp ? `<span class="msg-time"><time${datetime}>${escapeHtml(timestamp)}</time></span>` : ''}</h2>${peek ? `<span class="message-peek">${escapeHtml(peek)}</span>` : ''}</summary><div class="content message-body">${blocks}</div></details>${copyButton}</article>`;
}

// The start of a message's text, shown in its header while it is folded.
// Cut by characters, not UTF-16 units, so an emoji is never split in two.
function messagePeek(message) {
  const flat = messagePlainText(message).slice(0, 600).replace(/[\uD800-\uDBFF]$/, '').replace(/\s+/g, ' ').trim();
  const characters = Array.from(flat);
  return characters.length > 140 ? `${characters.slice(0, 139).join('')}…` : flat;
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

function renderConversationHtml(conversation, { exportedAt = new Date().toISOString(), sourceUrl = null, includeConversationId = false, includeTitle = true, includeMessageModels = true, includeAllBranches = false, includeThinking = false } = {}) {
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
  const contextGauge = renderContextGauge(conversation.stats?.context, provider, availableBranchCount);
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
  <div class="export-title"><h1>${title}</h1>${contextGauge}</div>
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
${EXPORT_COPY_JS}
${EXPORT_CONTEXT_JS}</script>
</body>
</html>`;
}

const WINDOWS_DEVICE_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function sanitizeFilename(value, fallback = 'chatgpt-conversation') {
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

const DEFAULT_TIMEOUT_MS = 20_000;
const TOKEN_TTL_MS = 60_000;
const CONVERSATION_PATH_RE = /^\/backend-api\/conversation\/[A-Za-z0-9_-]{1,100}(?:\?[A-Za-z0-9_=&-]{0,200})?$/;
let cachedAccessToken = null;
let tokenFetchedAt = 0;
let authInvalidationInstalled = false;
let lastObservedLocation = '';

class ChatGPTClientError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ChatGPTClientError';
    this.code = code;
    this.details = details;
  }
}

function currentOrigin() {
  return globalThis.location?.origin ?? 'https://chatgpt.com';
}

const EXCLUDED_SECTIONS = new Set(['codex', 'scheduled', 'library']);
const TEMPORARY_ID_RE = /\/backend-api\/conversation\/([A-Za-z0-9_-]{16,100})(?=[/?]|$)/;
const temporaryState = { key: undefined, since: 0, observed: [], observer: null };

function temporaryWindowStart(key) {
  // Requests made before the user entered this temporary chat belong to another chat.
  // The first route the script sees is the page load itself, so nothing precedes it.
  if (temporaryState.key === undefined) temporaryState.since = 0;
  else if (temporaryState.key !== key) temporaryState.since = globalThis.performance?.now?.() ?? 0;
  temporaryState.key = key;
  return temporaryState.since;
}

function installTemporaryChatObserver() {
  // The resource-timing buffer stops recording once full; an observer does not.
  if (temporaryState.observer || typeof globalThis.PerformanceObserver !== 'function') return;
  try {
    temporaryState.observer = new globalThis.PerformanceObserver((list) => {
      for (const entry of list.getEntries()) temporaryState.observed.push({ name: entry.name, startTime: entry.startTime });
      temporaryState.observed.splice(0, Math.max(0, temporaryState.observed.length - 200));
    });
    temporaryState.observer.observe({ type: 'resource', buffered: true });
  } catch {
    temporaryState.observer = null;
  }
}

function latestResourceId(entries, re, since) {
  let latest = null;
  for (const entry of entries) {
    if (!(Number(entry?.startTime) >= since)) continue;
    let parsed;
    try {
      parsed = new URL(String(entry?.name ?? ''), currentOrigin());
    } catch {
      continue;
    }
    if (parsed.origin !== currentOrigin()) continue;
    const id = parsed.pathname.match(re)?.[1];
    if (id && (!latest || entry.startTime >= latest.startTime)) latest = { id, startTime: entry.startTime };
  }
  return latest?.id ?? null;
}

function temporaryConversationId(url, options) {
  if (options.resourceEntries) return latestResourceId(options.resourceEntries, TEMPORARY_ID_RE, 0);
  // Keyed on the route, not the full address: the app may rewrite the address while the
  // chat is open, and that must not discard the requests already seen.
  const since = temporaryWindowStart('temporary');
  const buffered = globalThis.performance?.getEntriesByType?.('resource') ?? [];
  return latestResourceId([...buffered, ...temporaryState.observed], TEMPORARY_ID_RE, since);
}

function parseConversationRoute(url = globalThis.location?.href ?? '', options = {}) {
  if (!options.resourceEntries) {
    // Track every route change, not only temporary ones, so leaving and re-entering a
    // temporary chat restarts its request window.
    try {
      const parsed = new URL(url);
      if (!(parsed.pathname === '/' && parsed.searchParams.get('temporary-chat') === 'true')) temporaryWindowStart('');
    } catch {
      // An invalid URL is reported below.
    }
  }
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts[0] === 'g') {
      if (parts[2] !== 'c') {
        return { kind: 'project', conversationId: null, pathname: parsed.pathname, routeSegment: 'g', reason: 'Projects route has no specific conversation path' };
      }
      const rawId = parts[3];
      if (!rawId) return { kind: 'missing-id', conversationId: null, pathname: parsed.pathname, routeSegment: 'g', reason: 'Project conversation route has no conversation ID' };
      return {
        kind: 'conversation',
        conversationId: decodeURIComponent(rawId),
        pathname: parsed.pathname,
        routeSegment: 'g',
      };
    }
    // The script runs on the whole host so a new chat gets the button without a reload.
    // These sections are not chats and never show it.
    if (EXCLUDED_SECTIONS.has(parts[0])) return { kind: 'excluded', conversationId: null, pathname: parsed.pathname, reason: 'section is not a conversation' };
    const routeIndex = parts.findIndex((part) => part === 'c' || part === 's' || part === 'conversation');
    if (routeIndex >= 0) {
      const rawId = parts[routeIndex + 1];
      if (!rawId) return { kind: 'missing-id', conversationId: null, pathname: parsed.pathname, reason: 'conversation route has no ID' };
      return {
        kind: 'conversation',
        conversationId: decodeURIComponent(rawId),
        pathname: parsed.pathname,
        routeSegment: parts[routeIndex],
      };
    }
    if (parts[0] === 'share') return { kind: 'share', conversationId: null, pathname: parsed.pathname, reason: 'share links are not owned conversation routes' };
    if (parts.length === 0 && parsed.searchParams.get('temporary-chat') === 'true') {
      // A temporary chat keeps its id out of the address bar. The page's own requests to
      // the conversation API carry it, so read it from there instead.
      const conversationId = temporaryConversationId(url, options);
      if (!conversationId) return { kind: 'temporary-pending', conversationId: null, pathname: parsed.pathname, reason: 'temporary chat has no message yet' };
      return { kind: 'conversation', conversationId, pathname: parsed.pathname, routeSegment: 'temporary', temporary: true };
    }
    return { kind: 'not-conversation', conversationId: null, pathname: parsed.pathname, reason: 'no supported conversation route segment' };
  } catch {
    return { kind: 'invalid-url', conversationId: null, pathname: '', reason: 'invalid URL' };
  }
}

function getConversationIdFromUrl(url = globalThis.location?.href ?? '') {
  const route = parseConversationRoute(url);
  return route.kind === 'conversation' ? route.conversationId : null;
}

function isChatGPTHost(locationLike = globalThis.location) {
  const host = locationLike?.hostname ?? '';
  return host === 'chatgpt.com' || host === 'chat.openai.com';
}

function isExporterRoute(url = globalThis.location?.href ?? '') {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'chatgpt.com' && parseConversationRoute(url).kind === 'conversation';
  } catch {
    return false;
  }
}

function redactId(id) {
  const value = String(id ?? '');
  if (!value) return '<missing>';
  return `<id:${value.length}>`;
}

function redactUrl(url, conversationId = '') {
  try {
    const parsed = new URL(url, currentOrigin());
    if (parsed.origin !== currentOrigin()) return '<unrecognized-path>';
    const path = `${parsed.pathname}${parsed.search}`;
    if (!CONVERSATION_PATH_RE.test(path)) return '<unrecognized-path>';
    const segments = parsed.pathname.split('/');
    const id = String(conversationId ?? '');
    if (id && segments[3] === id) segments[3] = redactId(id);
    else if (segments[3]) segments[3] = '<id>';
    return `${segments.join('/')}${parsed.search ? '?…' : ''}`;
  } catch {
    return '<unrecognized-path>';
  }
}

function clearAccessTokenCache() {
  cachedAccessToken = null;
  tokenFetchedAt = 0;
}

function observeLocationChange() {
  const current = globalThis.location?.href ?? '';
  if (!lastObservedLocation) {
    lastObservedLocation = current;
    return false;
  }
  if (current === lastObservedLocation) return false;
  lastObservedLocation = current;
  clearAccessTokenCache();
  return true;
}

function installAuthCacheInvalidation() {
  if (authInvalidationInstalled) return;
  authInvalidationInstalled = true;
  lastObservedLocation = globalThis.location?.href ?? '';
  globalThis.document?.addEventListener?.('visibilitychange', () => {
    if (globalThis.document.hidden) clearAccessTokenCache();
  });
  globalThis.addEventListener?.('popstate', observeLocationChange);
}

function getResourceHints(conversationId = '') {
  try {
    const entries = globalThis.performance?.getEntriesByType?.('resource') ?? [];
    const seen = new Set();
    const hints = [];
    for (const entry of entries) {
      const name = String(entry?.name ?? '');
      let parsed;
      try {
        parsed = new URL(name, currentOrigin());
      } catch {
        continue;
      }
      if (parsed.origin !== currentOrigin()) continue;
      if (!name || (!name.includes('/backend-api/') && !name.includes('/conversation/'))) continue;
      const redacted = redactUrl(name, conversationId);
      if (seen.has(redacted)) continue;
      seen.add(redacted);
      hints.push(redacted);
    }
    return hints.slice(-12);
  } catch {
    return [];
  }
}

function endpointCandidates(conversationId, resourceHints = getResourceHints(conversationId)) {
  const id = encodeURIComponent(conversationId);
  const known = [
    `/backend-api/conversation/${id}`,
    `/backend-api/conversation/${id}?history_and_training_disabled=false`,
  ];
  const resourceDerived = [];
  for (const hint of resourceHints) {
    try {
      const parsed = new URL(hint.replace('?…', ''), currentOrigin());
      if (parsed.origin !== currentOrigin()) continue;
      const pathname = parsed.pathname;
      if (!pathname.includes('/backend-api/') || !pathname.includes('/conversation/')) continue;
      const originalEntries = globalThis.performance?.getEntriesByType?.('resource') ?? [];
      const matching = originalEntries.find((entry) => redactUrl(entry?.name ?? '', conversationId) === hint);
      if (matching?.name) {
        const original = new URL(matching.name, currentOrigin());
        if (original.origin !== currentOrigin()) continue;
        // Only this chat's own requests count. After in-app navigation the buffer still
        // holds the previous chat's request, and fetching it first exported that chat.
        if (original.pathname !== `/backend-api/conversation/${id}`) continue;
        const path = `${original.pathname}${original.search}`;
        if (CONVERSATION_PATH_RE.test(path) && !resourceDerived.includes(path)) resourceDerived.push(path);
      }
    } catch {
      // Ignore resource entries that are not valid URL candidates.
    }
  }
  return [...new Set([...resourceDerived, ...known])].filter((path) => CONVERSATION_PATH_RE.test(path)).slice(0, 4);
}

function getCookie(name) {
  try {
    const cookies = String(globalThis.document?.cookie ?? '').split(';');
    const prefix = `${name}=`;
    const found = cookies.find((cookie) => cookie.trim().startsWith(prefix));
    return found ? decodeURIComponent(found.trim().slice(prefix.length)) : null;
  } catch {
    return null;
  }
}

function findAccountIdInValue(value) {
  if (typeof value !== 'string') return null;
  const bounded = value.slice(0, 262_144);
  const workspace = bounded.match(/\bws-[a-f0-9]{8}-[a-f0-9-]{27,}\b/i)?.[0];
  if (workspace) return workspace;
  const accountKey = bounded.match(/\b(?:account|workspace)[-_]?(?:id)?["'=:\s]+([a-f0-9]{8}-[a-f0-9-]{27,})\b/i)?.[1];
  return accountKey ?? null;
}

function boundedJsonString(value, maxChars = 262_144) {
  let used = 0;
  let stopped = false;
  try {
    return JSON.stringify(value, (key, nested) => {
      if (stopped) return undefined;
      const estimate = typeof nested === 'string' ? nested.length + 2 : 8;
      if (used + estimate > maxChars) {
        stopped = true;
        return undefined;
      }
      used += estimate;
      return nested;
    })?.slice(0, maxChars) ?? '';
  } catch {
    return '';
  }
}

function discoverAccountId() {
  const candidates = new Set();
  const add = (value) => { const found = findAccountIdInValue(value); if (found) candidates.add(found); };
  try {
    add(globalThis.document?.getElementById?.('__NEXT_DATA__')?.textContent?.slice(0, 262_144));
  } catch {
    // Continue with storage and page globals.
  }
  try {
    const storage = globalThis.localStorage;
    const knownKeys = new Set(['chatgpt-account-id', 'chatgpt-account_id', 'chatgpt-workspace-id', 'chatgpt-workspace_id', 'oai-account-id', 'oai-workspace-id', 'account_id', 'workspace_id']);
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index) ?? '';
      if (knownKeys.has(key.toLowerCase())) add(storage.getItem(key));
    }
  } catch {
    // Storage may be unavailable in a restricted execution context.
  }
  try {
    const globals = [globalThis.__INITIAL_STATE__, globalThis.__PRELOADED_STATE__];
    for (const value of globals) add(boundedJsonString(value));
  } catch {
    // Ignore inaccessible page state.
  }
  return candidates.size === 1 ? candidates.values().next().value : null;
}

async function getAccessToken(fetchImpl) {
  if (cachedAccessToken && Date.now() - tokenFetchedAt < TOKEN_TTL_MS) return { token: cachedAccessToken, failure: null };
  clearAccessTokenCache();
  const sessionUrl = new URL('/api/auth/session?unstable_client=true', currentOrigin()).toString();
  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, sessionUrl, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    }, DEFAULT_TIMEOUT_MS);
  } catch (error) {
    if (error?.code === 'timeout') return { token: null, failure: { code: 'session-timeout', message: 'ChatGPT session lookup timed out. Check your connection and retry.' } };
    return { token: null, failure: { code: 'session-network', message: 'The browser could not reach ChatGPT’s session endpoint.' } };
  }
  if (response.status === 401 || response.status === 403) return { token: null, failure: { code: 'signed-out', message: 'No active ChatGPT session was found. Sign in, reload the conversation, and retry.' } };
  if (response.status === 429) return { token: null, failure: { code: 'session-rate-limit', message: 'ChatGPT is rate-limiting the session lookup. Wait briefly and retry.' } };
  if (!response.ok) return { token: null, failure: { code: 'session-http', message: `ChatGPT session lookup failed with HTTP ${response.status}.` } };
  try {
    const session = await response.json();
    const token = session?.accessToken ?? session?.access_token ?? session?.token ?? null;
    if (typeof token === 'string' && token && token.toLowerCase() !== 'dummy') {
      cachedAccessToken = token;
      tokenFetchedAt = Date.now();
      return { token, failure: null };
    }
    return { token: null, failure: { code: 'missing-token', message: 'ChatGPT returned no usable access token. Sign in again, reload the conversation, and retry.' } };
  } catch {
    return { token: null, failure: { code: 'session-malformed', message: 'ChatGPT returned an unreadable session response.' } };
  }
}

async function getAuthContext(fetchImpl = globalThis.fetch) {
  const access = await getAccessToken(fetchImpl);
  const accessToken = access.token;
  const deviceId = getCookie('oai-did') ?? getCookie('oai-device-id');
  const accountId = discoverAccountId();
  return {
    hasAccessToken: Boolean(accessToken),
    hasDeviceId: Boolean(deviceId),
    hasAccountId: Boolean(accountId),
    authFailure: access.failure,
    headers: {
      Accept: 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(deviceId ? { 'oai-device-id': deviceId } : {}),
      ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
    },
  };
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new ChatGPTClientError('timeout', `ChatGPT did not respond within ${timeoutMs / 1000} seconds.`, { url });
    }
    throw new ChatGPTClientError('network', 'The browser could not reach ChatGPT.', { url, cause: error?.message });
  } finally {
    clearTimeout(timer);
  }
}

async function safeResponseHint(response) {
  try {
    const clone = response.clone?.();
    if (!clone || !String(clone.headers?.get?.('content-type') ?? '').includes('json')) return null;
    const body = await clone.json();
    const values = [body?.error, body?.detail, body?.message, body?.code, body?.type]
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => value.replace(/[A-Fa-f0-9]{8}-[A-Fa-f0-9-]{27,}/g, '<id>').replace(/\s+/g, ' ').slice(0, 160));
    return values.length ? [...new Set(values)].join(' | ') : null;
  } catch {
    return null;
  }
}

function errorForStatus(status, url, details = {}) {
  if (status === 401 || status === 403) return new ChatGPTClientError('auth', `ChatGPT rejected the conversation request (${status}). Sign in again, then retry.`, { status, url, ...details });
  if (status === 404) return new ChatGPTClientError('not-found', 'The conversation request returned 404. The route ID or internal request path may have changed.', { status, url, ...details });
  if (status === 429) return new ChatGPTClientError('rate-limit', 'ChatGPT is rate-limiting the request. Wait briefly and retry.', { status, url, ...details });
  if (status >= 500) return new ChatGPTClientError('server', `ChatGPT returned a server error (${status}).`, { status, url, ...details });
  return new ChatGPTClientError('http', `ChatGPT returned HTTP ${status}.`, { status, url, ...details });
}

async function fetchConversation(conversationId, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!conversationId) throw new ChatGPTClientError('missing-id', 'No conversation ID was found in the current URL. Open a chat before exporting.');
  if (typeof fetchImpl !== 'function') throw new ChatGPTClientError('no-fetch', 'This browser does not provide fetch().');

  observeLocationChange();
  const route = parseConversationRoute(globalThis.location?.href ?? '');
  const resourceHints = getResourceHints(conversationId);
  const candidates = endpointCandidates(conversationId, resourceHints);
  let auth = await getAuthContext(fetchImpl);
  const authSummary = { hasAccessToken: auth.hasAccessToken, hasDeviceId: auth.hasDeviceId, hasAccountId: auth.hasAccountId };
  if (auth.authFailure) {
    throw new ChatGPTClientError(auth.authFailure.code, auth.authFailure.message, { route, parsedId: redactId(conversationId), resourceHints, auth: authSummary });
  }
  let lastError = null;
  let authRefreshAttempted = false;
  const attempted = [];

  for (const path of candidates) {
    const url = new URL(path, currentOrigin()).toString();
    attempted.push(redactUrl(url, conversationId));
    let response;
    try {
      response = await fetchWithTimeout(fetchImpl, url, {
        method: 'GET',
        credentials: 'same-origin',
        headers: auth.headers,
        cache: 'no-store',
      }, timeoutMs);
    } catch (error) {
      lastError = error;
      continue;
    }

    if ((response.status === 401 || response.status === 403) && !authRefreshAttempted) {
      authRefreshAttempted = true;
      clearAccessTokenCache();
      auth = await getAuthContext(fetchImpl);
      if (auth.authFailure) {
        throw new ChatGPTClientError(auth.authFailure.code, auth.authFailure.message, { route, parsedId: redactId(conversationId), attempted, resourceHints, auth: { hasAccessToken: auth.hasAccessToken, hasDeviceId: auth.hasDeviceId, hasAccountId: auth.hasAccountId } });
      }
      try {
        response = await fetchWithTimeout(fetchImpl, url, {
          method: 'GET',
          credentials: 'same-origin',
          headers: auth.headers,
          cache: 'no-store',
        }, timeoutMs);
      } catch (error) {
        lastError = error;
        continue;
      }
    }

    if (!response.ok) {
      const responseHint = response.status >= 400 && response.status < 500 ? await safeResponseHint(response) : null;
      const error = errorForStatus(response.status, url, {
        ...(responseHint ? { responseHint } : {}),
        route,
        parsedId: redactId(conversationId),
        attempted,
        resourceHints,
        auth: { hasAccessToken: auth.hasAccessToken, hasDeviceId: auth.hasDeviceId, hasAccountId: auth.hasAccountId },
      });
      if (response.status === 400 || response.status === 404) {
        lastError = error;
        continue;
      }
      throw error;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('json')) {
      throw new ChatGPTClientError('content-type', 'The conversation request did not return JSON.', { contentType, url: redactUrl(url, conversationId), route, attempted, resourceHints, auth: { hasAccessToken: auth.hasAccessToken, hasDeviceId: auth.hasDeviceId, hasAccountId: auth.hasAccountId } });
    }
    try {
      return await response.json();
    } catch (error) {
      throw new ChatGPTClientError('invalid-json', 'ChatGPT returned malformed JSON.', { url: redactUrl(url, conversationId), route, attempted, resourceHints, auth: { hasAccessToken: auth.hasAccessToken, hasDeviceId: auth.hasDeviceId, hasAccountId: auth.hasAccountId }, cause: error?.message });
    }
  }

  if (lastError instanceof ChatGPTClientError) {
    lastError.details = { ...lastError.details, route, parsedId: redactId(conversationId), attempted, resourceHints, auth: { hasAccessToken: auth.hasAccessToken, hasDeviceId: auth.hasDeviceId, hasAccountId: auth.hasAccountId } };
    throw lastError;
  }
  throw new ChatGPTClientError('unavailable', 'No conversation request endpoint succeeded.', { route, parsedId: redactId(conversationId), attempted, resourceHints, auth: { hasAccessToken: auth.hasAccessToken, hasDeviceId: auth.hasDeviceId, hasAccountId: auth.hasAccountId } });
}

function redactRoutePath(route) {
  const pathname = String(route?.pathname ?? '');
  if (!pathname) return '<unknown-path>';
  const parts = pathname.split('/');
  if (parts[1] === 'g') {
    if (parts[2]) {
      let projectId = parts[2];
      try { projectId = decodeURIComponent(projectId); } catch {
        projectId = '';
      }
      parts[2] = redactId(projectId);
    }
    if (parts[3] === 'c' && parts[4]) {
      let conversationId = parts[4];
      try { conversationId = decodeURIComponent(conversationId); } catch {
        conversationId = '';
      }
      parts[4] = redactId(conversationId);
    }
    return parts.join('/');
  }
  const routeIndex = parts.findIndex((part) => part === 'c' || part === 's' || part === 'conversation' || part === 'share');
  if (routeIndex >= 0 && parts[routeIndex + 1]) {
    let decoded = parts[routeIndex + 1];
    try { decoded = decodeURIComponent(decoded); } catch {
      decoded = '';
    }
    parts[routeIndex + 1] = redactId(decoded);
  }
  return parts.join('/');
}

function describeClientError(error) {
  if (!(error instanceof ChatGPTClientError)) return error?.message ?? String(error);
  const details = error.details ?? {};
  const lines = [error.message];
  if (details.route?.pathname) lines.push(`Page path: ${redactRoutePath(details.route)}`);
  if (details.parsedId) lines.push(`Parsed ID: ${details.parsedId}`);
  if (details.auth) lines.push(`Auth context: token=${details.auth.hasAccessToken ? 'yes' : 'no'}, device=${details.auth.hasDeviceId ? 'yes' : 'no'}, account=${details.auth.hasAccountId ? 'yes' : 'no'}`);
  if (Array.isArray(details.attempted) && details.attempted.length) lines.push(`Tried: ${details.attempted.join(' | ')}`);
  if (details.responseHint) lines.push(`Response hint: ${details.responseHint}`);
  if (Array.isArray(details.resourceHints) && details.resourceHints.length) lines.push(`Page request hints: ${details.resourceHints.join(' | ')}`);
  if (error.code === 'not-found' && (!details.resourceHints || details.resourceHints.length === 0)) lines.push('Reload the conversation with DevTools Network open and retry; the current page request path may need to be added.');
  return lines.join('\n');
}

const CLAUDE_TIMEOUT_MS = 20_000;
const CLAUDE_ROUTE_RE = /^\/chat\/[A-Za-z0-9_-]{16,120}$/;

class ClaudeClientError extends Error {
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

function installClaudeIncognitoObserver() {
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

function parseClaudeConversationRoute(url = globalThis.location?.href ?? '', options = {}) {
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

function getClaudeConversationIdFromUrl(url = globalThis.location?.href ?? '') {
  const route = parseClaudeConversationRoute(url);
  return route.kind === 'conversation' ? route.conversationId : null;
}

function isClaudeHost(locationLike = globalThis.location) {
  return locationLike?.hostname === 'claude.ai';
}

function isClaudeExporterRoute(url = globalThis.location?.href ?? '') {
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

function getClaudeOrganizationId() {
  return getClaudeCookie('lastActiveOrg');
}

const CLAUDE_ORG_RE = /^[A-Za-z0-9_-]{1,200}$/;
const CLAUDE_CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{16,120}$/;
const CLAUDE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FALLBACK_ORGANIZATIONS = 5;

function claudeConversationPath(organizationId, conversationId) {
  const org = String(organizationId ?? '');
  const id = String(conversationId ?? '');
  if (!CLAUDE_ORG_RE.test(org) || !CLAUDE_CONVERSATION_ID_RE.test(id)) return null;
  const query = 'tree=true&rendering_mode=messages&render_all_tools=true';
  return `/api/organizations/${encodeURIComponent(org)}/chat_conversations/${encodeURIComponent(id)}?${query}`;
}

// What a 404 report may say about the conversation id: whether it is a chat UUID, and a
// short type prefix such as `cse_` when it has one. Never the id itself.
function claudeIdFormat(conversationId) {
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

function redactClaudePath(pathname, conversationId = '') {
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
function claudeRequestShapes(conversationId, entries = null, limit = 8, own = claudeOwnRequests) {
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

async function fetchClaudeConversation(conversationId, { fetchImpl = globalThis.fetch, timeoutMs = CLAUDE_TIMEOUT_MS, organizationId = getClaudeOrganizationId(), resourceEntries = null } = {}) {
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

function normalizeClaudeConversation(raw, conversationId = null) {
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

function describeClaudeError(error) {
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

// No size or count budget is applied by default: what gets embedded is the
// user's explicit selection in the image chooser, which shows each image's size
// and a running total. A caller may still pass a finite `limits` object.
const IMAGE_LIMITS = Object.freeze({ perImageBytes: Infinity, totalBytes: Infinity, embeddedImageCount: Infinity });
const RETRY_AFTER_MIN_MS = 1_000;
const RETRY_AFTER_MAX_MS = 15_000;
const RETRY_AFTER_DEFAULT_MS = 5_000;

function describeByteLimit(bytes) {
  return Number.isFinite(bytes) ? `${Math.round(bytes / (1024 * 1024))} MiB` : 'unlimited';
}

function retryDelayMs(headerValue) {
  const seconds = Number(String(headerValue ?? '').trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return RETRY_AFTER_DEFAULT_MS;
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, Math.round(seconds * 1000)));
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function applyImageBudget(result, { embeddedCount = 0, imageBytes = 0 } = {}, limits = IMAGE_LIMITS) {
  if (result?.status !== 'embedded') return result;
  if (embeddedCount >= limits.embeddedImageCount) return { status: 'unavailable', reason: `export exceeds the ${limits.embeddedImageCount} embedded-image limit`, budgetLimited: true };
  if (imageBytes + (result.byteLength ?? 0) > limits.totalBytes) return { status: 'unavailable', reason: `export exceeds the ${describeByteLimit(limits.totalBytes)} total embedded image budget`, budgetLimited: true };
  return result;
}
const IMAGE_MIME_RE = /^image\/(?:png|jpe?g|webp|gif|avif|bmp|svg\+xml)$/i;
const FILE_ID_RE = /file[-_][A-Za-z0-9_-]{4,200}/i;

function assetFileId(pointer) {
  const value = String(pointer ?? '');
  return value.match(FILE_ID_RE)?.[0] ?? null;
}

function safeImageMime(value) {
  const mime = String(value ?? '').split(';', 1)[0].trim().toLowerCase();
  return IMAGE_MIME_RE.test(mime) ? mime : null;
}

function currentAssetOrigin() {
  return globalThis.location?.origin ?? 'https://chatgpt.com';
}

async function fetchAssetWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    const wrapped = new Error(error?.name === 'AbortError' ? 'asset request timed out' : 'asset request failed');
    wrapped.code = error?.name === 'AbortError' ? 'timeout' : 'network';
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
}

function allowedAssetUrl(raw) {
  try {
    const url = new URL(raw, currentAssetOrigin());
    if (url.origin !== currentAssetOrigin()) return null;
    const pathname = url.pathname.replace(/\/$/, '');
    const isEstuary = pathname === '/backend-api/estuary/content';
    if (!isEstuary) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function imageRequestCandidates(fileId, conversationId, postId) {
  const fid = encodeURIComponent(fileId);
  const cid = encodeURIComponent(conversationId ?? '');
  const candidates = [
    `/backend-api/files/download/${fid}?post_id=&inline=false`,
    `/backend-api/files/${fid}/${cid}?conversation_id=${cid}&download_intent=download&include_library_file_state=true&inline=false`,
  ];
  if (postId) candidates.push(`/backend-api/files/${fid}/${cid}?download_intent=download&inline=false&post_id=${encodeURIComponent(postId)}`);
  candidates.push(
    `/backend-api/files/${fid}/${cid}?download_intent=download&inline=false`,
    `/backend-api/files/download/${fid}?conversation_id=${cid}&inline=false`,
    `/backend-api/files/${fid}/${cid}`,
    `/backend-api/files/${fid}/simple`,
  );
  return candidates;
}

function asAssetResult(status, reason, extra = {}) {
  return { status, reason, ...extra };
}

function dataImageResult(pointer, remainingBytes = Infinity, limits = IMAGE_LIMITS) {
  const value = String(pointer ?? '');
  const match = value.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match || !safeImageMime(match[1])) return null;
  const byteLength = Math.floor((match[2].length * 3) / 4) - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0);
  if (byteLength > limits.perImageBytes) return asAssetResult('unavailable', `image exceeds the ${describeByteLimit(limits.perImageBytes)} embedded size limit`);
  if (byteLength > remainingBytes) return asAssetResult('unavailable', `image exceeds the ${describeByteLimit(limits.totalBytes)} total embedded image budget`, { budgetLimited: true });
  return asAssetResult('embedded', null, { dataUrl: value, mimeType: safeImageMime(match[1]), byteLength });
}

async function readJsonResponse(response) {
  try {
    const contentType = String(response.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.includes('json')) return null;
    const value = await response.json();
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function candidateDownloadUrl(value) {
  const queue = [{ value, depth: 0 }];
  const seen = new Set();
  const preferredKeys = new Set(['download_url', 'downloadUrl', 'url', 'file_url', 'content_url', 'image_url', 'thumbnail_url', 'asset_pointer_link', 'watermarked_asset_pointer']);
  let inspected = 0;
  while (queue.length && inspected < 64) {
    const current = queue.shift();
    const item = current.value;
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    inspected += 1;
    for (const [key, raw] of Object.entries(item)) {
      if (typeof raw === 'string' && raw.trim() && (preferredKeys.has(key) || raw.includes('/backend-api/estuary/content'))) {
        const allowed = allowedAssetUrl(raw);
        if (allowed) return allowed;
      }
      if (current.depth < 4 && raw && typeof raw === 'object') queue.push({ value: raw, depth: current.depth + 1 });
    }
  }
  return null;
}

// Exports are no longer capped, so a long run may be throttled part-way
// through. Back off once on the provider's own terms rather than dropping an
// image the user explicitly asked for. Covers both the metadata probe and the
// byte fetch, since either can be the request that gets a 429.
async function requestAsset(fetchImpl, url, headers, timeoutMs, sleep = defaultSleep) {
  const send = () => fetchAssetWithTimeout(fetchImpl, url, {
    method: 'GET',
    credentials: 'same-origin',
    headers,
    cache: 'no-store',
  }, timeoutMs);
  const response = await send();
  if (response.status !== 429) return response;
  await sleep(retryDelayMs(response.headers.get('retry-after')));
  return send();
}

function bytesToDataUrl(bytes, mime) {
  let binary = '';
  const chunkSize = 0x2000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

async function fetchImageBytes(fetchImpl, url, headers, timeoutMs, remainingBytes = Infinity, limits = IMAGE_LIMITS, sleep = defaultSleep) {
  return readImageResponse(await requestAsset(fetchImpl, url, headers, timeoutMs, sleep), remainingBytes, limits);
}

async function readImageResponse(response, remainingBytes = Infinity, limits = IMAGE_LIMITS) {
  if (!response.ok) return asAssetResult('unavailable', `asset HTTP ${response.status}`);
  const contentType = safeImageMime(response.headers.get('content-type'));
  if (!contentType) return asAssetResult('unavailable', 'asset response was not a supported image');
  const declaredSize = Number(response.headers.get('content-length'));
  const tooLarge = `image exceeds the ${describeByteLimit(limits.perImageBytes)} embedded size limit`;
  const overBudget = `image exceeds the ${describeByteLimit(limits.totalBytes)} total embedded image budget`;
  if (Number.isFinite(declaredSize) && declaredSize > limits.perImageBytes) return asAssetResult('unavailable', tooLarge);
  if (Number.isFinite(declaredSize) && declaredSize > remainingBytes) return asAssetResult('unavailable', overBudget, { budgetLimited: true });
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > limits.perImageBytes) return asAssetResult('unavailable', tooLarge);
  if (buffer.byteLength > remainingBytes) return asAssetResult('unavailable', overBudget, { budgetLimited: true });
  const bytes = new Uint8Array(buffer);
  return asAssetResult('embedded', null, { dataUrl: bytesToDataUrl(bytes, contentType), mimeType: contentType, byteLength: buffer.byteLength });
}

async function resolveOneImage(asset, context) {
  const { conversationId, postId, auth, fetchImpl, timeoutMs, remainingBytes, limits = IMAGE_LIMITS, sleep = defaultSleep } = context;
  const pointer = String(asset?.pointer ?? '');
  if (!pointer) return asAssetResult('unavailable', 'image asset pointer is missing');
  const embedded = dataImageResult(pointer, remainingBytes, limits);
  if (embedded) return embedded;
  const direct = allowedAssetUrl(pointer);
  if (direct) return fetchImageBytes(fetchImpl, direct, auth.headers, timeoutMs, remainingBytes, limits, sleep);

  const fileId = assetFileId(pointer);
  if (!fileId) return asAssetResult('unavailable', 'no file identifier was found in the image asset pointer');
  const candidates = imageRequestCandidates(fileId, conversationId, postId);
  let lastReason = 'no image download URL was returned';
  for (const path of candidates) {
    let response;
    try {
      response = await requestAsset(fetchImpl, new URL(path, currentAssetOrigin()).toString(), auth.headers, timeoutMs, sleep);
    } catch (error) {
      lastReason = error?.code === 'timeout' ? 'asset request timed out' : 'asset request failed';
      continue;
    }
    if (!response.ok) {
      lastReason = `asset metadata HTTP ${response.status}`;
      if (response.status === 401 || response.status === 403 || response.status === 429) break;
      continue;
    }
    const directMime = safeImageMime(response.headers.get('content-type'));
    if (directMime) {
      // This request already returned the image itself; reading it saves a second download.
      const result = await readImageResponse(response, remainingBytes, limits);
      if (result.status === 'embedded' || result.budgetLimited) return result;
      lastReason = result.reason;
      continue;
    }
    const metadata = await readJsonResponse(response);
    const downloadUrl = candidateDownloadUrl(metadata);
    if (!downloadUrl) {
      lastReason = 'asset metadata had no approved same-origin estuary image URL';
      continue;
    }
    const result = await fetchImageBytes(fetchImpl, downloadUrl, auth.headers, timeoutMs, remainingBytes, limits, sleep);
    if (result.status === 'embedded') return result;
    if (result.budgetLimited) return result;
    lastReason = result.reason;
  }
  return asAssetResult('unavailable', lastReason, { fileId });
}

// Confirmed against a live Claude conversation on 2026-09-18: an uploaded image sits on
// `message.files[]` with `preview_url` and `thumbnail_url`, both same-origin routes of
// this shape that return image bytes directly to the signed-in session. Nothing else is
// accepted, so a URL that appears anywhere else in the payload cannot make the exporter
// fetch it.
const CLAUDE_IMAGE_ROUTE_RE = /^\/api\/[A-Za-z0-9_-]{1,120}\/files\/[A-Za-z0-9_-]{1,120}\/(?:preview|thumbnail)$/;

function allowedClaudeAssetUrl(raw) {
  try {
    const url = new URL(String(raw ?? ''), globalThis.location?.origin ?? 'https://claude.ai');
    if (url.hostname !== 'claude.ai') return null;
    if (!CLAUDE_IMAGE_ROUTE_RE.test(url.pathname.replace(/\/$/, ''))) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function resolveClaudeImage(asset, context) {
  const { fetchImpl, timeoutMs, remainingBytes, limits = IMAGE_LIMITS, sleep = defaultSleep } = context;
  const pointer = String(asset?.pointer ?? '');
  if (!pointer) return asAssetResult('unavailable', 'image asset pointer is missing');
  const url = allowedClaudeAssetUrl(pointer);
  if (!url) return asAssetResult('unavailable', 'image URL is not an approved same-origin Claude file route');
  // The session cookie carries the authorization; no bearer token is minted or read.
  return fetchImageBytes(fetchImpl, url, {}, timeoutMs, remainingBytes, limits, sleep);
}

function resolveClaudeConversationImages(conversation, options = {}) {
  return resolveConversationImages(conversation, { ...options, resolveOne: resolveClaudeImage, requiresAuth: false });
}

// Claude's uploaded images are a plain same-origin URL that already returns the bytes,
// while ChatGPT's are a pointer that has to be traded for a download URL. Everything
// around that — selection, budget, caching, the stats the header reports — is identical,
// so the provider difference is one injected function rather than a second pipeline.
// Image totals for the messages an export actually shows, read from each block's resolved
// status. An all-branches export uses this so an image in a shared message counts once.
function summarizeImageStats(messages) {
  const images = (Array.isArray(messages) ? messages : []).flatMap((message) => (message?.textBlocks ?? []).filter((block) => block.type === 'image'));
  const embedded = images.filter((block) => block.asset?.status === 'embedded');
  const excluded = images.filter((block) => block.asset?.status === 'excluded').length;
  return {
    imageCount: images.length,
    imageEmbeddedCount: embedded.length,
    imageExcludedCount: excluded,
    imageUnavailableCount: images.length - embedded.length - excluded,
    imageBytes: embedded.reduce((sum, block) => sum + Number(block.asset?.byteLength ?? 0), 0),
    imageBudgetLimitedCount: images.filter((block) => block.asset?.budgetLimited).length,
  };
}

async function resolveConversationImages(conversation, { fetchImpl = globalThis.fetch, conversationId, timeoutMs = 20_000, onProgress, limits = IMAGE_LIMITS, authContext = null, includeImages = true, selectedImageIndices = null, imageIndexOffset = 0, sleep = defaultSleep, resolveOne = resolveOneImage, requiresAuth = true, imageCache = new Map() } = {}) {
  if (!conversation || !Array.isArray(conversation.messages)) return conversation;
  const imageBlocks = conversation.messages.flatMap((message) => (message.textBlocks ?? []).filter((block) => block.type === 'image').map((block) => ({ block, postId: message.id })));
  if (imageBlocks.length === 0) return { ...conversation, stats: { ...conversation.stats, imageCount: 0, imageEmbeddedCount: 0, imageExcludedCount: 0, imageUnavailableCount: 0, imageBytes: 0, imageBudgetLimitedCount: 0 } };

  const selected = selectedImageIndices === null ? null : new Set(selectedImageIndices);
  const safeImageIndexOffset = Number.isInteger(imageIndexOffset) && imageIndexOffset >= 0 ? imageIndexOffset : 0;
  const shouldInclude = (index) => Boolean(includeImages) && (selected === null || selected.has(index + safeImageIndexOffset));
  const shouldResolveAny = Boolean(includeImages) && (selected === null || selected.size > 0);
  const auth = shouldResolveAny && requiresAuth ? (authContext ?? await getAuthContext(fetchImpl)) : null;
  const cache = imageCache;
  const occurrenceResults = [];
  let completed = 0;
  let embeddedCount = 0;
  let excludedCount = 0;
  let unavailableCount = 0;
  let imageBytes = 0;
  let budgetLimitedCount = 0;
  for (let index = 0; index < imageBlocks.length; index += 1) {
    const block = imageBlocks[index];
    let result;
    if (!shouldInclude(index)) {
      result = asAssetResult('excluded', 'image excluded by export settings');
      excludedCount += 1;
    } else {
      const pointer = String(block.block.asset?.pointer ?? '');
      if (!cache.has(pointer)) {
        const budgetExhausted = embeddedCount >= limits.embeddedImageCount || imageBytes >= limits.totalBytes;
        cache.set(pointer, budgetExhausted
          ? asAssetResult('unavailable', embeddedCount >= limits.embeddedImageCount ? `export exceeds the ${limits.embeddedImageCount} embedded-image limit` : `export exceeds the ${describeByteLimit(limits.totalBytes)} total embedded image budget`, { budgetLimited: true })
          : await resolveOne(block.block.asset, { conversationId, postId: block.postId, auth, fetchImpl, timeoutMs, remainingBytes: limits.totalBytes - imageBytes, limits, sleep }));
      }
      result = cache.get(pointer) ?? asAssetResult('unavailable', 'image resolution did not run');
      const budgetedResult = applyImageBudget(result, { embeddedCount, imageBytes }, limits);
      if (budgetedResult !== result) result = budgetedResult;
      if (result.status === 'embedded') {
        embeddedCount += 1;
        imageBytes += result.byteLength ?? 0;
      } else {
        unavailableCount += 1;
        if (result.budgetLimited) budgetLimitedCount += 1;
      }
    }
    occurrenceResults.push(result);
    completed += 1;
    onProgress?.(completed, imageBlocks.length);
  }

  let imageIndex = 0;
  const messages = conversation.messages.map((message) => ({
    ...message,
    textBlocks: (message.textBlocks ?? []).map((block) => {
      if (block.type !== 'image') return block;
      const result = occurrenceResults[imageIndex++] ?? asAssetResult('unavailable', 'image resolution did not run');
      return { ...block, asset: { ...block.asset, ...result } };
    }),
  }));
  return {
    ...conversation,
    messages,
    stats: { ...conversation.stats, imageCount: imageBlocks.length, imageEmbeddedCount: embeddedCount, imageExcludedCount: excludedCount, imageUnavailableCount: unavailableCount, imageBytes, imageBudgetLimitedCount: budgetLimitedCount },
  };
}

function statText(message) {
  return (message?.textBlocks ?? [])
    .filter((block) => block.type === 'text' || block.type === 'code')
    .map((block) => String(block.text ?? ''))
    .join('\n');
}

function wordCount(text) {
  const value = String(text ?? '').trim();
  return value ? value.split(/\s+/u).length : 0;
}

function safeModelIdentifier(value) {
  const model = String(value ?? '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(model) ? model : null;
}

// The text every local count is taken from: each message's text and code blocks, in order.
function exportStatsText(messages) {
  return (Array.isArray(messages) ? messages : []).map(statText).filter(Boolean).join('\n');
}

function deriveExportStats(messages, baseStats = {}, { model = null } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const text = exportStatsText(list);
  const modelsUsed = [...new Set([
    safeModelIdentifier(model),
    ...list.map((message) => safeModelIdentifier(message?.modelSlug)),
  ].filter(Boolean))];
  const textBlockCount = list.reduce((sum, message) => sum + (message?.textBlocks ?? []).filter((block) => block.type === 'text' || block.type === 'code').length, 0);
  const assistantMessages = list.filter((message) => message.role === 'assistant');
  return {
    ...baseStats,
    messageCount: list.length,
    userMessageCount: list.filter((message) => message.role === 'user').length,
    assistantMessageCount: assistantMessages.length,
    replyModelCount: assistantMessages.filter((message) => safeModelIdentifier(message?.modelSlug)).length,
    toolMessageCount: list.filter((message) => message.role === 'tool').length,
    textBlockCount,
    wordCount: wordCount(text),
    characterCount: [...text].length,
    modelsUsed,
  };
}

// Local token estimate for ChatGPT exports (v0.18.0).
//
// ChatGPT's current models (GPT-4o, GPT-4.1, the o-series and the GPT-5 family) use
// OpenAI's o200k_base tokenizer. Its vocabulary would add about 2.4 MB to this script,
// so the count is estimated instead:
//
// 1. Split the text exactly as o200k_base does before it encodes anything.
//    O200K_PIECE_PATTERN is the tokenizer's own pre-tokenizer pattern from OpenAI's
//    tiktoken (contractions spelled out instead of the `(?i:…)` group). No token crosses
//    two pieces, so the text's count is the sum of its pieces' counts.
// 2. Sort each piece into a family (letters by script, case and what comes before them;
//    digits; spaces; line breaks; punctuation and symbols) and measure its length, then
//    look up the average token count measured for that family and length against the
//    real tokenizer. Pieces longer than the table use a per-character rate.
// 3. Paragraphs that read as code use their own families. In other paragraphs, count very
//    common words of a few languages (kana and Han letters for Japanese and Chinese).
//    Where one language clearly leads, scale the paragraph's word pieces by the factors
//    measured for it, because the same script splits differently from one language to
//    the next.
//
// O200K_TABLE is generated by tools/fit-token-estimate.mjs; docs/maintenance-notes.md
// says how. Everything here is local: it counts only the text it is given, makes no
// request, and is never a provider token, billing or context-window figure.

const O200K_PIECE_PATTERN = /[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])?|[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]+[\p{Ll}\p{Lm}\p{Lo}\p{M}]*(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])?|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n/]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;
const O200K_LETTERS = /[\p{L}\p{M}]/gu;
const O200K_LETTER = /[\p{L}\p{M}]/u;
const O200K_UPPER = /\p{Lu}/u;
const O200K_DIGIT = /\p{N}/u;
const O200K_ASCII_LETTER = /[A-Za-z]/;
const O200K_NON_ASCII = /[^\x00-\x7f]/;
const O200K_BLANK_LINE = /\n[^\S\n]*\n/;
const O200K_KANA_LETTERS = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const O200K_HAN_LETTERS = /\p{Script=Han}/gu;
const O200K_LEADING_NON_LETTERS = /^[^\p{L}]+/u;
const O200K_ACCENTED_LATIN = /(?![A-Za-z])\p{Script=Latin}/gu;
// Braces, semicolons, `=`, angle and square brackets, or an empty `()`. Plain parentheses
// are left out because prose uses them too.
const O200K_CODE_MARK = /[{};=<>[\]]|\(\)/;
const O200K_SCRIPTS = [
  ['latin', /\p{Script=Latin}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['greek', /\p{Script=Greek}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['hebrew', /\p{Script=Hebrew}/u],
  ['devanagari', /\p{Script=Devanagari}/u],
  ['bengali', /\p{Script=Bengali}/u],
  ['tamil', /\p{Script=Tamil}/u],
  ['indic', /[\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}]/u],
  ['han', /\p{Script=Han}/u],
  ['kana', /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ['hangul', /\p{Script=Hangul}/u],
  ['thai', /\p{Script=Thai}/u],
];
// Pieces of this many letters or more use the family's per-character rate.
const O200K_LENGTH_CAP = 16;
// Very common words that are rare in the other listed languages. Words that also turn up in
// English or in code (`el`, `del`, `os`, `no`, `do`, `per`, `come`, `van`, `door`, single
// letters) are left out. Japanese is recognised by its kana instead. A paragraph needs at
// least two hits, and 1.5 times the runner-up, to count as one language.
const O200K_LANGUAGE_HINTS = {
  en: 'the and of that with this was are you have from which what would there their been were they these about should could will your',
  es: 'los las por una pero más también muy fue sus está este esta entre sobre cuando hasta porque aunque donde ellos',
  fr: 'le les des est une dans pour pas qui sur avec sont cette aux du et au été ont mais leur comme',
  de: 'der die und das ist nicht mit den ein eine auf sich dem auch wird sind für von wurde zu im',
  it: 'il della che non sono gli dei nel alla anche questo è delle più stato degli questa essere quando molto',
  pt: 'não uma com são mais dos pelo pela também muito foi seu sua ao à você isso pelos',
  nl: 'het een niet zijn voor worden wordt ook deze naar bij maar werd heeft hebben nog zoals tussen',
  pl: 'się nie jest że jak ale przez oraz jego był są który która które może tylko jako tego jednak',
  tr: 'bir ve bu için ile olarak olan çok daha gibi ancak sonra kadar ise değil',
  vi: 'và của là có được trong những các cho không này với một người đã khi từ',
  id: 'yang dengan untuk dalam ini itu dari pada adalah tidak akan oleh juga sebagai atau bahwa karena tersebut dapat telah',
  ru: 'и в не на что с по это как его для из был от но также который',
  uk: 'і в не на що з до це як його для від але також який був та у',
  ar: 'في من على إلى أن التي الذي عن مع هذا كان هذه لا ما بين',
  fa: 'و در به از که این را با است برای آن یک می شده بر تا',
  hi: 'के में की है और से को का एक पर यह भी हैं किया लिए नहीं था गया',
  mr: 'आणि आहे या व हे ही मध्ये होते केले करण्यात म्हणून असे आहेत तसेच',
};
let o200kHintWords = null;

// BEGIN GENERATED O200K_TABLE (tools/fit-token-estimate.mjs)
// families: average tokens by length from 1 character up, then tokens per character.
// languages: factors for word pieces of 1–3, 4–7 and 8 or more letters.
const O200K_TABLE = {
  families: {
    'arabic.n': [1, 1.039, 1.485, 2.082, 2.576, 2.823, 3.102, 3.5, 4.091, 4.393, 0.487],
    'arabic.p': [1.375, 1.185, 1.36, 2.044, 2.907, 3.205, 3.723, 4.101, 0.516],
    'arabic.s': [1, 1.003, 1.121, 1.444, 1.781, 2.145, 2.266, 2.703, 3.251, 3.656, 4.227, 4.788, 5.797, 7.627, 0.706],
    'bengali.n': [1, 1.532, 1.959, 2.336, 2.721, 3.448, 3.844, 3.69, 4.305, 5.033, 5.21, 0.429],
    'bengali.p': [1.643, 1.499, 2.271, 3.232, 3.659, 4.022, 4.332, 4.805, 5.478, 0.647],
    'bengali.s': [1, 1.047, 1.166, 1.485, 1.916, 2.365, 2.759, 3.01, 3.59, 4.011, 4.404, 4.609, 5.458, 5.402, 6.302, 0.419],
    'code.cyrillic.s': [1, 0.276],
    'code.digits': [1, 1],
    'code.latin.nC': [1, 1, 1.025, 1.01, 1.019, 1.014, 1.04, 1.031, 1.318, 1.187, 1.36, 1.062, 0.193],
    'code.latin.nU': [1, 1, 1.088, 1.217, 1.613, 1.808, 1.346, 2, 0.038],
    'code.latin.nl': [1, 1, 1.084, 1.012, 1.059, 1.075, 1.29, 1.158, 1.348, 1.521, 1.725, 1.279, 0.203],
    'code.latin.pC': [1.333, 1.079, 1.132, 1.199, 1.537, 1.436, 1.592, 2.3, 0.337],
    'code.latin.pU': [1, 1.008, 1.357, 1.231, 1.32, 2.249, 1.895, 2.303, 2.198, 0.324],
    'code.latin.pl': [1.024, 1.078, 1.089, 1.097, 1.1, 1.195, 1.276, 1.449, 1.882, 1.836, 1.904, 2.236, 2.05, 0.176],
    'code.latin.sC': [1, 1.037, 1, 1.02, 1.065, 1.036, 1.215, 1.279, 1.487, 0.217],
    'code.latin.sU': [1, 1, 1.024, 1.183, 1.376, 2.164, 1.695, 2.395, 0.308],
    'code.latin.sl': [1, 1, 1.005, 1.005, 1.006, 1.041, 1.041, 1.061, 1.159, 1.144, 1.259, 1.111, 0.188],
    'code.newline': [1, 1, 1, 1, 0.156],
    'code.punct': [1, 1.006, 1.143, 1.686, 2.112, 2.503, 3.353, 3.63, 4.423, 4.864, 0.359],
    'code.punct.s': [1, 1.017, 1.109, 1.502, 2.067, 2.314, 0.095],
    'code.punct.su': [1, 1],
    'code.punctu': [1.143, 0.72],
    'code.space': [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.043],
    'cyrillic.n': [1, 1.161, 1.485, 2.205, 2.43, 2.761, 3.147, 3.115, 3.626, 3.925, 4.131, 4.218, 4.58, 4.969, 4.846, 0.338],
    'cyrillic.p': [1.305, 1.64, 2.171, 2.327, 2.903, 3.189, 3.488, 3.83, 4.233, 4.613, 4.581, 4.612, 4.482, 5.019, 5.071, 0.363],
    'cyrillic.s': [1, 1.054, 1.167, 1.419, 1.768, 2.01, 2.212, 2.476, 2.735, 2.835, 3.088, 3.083, 3.245, 3.321, 3.75, 0.275],
    'devanagari.n': [1, 1.112, 1.945, 2.226, 2.515, 3.168, 3.617, 4.012, 4.195, 4.806, 4.788, 5.512, 0.463],
    'devanagari.p': [1.909, 2, 2.301, 2.933, 3.264, 3.753, 4.008, 4.188, 4.717, 5.789, 0.5],
    'devanagari.s': [1.001, 1.01, 1.174, 1.402, 1.944, 2.182, 2.484, 2.942, 3.28, 3.698, 4.017, 4.552, 4.455, 5.472, 6.039, 0.437],
    'digits': [1, 1],
    'digits.u': [1.458, 1.458],
    'greek.n': [1, 1.137, 1.828, 2.214, 2.852, 3.135, 3.878, 4.233, 4.441, 4.529, 4.75, 5.267, 0.4],
    'greek.p': [1.783, 0.869],
    'greek.s': [1.002, 1.032, 1.046, 1.414, 2.166, 2.958, 3.344, 3.706, 3.797, 4.146, 4.343, 4.677, 5.277, 5.481, 5.337, 0.345],
    'han.n': [1.012, 1.83, 2.738, 3.674, 4.596, 5.465, 6.068, 7.147, 7.997, 8.662, 9.758, 10.426, 11.313, 12.381, 12.938, 0.87],
    'han.p': [1.835, 2.815, 3.856, 4.793, 5.635, 6.483, 7.348, 8.274, 9.092, 9.867, 10.681, 11.578, 12.527, 13.41, 14.153, 0.917],
    'han.s': [1.364, 2.584, 3.566, 4.494, 5.071, 5.612, 6.674, 7.416, 8.511, 9.612, 10.214, 10.849, 11.258, 0.887],
    'hangul.n': [1.009, 1.853, 2.492, 3.439, 4.24, 5.114, 0.892],
    'hangul.p': [1.524, 2.738, 3.533, 4.345, 5.411, 1.262],
    'hangul.s': [1.062, 1.56, 2.415, 2.982, 3.864, 4.922, 5.759, 6.91, 7.625, 8.456, 0.786],
    'hebrew.n': [1, 1.071, 1.957, 2.237, 2.642, 2.929, 3.396, 3.819, 0.534],
    'hebrew.p': [1.204, 2.001, 2.757, 3.002, 3.457, 3.695, 4.451, 4.709, 5.723, 0.705],
    'hebrew.s': [1, 1.012, 1.265, 1.821, 2.218, 2.605, 2.976, 3.425, 3.96, 4.399, 5.081, 6.05, 6.948, 0.813],
    'indic.s': [1, 1.037, 1.556, 1.937, 1.569, 3.57, 4.119, 0.519],
    'kana.n': [1, 1.23, 1.883, 3.258, 4.046, 4.579, 5.25, 6.137, 7.067, 8.368, 8.897, 9.699, 10.473, 11.503, 12.633, 0.837],
    'kana.p': [1.5, 1.935, 2.603, 4.07, 4.716, 5.666, 6.363, 7.164, 8.072, 8.927, 9.793, 10.637, 11.443, 12.458, 13.449, 0.863],
    'kana.s': [1, 1.728, 2.601, 3.28, 3.961, 5.047, 5.818, 6.692, 7.596, 8.201, 9.504, 9.982, 0.828],
    'latin.nC': [1, 1.011, 1.032, 1.097, 1.076, 1.249, 1.41, 1.347, 1.701, 2.051, 1.869, 1.395, 2.55, 2.617, 0.248],
    'latin.nCd': [1, 1.819, 2.234, 2.739, 2.747, 3.564, 3.686, 4.938, 4.973, 5.493, 0.747],
    'latin.nU': [1, 1.003, 1.243, 1.689, 1.992, 2.435, 2.465, 2.965, 2.567, 0.414],
    'latin.nl': [1, 1.002, 1.048, 1.042, 1.112, 1.229, 1.332, 1.444, 1.668, 1.995, 1.987, 1.616, 2.166, 3.107, 3.077, 0.202],
    'latin.nld': [1, 1.804, 2.522, 3.073, 4.109, 3.665, 0.844],
    'latin.pC': [1.312, 1.507, 1.549, 1.395, 1.754, 2.387, 2.162, 2.356, 3.047, 3.418, 3.027, 2.841, 0.174],
    'latin.pCd': [1, 1.81, 2.5, 3.556, 4.121, 4.527, 5.108, 5.73, 6.251, 7.489, 8.345, 9.501, 10.053, 0.767],
    'latin.pU': [1, 1.577, 1.919, 2.167, 1.771, 2.268, 2.166, 3.036, 2.254, 3.78, 0.465],
    'latin.pl': [1.048, 1.065, 1.18, 1.144, 1.242, 1.413, 1.602, 1.839, 1.895, 2.106, 2.11, 2.466, 2.383, 3.133, 3.825, 0.256],
    'latin.pld': [1.545, 0.609],
    'latin.sC': [1, 1.004, 1.012, 1.078, 1.148, 1.192, 1.382, 1.408, 1.673, 1.745, 1.902, 1.958, 2.177, 2.655, 3.553, 0.22],
    'latin.sCd': [1, 1.67, 1.966, 2.166, 2.486, 2.556, 2.491, 2.926, 2.882, 3.485, 3.587, 3.732, 5.541, 4.9, 0.606],
    'latin.sU': [1, 1.004, 1.153, 1.221, 1.827, 2.221, 2.646, 2.545, 2.712, 0.377],
    'latin.sl': [1, 1, 1.004, 1.008, 1.029, 1.04, 1.078, 1.133, 1.178, 1.242, 1.293, 1.361, 1.46, 1.722, 2.39, 0.2],
    'latin.sld': [1, 1.476, 1.262, 1.365, 1.758, 1.796, 1.944, 2.327, 2.691, 2.962, 3.248, 4.064, 4.201, 0.576],
    'newline': [1, 1, 1, 1, 1.2, 1, 1.167, 1, 1.9, 1, 1.014, 1.869, 1.284, 1.028, 0.096],
    'other.n': [1, 0.923],
    'punct': [1, 1.022, 1.152, 1.271, 1.871, 2.163, 3.132, 3.708, 4.571, 0.067],
    'punct.s': [1, 1.242, 1.646, 1.948, 2.163, 2.354, 2.333, 2.133, 0.107],
    'punct.su': [1.037, 1.584, 2.808, 1.019],
    'punctu': [1.018, 1.283, 1.952, 2.692, 0.903],
    'space': [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.045],
    'tamil.n': [1, 1.118, 1.766, 2.34, 2.809, 3.202, 3.812, 4.141, 4.297, 4.957, 4.936, 5.445, 6.102, 6.21, 7.616, 0.43],
    'tamil.p': [1, 2.24, 2.041, 3.673, 3.535, 3.831, 5.215, 0.688],
    'tamil.s': [1, 1.212, 1.463, 1.721, 1.958, 2.282, 2.61, 3.113, 3.291, 3.815, 4.101, 4.457, 4.753, 4.888, 5.203, 0.324],
    'thai.n': [1, 1, 1.484, 1.937, 2.81, 2.057, 2.796, 3.655, 4.33, 4.707, 4.281, 3.643, 6.077, 6.195, 0.421],
    'thai.p': [1.012, 0.436],
    'thai.s': [1, 1.075, 1.304, 1.564, 2.678, 2.783, 2.935, 4.171, 4.372, 4.486, 4.575, 5.304, 5.885, 5.613, 6.383, 0.43],
  },
  languages: { ar: [0.995, 1, 0.922], de: [0.993, 1.037, 1.042], en: [0.997, 0.986, 0.962], es: [0.995, 1.025, 1.047], fa: [1.002, 1.001, 1.134], fr: [1.13, 1.005, 0.882], hi: [0.975, 0.891, 0.916], id: [1.006, 1.189, 1.622], it: [0.999, 1.275, 1.616], ja: [1.023, 1.005, 0.987], latin: [0.984, 1.047, 1.02], mr: [1.106, 1.149, 1.049], nl: [0.997, 1.128, 1.424], pl: [0.986, 1.397, 1.439], pt: [0.99, 0.997, 0.965], ru: [0.984, 0.872, 0.859], tr: [1.037, 1.202, 1.041], uk: [1.021, 1.155, 1.187], vi: [0.872, 0.81, 1.295], zh: [0.989, 1.024, 1.048] },
  perCharacter: 0.395,
};
// END GENERATED O200K_TABLE

function splitO200kPieces(text) {
  return Array.from(String(text ?? '').matchAll(O200K_PIECE_PATTERN), (match) => match[0]);
}

// A piece's family and length. Letter pieces count letters (marks included), digit pieces
// count as one, whitespace counts characters, and punctuation counts the characters after
// an optional leading space, without trailing line breaks.
function o200kPieceFamily(piece) {
  const letters = piece.match(O200K_LETTERS);
  if (letters) {
    const first = letters[0];
    const script = O200K_SCRIPTS.find(([, pattern]) => pattern.test(first))?.[0] ?? 'other';
    const lead = piece[0] === ' ' ? 's' : O200K_LETTER.test(piece[0]) ? 'n' : 'p';
    if (script !== 'latin') return { family: `${script}.${lead}`, length: letters.length, letters: true };
    const upper = letters.filter((letter) => O200K_UPPER.test(letter)).length;
    const letterCase = upper === letters.length && letters.length > 1 ? 'U' : O200K_UPPER.test(first) ? 'C' : 'l';
    const accented = letters.some((letter) => !O200K_ASCII_LETTER.test(letter)) ? 'd' : '';
    return { family: `latin.${lead}${letterCase}${accented}`, length: letters.length, letters: true };
  }
  // One to three ASCII digits are always one token; other digits (Devanagari, Arabic-Indic,
  // superscripts) are measured.
  if (O200K_DIGIT.test(piece)) return { family: /^[0-9]+$/.test(piece) ? 'digits' : 'digits.u', length: 1, letters: false };
  if (!piece.trim()) return { family: /[\r\n]/.test(piece) ? 'newline' : 'space', length: piece.length, letters: false };
  const body = piece[0] === ' ' ? piece.slice(1) : piece;
  const length = Math.max(1, Array.from(body.replace(/[\r\n]+$/, '')).length);
  return { family: `punct${piece[0] === ' ' ? '.s' : ''}${O200K_NON_ASCII.test(body) ? 'u' : ''}`, length, letters: false };
}

function o200kHints() {
  if (o200kHintWords) return o200kHintWords;
  o200kHintWords = new Map();
  for (const [language, words] of Object.entries(O200K_LANGUAGE_HINTS)) {
    for (const word of words.split(' ')) o200kHintWords.set(word, [...(o200kHintWords.get(word) ?? []), language]);
  }
  return o200kHintWords;
}

// The language a paragraph's pieces clearly lead with, or '' when none does. Japanese and
// Chinese run whole sentences together as one piece, so they are told by their letters:
// kana for Japanese, Han without kana for Chinese. A paragraph with accented Latin letters
// and no English hint words, but no clear language either, is `latin`: some other
// Latin-script language, which splits into more tokens than English does.
function o200kSegmentLanguage(pieces) {
  const hints = o200kHints();
  const scores = new Map();
  let letters = 0;
  let kana = 0;
  let han = 0;
  let accented = 0;
  for (const piece of pieces) {
    letters += piece.match(O200K_LETTERS)?.length ?? 0;
    kana += piece.match(O200K_KANA_LETTERS)?.length ?? 0;
    han += piece.match(O200K_HAN_LETTERS)?.length ?? 0;
    accented += piece.match(O200K_ACCENTED_LATIN)?.length ?? 0;
    const languages = hints.get(piece.replace(O200K_LEADING_NON_LETTERS, '').toLowerCase());
    if (languages) for (const language of languages) scores.set(language, (scores.get(language) ?? 0) + 1 / languages.length);
  }
  if (kana >= 2 && kana >= 0.1 * letters) return 'ja';
  if (han >= 2 && han >= 0.3 * letters) return 'zh';
  const [best, second] = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (best && best[1] >= 2 && (!second || best[1] >= 1.5 * second[1])) return best[0];
  if (!scores.has('en') && accented >= 3 && accented >= 0.02 * letters) return 'latin';
  return '';
}

// Word pieces of 1–3, 4–7 and 8 or more letters get their own language factor.
function o200kLengthBand(length) {
  return length <= 3 ? 0 : length <= 7 ? 1 : 2;
}

// Code splits differently from prose (`.map(`, ` = `, indentation), so a paragraph where
// brackets, semicolons and `=` are common next to its words uses the table's code families.
function o200kLooksLikeCode(entries) {
  let marks = 0;
  let words = 0;
  for (const entry of entries) {
    if (entry.letters) words += 1;
    else if (entry.family.startsWith('punct') && O200K_CODE_MARK.test(entry.piece)) marks += 1;
  }
  return marks >= 3 && marks >= 0.25 * words;
}

// The text split into paragraphs at blank lines. Each paragraph lists its pieces with their
// family and length, and says whether it reads as code or as one clear language.
function o200kSegments(text) {
  const paragraphs = [];
  let current = [];
  for (const match of String(text ?? '').matchAll(O200K_PIECE_PATTERN)) {
    const piece = match[0];
    current.push({ piece, ...o200kPieceFamily(piece) });
    if (O200K_BLANK_LINE.test(piece)) {
      paragraphs.push(current);
      current = [];
    }
  }
  if (current.length > 0) paragraphs.push(current);
  return paragraphs.map((entries) => {
    if (o200kLooksLikeCode(entries)) {
      for (const entry of entries) entry.family = `code.${entry.family}`;
      return { entries, code: true, language: '' };
    }
    return { entries, code: false, language: o200kSegmentLanguage(entries.filter((entry) => entry.letters).map((entry) => entry.piece)) };
  });
}

// A family's row lists the average for each length that was seen often enough, then its
// tokens per character, which also covers longer and rarer lengths. A code family missing
// from the table falls back to the prose family, and an unknown family to a general rate.
function o200kPieceEstimate(entry, table = O200K_TABLE) {
  const values = table.families[entry.family] ?? table.families[entry.family.replace(/^code\./, '')];
  if (!values) return Math.max(1, entry.length * table.perCharacter);
  const rate = values[values.length - 1];
  if (entry.length < values.length) return values[entry.length - 1];
  return entry.length >= O200K_LENGTH_CAP ? rate * entry.length : Math.max(1, rate * entry.length);
}

// Estimated o200k_base token count of `text`, rounded to a whole number.
function estimateTextTokens(text, table = O200K_TABLE) {
  let total = 0;
  for (const segment of o200kSegments(text)) {
    const factors = table.languages[segment.language];
    for (const entry of segment.entries) {
      const estimate = o200kPieceEstimate(entry, table);
      total += factors && entry.letters ? estimate * factors[o200kLengthBand(entry.length)] : estimate;
    }
  }
  return Math.round(total);
}

// Context estimate (v0.19.0): about how many tokens of a model's context window a chat
// fills, for the gauge at the top of an export. It is local, like the other stats: it
// reads only the chat as normalized for the export, makes no request, and is never the
// provider's own figure.
//
// ChatGPT: the messages' text, counted with the o200k estimate (src/token-estimate.mjs).
// ChatGPT's data carries no system instructions, memory or hidden reasoning to count.
//
// Claude: five parts, added up.
// - Messages, tool calls and tool results: the o200k estimate × 1.4. Claude's tokenizer
//   is unpublished; a third-party test (October 2026) found that models from Opus 4.7 on
//   count about 1.4 times as many tokens as o200k on English text.
// - Thinking: Claude's app sends only summary lines, but every thinking step carries its
//   start and stop times. Opus 5.5 produced thinking at a median 96 tokens a second in a
//   measured session, so each second counts as 100 tokens. Anthropic's API keeps earlier
//   turns' thinking in context from Opus 4.5 on; the app is assumed to do the same.
// - Instructions: Claude's published app prompt for Opus 5.5 (October 2026) is about 6,200
//   o200k tokens, about 8,700 at × 1.4. Tool descriptions, memory, preferences and project
//   knowledge come on top and are not published.
// - Images: Anthropic's formula for models from Claude 4.7 on, ceil(w / 28) × ceil(h / 28)
//   tokens with the long edge scaled to at most 2,576 pixels, capped at 4,784 per image.
//   The size is that of the preview named in Claude's data.
// docs/version-history/v0.19.0.md gives the sources.

const CLAUDE_CONTEXT = {
  textFactor: 1.4,
  thinkingTokensPerSecond: 100,
  instructions: 8700,
  imagePatch: 28,
  imageLongEdge: 2576,
  imageMaxTokens: 4784,
};

function claudeImageTokens(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0) || !(h > 0)) return null;
  const scale = Math.min(1, CLAUDE_CONTEXT.imageLongEdge / Math.max(w, h));
  const tokens = Math.ceil((w * scale) / CLAUDE_CONTEXT.imagePatch) * Math.ceil((h * scale) / CLAUDE_CONTEXT.imagePatch);
  return Math.min(CLAUDE_CONTEXT.imageMaxTokens, tokens);
}

// JSON.stringify throws on a cycle, and a tool input is provider data rather than ours.
function contextJson(value) {
  try {
    return value && typeof value === 'object' ? JSON.stringify(value) ?? '' : '';
  } catch {
    return '';
  }
}

// `countTokens` is estimateTextTokens. It is passed in because the source modules share
// one scope only inside the built userscript. The messages are the chat's current branch:
// only one branch is ever in the model's context.
function estimateContextUse(messages, { provider = 'ChatGPT', countTokens = null } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const count = (text) => (text && typeof countTokens === 'function' ? Math.max(0, Number(countTokens(text)) || 0) : 0);
  const messageTexts = [];
  const toolTexts = [];
  let thinkingMs = 0;
  let thinkingSteps = 0;
  let untimedThinkingSteps = 0;
  let images = 0;
  let imageCount = 0;
  let unsizedImageCount = 0;
  for (const message of list) {
    const parts = [];
    for (const block of message?.textBlocks ?? []) {
      if (block?.type === 'text' || block?.type === 'code') parts.push(String(block.text ?? ''));
      else if (block?.type === 'tool_use') toolTexts.push([block.toolName, contextJson(block.input)].filter(Boolean).join('\n'));
      else if (block?.type === 'tool_result') toolTexts.push(String(block.text ?? ''));
      else if (block?.type === 'thinking') {
        thinkingSteps += 1;
        if (Number.isFinite(block.durationMs) && block.durationMs > 0) thinkingMs += block.durationMs;
        else untimedThinkingSteps += 1;
      } else if (block?.type === 'image') {
        imageCount += 1;
        const tokens = claudeImageTokens(block.asset?.width, block.asset?.height);
        if (tokens === null) unsizedImageCount += 1;
        else images += tokens;
      }
    }
    // Joined as the word count joins them, so for ChatGPT this is the stats line's figure.
    const text = parts.join('\n');
    if (text) messageTexts.push(text);
  }
  const messageTokens = count(messageTexts.join('\n'));
  if (provider !== 'Claude') return { provider, total: messageTokens, messages: messageTokens };

  const { textFactor, thinkingTokensPerSecond, instructions } = CLAUDE_CONTEXT;
  const messageShare = Math.round(messageTokens * textFactor);
  const tools = Math.round(count(toolTexts.filter(Boolean).join('\n')) * textFactor);
  const thinkingSeconds = thinkingMs / 1000;
  const thinking = Math.round(thinkingSeconds * thinkingTokensPerSecond);
  return {
    provider,
    total: messageShare + tools + thinking + instructions + images,
    messages: messageShare,
    tools,
    thinking,
    thinkingSeconds,
    thinkingSteps,
    untimedThinkingSteps,
    thinkingTokensPerSecond,
    instructions,
    images,
    imageCount,
    unsizedImageCount,
    textFactor,
  };
}

(() => {
  const CONTROL_ID = 'chatgpt-chats-exporter-control';
  const PANEL_ID = 'chatgpt-chats-exporter-panel';
  const OPTIONS_ID = 'chatgpt-chats-exporter-options';
  const HOST_ID = 'chatgpt-thread-archiver-ui';
  const PREF_KEY = 'chatgpt-thread-archiver-prefs';
  const LEGACY_PREF_KEY = 'chatgpt-chats-exporter-prefs';
  const PREFS_VERSION = 1;

  const QUICK_LABEL = 'Quick export';
  const MENU_LABEL = 'Export HTML…';

  const STYLES = `
    #${CONTROL_ID} { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647; display: flex; align-items: stretch; border-radius: 999px; background: #111827; box-shadow: 0 6px 22px rgb(0 0 0 / .2); overflow: hidden; }
    #${CONTROL_ID} button { display: inline-flex; align-items: center; gap: 6px; margin: 0; border: 0; padding: 10px 14px; background: transparent; color: white; font: 600 13px/1.2 system-ui, sans-serif; cursor: pointer; white-space: nowrap; }
    #${CONTROL_ID} button:first-child { padding-left: 15px; }
    #${CONTROL_ID} button:last-child { padding-right: 15px; }
    #${CONTROL_ID} button + button { border-left: 1px solid rgb(255 255 255 / .22); }
    #${CONTROL_ID} button:hover:not([aria-disabled="true"]) { background: #1f2937; }
    #${CONTROL_ID} button:focus-visible { outline: 2px solid #93c5fd; outline-offset: -3px; border-radius: 999px; }
    #${CONTROL_ID} svg { flex: none; }
    @media (max-width: 700px) {
      #${CONTROL_ID} { right: 12px; bottom: calc(84px + env(safe-area-inset-bottom, 0px)); }
      #${PANEL_ID} { right: 12px; bottom: calc(138px + env(safe-area-inset-bottom, 0px)); max-width: calc(100vw - 24px); }
    }
    #${CONTROL_ID}[data-state="busy"] { opacity: .7; }
    #${CONTROL_ID}[data-state="busy"] button { cursor: wait; }
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

  // Quick export uses the saved choices. Before the first export from the menu there are
  // none, so it uses the defaults the menu would show, and says so.
  function hasSavedPrefs() {
    try {
      return Boolean(parsePrefs(localStorage.getItem(PREF_KEY)) ?? parsePrefs(localStorage.getItem(LEGACY_PREF_KEY)));
    } catch {
      return false;
    }
  }

  // A short, plain summary of what an export will contain, for Quick export's tooltip and
  // status line: "All versions · all images · title and link · no thinking".
  function describePrefs(prefs, provider) {
    const parts = [
      prefs.branchMode === 'all' ? 'all versions' : 'current version only',
      { all: 'all images', none: 'no images', choose: 'choose images' }[prefs.imageMode] ?? 'all images',
    ];
    const fields = [prefs.title && 'title', prefs.url && 'link', prefs.conversationId && 'ID'].filter(Boolean);
    parts.push(fields.length ? fields.join(fields.length === 2 ? ' and ' : ', ') : 'no title or link');
    if (provider === 'Claude') parts.push(prefs.thinking === true ? 'with thinking' : 'no thinking');
    const text = parts.join(' · ');
    return text.charAt(0).toUpperCase() + text.slice(1);
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

  function showExportOptions(control, provider) {
    if (uiElement(OPTIONS_ID) || control?.dataset.state === 'busy') return;
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
    intro.textContent = 'Choose which identifying fields and images should be included in the offline HTML file. Your choices are saved, and Quick export reuses them.';
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
      exportCurrentConversation(control, chosen, provider, { trigger: control?.querySelector('[data-action="menu"]') });
    });
    exportButton.focus();
  }

  // Skips the menu: the saved choices, or the menu's defaults before anything is saved.
  // "Choose images" still opens the image list, because that choice is made per chat.
  function quickExport(control, provider) {
    if (control?.dataset.state === 'busy') return;
    uiElement(OPTIONS_ID)?.remove();
    const saved = hasSavedPrefs();
    const prefs = loadPrefs();
    exportCurrentConversation(control, prefs, provider, {
      trigger: control?.querySelector('[data-action="quick"]'),
      settingsNote: `Quick export, ${saved ? 'your last settings' : 'default settings'}: ${describePrefs(prefs, provider)}.`,
    });
  }

  function quickExportTitle(provider) {
    const saved = hasSavedPrefs();
    return `Export now, without the menu, using ${saved ? 'your last settings' : 'the default settings until you export from the menu once'}: ${describePrefs(loadPrefs(), provider)}`;
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

  // Both buttons ignore clicks while an export runs, and the one that started it says so.
  // aria-disabled rather than disabled, so a keyboard user's focus stays on the button.
  function setControlBusy(control, trigger, busy) {
    if (!control) return;
    control.dataset.state = busy ? 'busy' : 'idle';
    control.setAttribute('aria-busy', busy ? 'true' : 'false');
    for (const button of control.querySelectorAll('button')) {
      button.setAttribute('aria-disabled', busy ? 'true' : 'false');
      const label = button.querySelector('[data-label]');
      if (label) label.textContent = busy && button === trigger ? 'Exporting…' : button.dataset.idleLabel;
    }
  }

  async function exportCurrentConversation(control, prefs = loadPrefs(), provider = providerForLocation(), { trigger = null, settingsNote = '' } = {}) {
    if (control?.dataset.state === 'busy') return;
    if (!provider) {
      showStatus('Export unavailable', 'Open a supported ChatGPT or Claude conversation first.', true);
      return;
    }
    setControlBusy(control, trigger, true);

    try {
      const conversationId = provider === 'Claude' ? getClaudeConversationIdFromUrl() : getConversationIdFromUrl();
      if (!conversationId) throw new Error(`Open a ${provider} conversation before exporting.`);
      showStatus('Loading conversation…', [settingsNote, `${provider} conversation ID: ${provider === 'Claude' ? redactClaudeId(conversationId) : redactId(conversationId)}`].filter(Boolean).join('\n'));
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
      // ChatGPT only: the estimate follows ChatGPT's tokenizer, and Claude's differs.
      if (provider === 'ChatGPT') exportStats.estimatedTokens = estimateTextTokens(exportStatsText(statsMessages));
      // The context gauge counts the chat's current branch, whatever the export includes:
      // only that branch is in the model's context, thinking and tool calls included.
      exportStats.context = estimateContextUse(normalized.messages, { provider, countTokens: estimateTextTokens });
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
      const localStats = Number.isFinite(exportStats.estimatedTokens)
        ? `${exportStats.wordCount.toLocaleString('en-US')} words, ${exportStats.characterCount.toLocaleString('en-US')} characters and about ${formatTokenEstimate(exportStats.estimatedTokens)} tokens counted locally.`
        : `${exportStats.wordCount.toLocaleString('en-US')} words and ${exportStats.characterCount.toLocaleString('en-US')} characters counted locally.`;
      const settingsLine = settingsNote ? `\n${settingsNote} Change them with ${MENU_LABEL}` : '';
      showStatus('Download ready', `${exportStats.messageCount} ${provider} message(s) exported; ${exportStats.omittedBlockCount} unsupported block(s) marked.${imageSummary} ${localStats}${settingsLine}`);
    } catch (error) {
      const description = provider === 'Claude' ? describeClaudeError(error) : describeClientError(error);
      showStatus('Export failed', description, true);
      console.error('[ChatGPT Thread Archiver]', error?.code ?? 'unknown', description);
    } finally {
      setControlBusy(control, trigger, false);
    }
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(pathData) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', pathData);
    path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
    return svg;
  }

  function controlButton(action, text, title, iconPath = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = action;
    button.dataset.idleLabel = text;
    button.title = title;
    if (iconPath) button.appendChild(icon(iconPath));
    const label = document.createElement('span');
    label.dataset.label = '';
    label.textContent = text;
    button.appendChild(label);
    return button;
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
    // Two buttons in one pill. "Export HTML…" stays at the right edge where it always was
    // and opens the menu; "Quick export" skips it and reuses the last choices.
    const control = document.createElement('div');
    control.id = CONTROL_ID;
    control.dataset.provider = provider;
    control.dataset.state = 'idle';
    control.setAttribute('role', 'group');
    control.setAttribute('aria-label', `Export this ${provider} conversation`);
    // A lightning bolt for the shortcut; the menu button keeps its plain label.
    const quick = controlButton('quick', QUICK_LABEL, quickExportTitle(provider), 'M13 2 4 14h7l-1 8 9-12h-7l1-8z');
    const menu = controlButton('menu', MENU_LABEL, `Choose what to include, then export the currently open ${provider} conversation as HTML`);
    // The tooltip names the settings, so it is refreshed whenever the pointer or focus
    // arrives: an export from the menu may have changed them since the button was made.
    const refreshQuickTitle = () => { quick.title = quickExportTitle(provider); };
    quick.addEventListener('pointerenter', refreshQuickTitle);
    quick.addEventListener('focus', refreshQuickTitle);
    quick.addEventListener('click', () => quickExport(control, provider));
    menu.addEventListener('click', () => showExportOptions(control, provider));
    control.append(quick, menu);
    uiRoot().appendChild(control);
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

})();
