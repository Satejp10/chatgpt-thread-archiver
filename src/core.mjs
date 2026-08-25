const ARCHIVER_VERSION = '0.8.1';
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
    return {
      kind: 'image',
      asset: {
        pointer,
        mimeType: value.mime_type ?? value.mimeType ?? '',
        sizeBytes: Number.isFinite(value.size_bytes) ? value.size_bytes : null,
        width: Number.isFinite(value.width) ? value.width : null,
        height: Number.isFinite(value.height) ? value.height : null,
        generated: Boolean(metadata.dalle || metadata.generation || value.generated),
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

  const entries = mappingEntries(raw);
  if (entries.length > 0) {
    const leafId = chooseLeaf(entries, raw.current_node ?? raw.currentNode);
    if (!leafId) throw new ConversationShapeError('Conversation mapping contains no usable message node.', { keys: Object.keys(raw) });
    nodes = pathFromMapping(entries, leafId);
    sourceShape = 'mapping-tree';
  } else {
    nodes = arrayMessages(raw);
    sourceShape = 'message-array';
    activeBranch = false;
  }

  const messages = nodes.map(normalizeNode).filter(Boolean);
  if (messages.length === 0) throw new ConversationShapeError('No message nodes with recognizable content were found.', { sourceShape, keys: Object.keys(raw) });

  const uniqueMessages = [];
  const seen = new Set();
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    uniqueMessages.push(message);
  }

  const omittedBlockCount = uniqueMessages.reduce((sum, message) => sum + message.omittedCount, 0);
  const structuralNodeCount = nodes.filter((node) => !(Object.prototype.hasOwnProperty.call(node, 'message') && !node.message)).length;
  const droppedNodeCount = Math.max(0, structuralNodeCount - messages.length);
  const duplicateMessageCount = Math.max(0, messages.length - uniqueMessages.length);
  const hiddenMessageCount = uniqueMessages.filter((message) => message.hidden).length;
  return {
    title,
    conversationId,
    model,
    provider: 'ChatGPT',
    sourceShape,
    activeBranch,
    messages: uniqueMessages,
    stats: {
      messageCount: uniqueMessages.length,
      omittedBlockCount,
      sourceNodeCount: nodes.length,
      droppedNodeCount,
      duplicateMessageCount,
      hiddenMessageCount,
    },
  };
}

function inlineFormatting(escapedText) {
  return escapedText
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/_([^_\n]+)_/g, '<em>$1</em>');
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

function renderBlock(block) {
  if (block.type === 'omitted') return `<p class="omitted">[non-text content omitted: ${escapeHtml(block.reason)}]</p>`;
  if (block.type === 'image') {
    const asset = block.asset ?? {};
    if (asset.status === 'excluded') return '<p class="omitted">[image excluded by export settings]</p>';
    if (asset.status === 'embedded' && typeof asset.dataUrl === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(asset.dataUrl)) {
      const dimensions = Number.isFinite(asset.width) && Number.isFinite(asset.height) ? ` width="${escapeAttribute(String(Math.min(asset.width, 10000)))}" height="${escapeAttribute(String(Math.min(asset.height, 10000)))}"` : '';
      const label = asset.generated ? 'Generated image' : 'Uploaded/reference image';
      const size = Number.isFinite(asset.byteLength) ? ` · ${Math.round(asset.byteLength / 1024)} KB embedded` : '';
      return `<figure class="image-block"><img src="${escapeAttribute(asset.dataUrl)}" alt="${label}"${dimensions} loading="lazy"><figcaption>${label}${size}</figcaption></figure>`;
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

function formatLocalStats(stats) {
  if (!Number.isFinite(stats?.wordCount) || !Number.isFinite(stats?.characterCount)) return '';
  const words = Number(stats.wordCount).toLocaleString('en-US');
  const characters = Number(stats.characterCount).toLocaleString('en-US');
  const blocks = Number.isFinite(stats.textBlockCount) ? ` · ${Number(stats.textBlockCount).toLocaleString('en-US')} text blocks` : '';
  return `<p class="meta">Safe local stats: ${words} words · ${characters} characters${blocks}. Counted from exported text only; provider token and context-window usage are not included.</p>`;
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
  const label = uniqueModels.length === 1 ? 'Model' : 'Models used';
  return `<p class="meta">${label}: ${escapeHtml(uniqueModels.join(', '))}</p>`;
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

const EXPORT_CSS = `
:root { color-scheme: light; --bg: #f9f9f9; --surface: #fff; --text: #24292f; --muted: #57606a; --border: #e0e0e0; --user: #eef2ff; --assistant: #fff; --accent: #10a37f; --link: #0969da; --code-bg: #1f2328; --code-text: #e6edf3; --shadow: rgb(0 0 0 / .05); }
	html.dark { color-scheme: dark; --bg: #0f1115; --surface: #171a21; --text: #e6edf3; --muted: #9aa4b2; --border: #303744; --user: #25213d; --assistant: #171a21; --accent: #35c89e; --link: #7ab7ff; --code-bg: #090c11; --code-text: #e6edf3; --shadow: rgb(0 0 0 / .3); }
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
.image-block { margin: 14px 0; text-align: center; }
.image-block img { display: inline-block; max-width: 100%; height: auto; border-radius: 6px; border: 1px solid var(--border); background: #fff; }
.image-block figcaption { margin-top: 6px; color: var(--muted); font-size: .82em; }

.content pre { white-space: pre; overflow-x: auto; background: var(--code-bg); color: var(--code-text); padding: 12px 14px; border-radius: 6px; margin: 12px 0; }
.content pre code { background: none; padding: 0; color: inherit; font-size: .88em; }
.omitted, .empty-message { color: var(--muted); font-style: italic; }
.export-footer { margin-top: 28px; color: var(--muted); font-size: .82rem; }
.copy-btn { position: absolute; top: 12px; right: 12px; padding: 4px 10px; background: var(--accent); color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
.copy-btn:hover { background: #0d8a6a; }
	#theme-toggle { position: fixed; top: 12px; left: 10px; padding: 3px 8px; border: 1px solid var(--border); background: var(--surface); color: var(--muted); border-radius: 4px; cursor: pointer; z-index: 51; }
	#theme-toggle:hover { color: var(--text); }
	#rail { max-width: 820px; margin: 0 auto 24px; padding: 12px 16px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
#rail h2 { margin: 0 0 8px; color: var(--muted); font-size: .9rem; }
#rail ol { margin: 0; padding-left: 1.4em; font-size: .9rem; }
#rail li { margin: 2px 0; }
#rail a { color: var(--accent); text-decoration: none; }
#rail a:hover { text-decoration: underline; }
#rail-toggle { display: none; }
#rail-tip { position: fixed; z-index: 60; transform: translateY(-50%); max-width: 44vw; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: #1f2328; color: #fff; font-size: 12px; padding: 4px 9px; border-radius: 4px; pointer-events: none; opacity: 0; transition: opacity .12s ease; }
#rail-tip.on { opacity: 1; }
html.js #rail { position: fixed; top: 0; right: 0; bottom: 0; width: 40px; max-width: none; margin: 0; padding: 0; background: none; border: 0; border-radius: 0; z-index: 50; display: flex; flex-direction: column; justify-content: center; align-items: flex-end; pointer-events: none; }
html.js #rail ol { pointer-events: auto; list-style: none; padding: 8px 0; margin: 0; max-height: 100vh; overflow-y: auto; overflow-x: visible; scrollbar-width: none; }
html.js #rail ol::-webkit-scrollbar { display: none; }
html.js #rail h2 { display: none; }
html.js #rail li { margin: 0; }
html.js #rail a { display: block; position: relative; padding: 3px 14px 3px 8px; }
html.js #rail a::before { content: ""; display: block; height: 2px; width: 10px; margin-left: auto; background: #b9bec4; border-radius: 1px; transition: width .12s ease, background .12s ease; }
html.js #rail a:hover::before, html.js #rail a:focus-visible::before { width: 20px; background: #6e7781; }
html.js #rail li.active a::before { width: 22px; background: var(--accent); }
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
  '  function copy(text, btn) {',
  '    var done = function () { btn.textContent = "Copied"; setTimeout(function () { btn.textContent = "Copy"; }, 1600); };',
  '    var fail = function () { btn.textContent = "Copy failed"; setTimeout(function () { btn.textContent = "Copy"; }, 1600); };',
  '    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { legacy(text) ? done() : fail(); });',
  '    else legacy(text) ? done() : fail();',
  '  }',
  '  function legacy(text) { try { var ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.top = "-1000px"; document.body.appendChild(ta); ta.select(); var ok = document.execCommand("copy"); ta.remove(); return ok; } catch (e) { return false; } }',
  '  document.addEventListener("click", function (event) {',
  '    var button = event.target.closest ? event.target.closest(".copy-btn") : null;',
  '    if (button) { var body = button.parentNode.querySelector(".content"); if (body) copy(body.innerText, button); return; }',
  '  });',
  '  var rail = document.getElementById("rail"), toggle = document.getElementById("rail-toggle");',
  '  if (!rail) return;',
  '  function setHidden(hidden) { rail.className = hidden ? "hidden" : ""; if (toggle) { toggle.textContent = hidden ? "Nav" : "Hide"; toggle.setAttribute("aria-expanded", hidden ? "false" : "true"); } try { sessionStorage.setItem("chatgpt-thread-archiver-rail-hidden", hidden ? "1" : "0"); } catch (e) {} }',
  '  var stored = "0"; try { stored = sessionStorage.getItem("chatgpt-thread-archiver-rail-hidden") || "0"; } catch (e) {} setHidden(stored === "1");',
  '  if (toggle) toggle.addEventListener("click", function () { setHidden(rail.className !== "hidden"); });',
  '  var links = rail.querySelectorAll("ol a[href^=\"#\"]"), items = [], tip = document.createElement("div");',
  '  tip.id = "rail-tip"; document.body.appendChild(tip);',
  '  for (var i = 0; i < links.length; i++) { var target = document.getElementById(links[i].getAttribute("href").slice(1)); if (target) items.push({ a: links[i], li: links[i].parentNode, el: target }); }',
  '  if (!items.length) return;',
  '  function showTip(a) { var r = a.getBoundingClientRect(); tip.textContent = a.textContent; tip.style.top = (r.top + r.height / 2) + "px"; tip.style.right = (window.innerWidth - r.left + 8) + "px"; tip.className = "on"; }',
  '  function hideTip() { tip.className = ""; }',
  '  var list = rail.querySelector("ol"), current = -1, visible = Object.create(null);',
  '  list.addEventListener("mouseover", function (e) { var a = e.target.closest ? e.target.closest("a") : null; if (a && list.contains(a)) showTip(a); });',
  '  list.addEventListener("mouseleave", hideTip); list.addEventListener("focusin", function (e) { if (e.target.tagName === "A") showTip(e.target); }); list.addEventListener("focusout", hideTip);',
  '  function paint(i) { if (i < 0 || i === current) return; if (current >= 0) items[current].li.className = ""; items[i].li.className = "active"; current = i; }',
  '  function recompute() { for (var i = 0; i < items.length; i++) if (visible[items[i].el.id]) { paint(i); return; } }',
  '  if (window.IntersectionObserver) { var io = new IntersectionObserver(function (entries) { for (var k = 0; k < entries.length; k++) { var e = entries[k]; if (e.isIntersecting) visible[e.target.id] = 1; else delete visible[e.target.id]; } recompute(); }, { rootMargin: "-8% 0px -55% 0px", threshold: 0 }); for (var j = 0; j < items.length; j++) io.observe(items[j].el); }',
  '  paint(0);',
  '  function go(delta) { var next = current < 0 ? 0 : current + delta; if (next < 0) next = 0; if (next > items.length - 1) next = items.length - 1; items[next].el.scrollIntoView({ behavior: "smooth", block: "start" }); paint(next); }',
  '  document.addEventListener("keydown", function (e) { var t = e.target; if (e.ctrlKey || e.metaKey || (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))) return; if (e.key === "j" || e.key === "n" || (e.altKey && e.key === "ArrowDown")) { e.preventDefault(); go(1); } else if (e.key === "k" || e.key === "p" || (e.altKey && e.key === "ArrowUp")) { e.preventDefault(); go(-1); } });',
  '})();',
].join('\n');

export function renderConversationHtml(conversation, { exportedAt = new Date().toISOString(), sourceUrl = null, includeConversationId = false, includeTitle = true, includeMessageModels = true } = {}) {
  const provider = typeof conversation.provider === 'string' && conversation.provider.trim() ? conversation.provider.trim() : 'ChatGPT';
  const railItems = [];
  const messagesHtml = conversation.messages.map((message, index) => {
    const id = `m-${String(index + 1).padStart(4, '0')}`;
    const timestamp = formatTimestamp(message.createdAt);
    const timestampValue = timestampIso(message.createdAt);
    const blocks = message.textBlocks.map(renderBlock).join('') || '<p class="empty-message">[empty message]</p>';
    const copyButton = '<button class="copy-btn" type="button">Copy</button>';
    if (message.role === 'user') {
      railItems.push(`<li><a href="#${id}"><span>${escapeHtml(railLabel(messagePlainText(message)))}</span></a></li>`);
    }
    const hiddenClass = message.hidden ? ' message-hidden' : '';
    const datetime = timestampValue ? ` datetime="${escapeAttribute(timestampValue)}"` : '';
    return `<article class="message ${escapeAttribute(message.role)} message-${escapeAttribute(message.role)}${hiddenClass}" id="${id}" data-message-index="${index + 1}" data-message-id="${escapeAttribute(message.id)}" dir="auto"><header class="message-header"><h2>${escapeHtml(message.authorLabel)}${messageModelLine(message, includeMessageModels)}${timestamp ? `<span class="msg-time"><time${datetime}>${escapeHtml(timestamp)}</time></span>` : ''}</h2></header>${copyButton}<div class="content message-body">${blocks}</div></article>`;
  }).join('\n');

  const branchNote = conversation.activeBranch ? `Active ${provider} conversation branch exported.` : `${provider} message array exported.`;
  const rawTitle = includeTitle ? conversation.title : `${provider} conversation`;
  const title = escapeHtml(rawTitle);
  const idMeta = includeConversationId && conversation.conversationId ? `<meta name="conversation-id" content="${escapeAttribute(conversation.conversationId)}">` : '';
  const sourceBlock = sourceUrl ? `<p class="meta">Source: <a href="${escapeAttribute(sourceUrl)}" rel="noopener noreferrer">${escapeHtml(sourceUrl)}</a></p>` : '';
  const metadata = `<p class="meta">Exported ${escapeHtml(exportedAt)} · ${conversation.stats.messageCount} message${conversation.stats.messageCount === 1 ? '' : 's'} (${escapeHtml(roleCounts(conversation.messages, provider))})</p>`;
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
<nav id="rail" aria-label="Prompts"><h2>Prompts</h2><ol>${railItems.join('')}</ol></nav>
<div class="wrap">
<header class="export-head">
  <h1>${title}</h1>
  ${metadata}
  ${modelLine}
  ${statsLine}
  ${sourceBlock}
  ${omissionLine}
  ${imageLine}
  ${coverageLine}
  ${hiddenLine}
  </header>
<main>
<section aria-label="Conversation messages">
${messagesHtml}
</section>
<footer class="export-footer">${escapeHtml(branchNote)} Generated locally by chatgpt-thread-archiver ${ARCHIVER_VERSION}. This file was generated locally and is designed to work offline.</footer>
</main>
</div>
<script>${EXPORT_JS}</script>
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
