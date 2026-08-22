// ==UserScript==
// @name         ChatGPT Thread Archiver
// @namespace    local.chatgpt-thread-archiver
// @version      0.5.0
// @description  Export the currently open ChatGPT conversation to self-contained HTML.
// @match        https://chatgpt.com/c/*
// @match        https://chatgpt.com/s/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
'use strict';
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
  return candidates;
}

function normalizePart(candidate, depth = 0) {
  const { kind: candidateKind, value } = candidate;
  if (candidateKind === 'attachment') return { kind: 'omitted', reason: 'attachment or file content' };
  if (depth > 16) return { kind: 'omitted', reason: 'nested content depth exceeded' };
  if (typeof value === 'string') return { kind: 'text', text: value };
  if (!isPlainObject(value)) return { kind: 'omitted', reason: 'non-text content part' };

  const type = String(value.content_type ?? value.type ?? value.kind ?? '').toLowerCase();
  if (typeof value.asset_pointer === 'string' && type.includes('image')) {
    const metadata = isPlainObject(value.metadata) ? value.metadata : {};
    return {
      kind: 'image',
      asset: {
        pointer: value.asset_pointer,
        mimeType: value.mime_type ?? '',
        sizeBytes: Number.isFinite(value.size_bytes) ? value.size_bytes : null,
        width: Number.isFinite(value.width) ? value.width : null,
        height: Number.isFinite(value.height) ? value.height : null,
        generated: Boolean(metadata.dalle || metadata.generation),
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
    textBlocks: extracted.blocks,
    omittedCount: extracted.omittedCount,
    hidden,
  };
}

function normalizeConversation(raw) {
  if (!isPlainObject(raw)) throw new ConversationShapeError('Conversation response was not a JSON object.');

  const title = asNonEmptyString(raw.title) ?? asNonEmptyString(raw.name) ?? 'ChatGPT conversation';
  const conversationId = asNonEmptyString(raw.conversation_id) ?? asNonEmptyString(raw.conversationId) ?? null;
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

function renderBlock(block) {
  if (block.type === 'omitted') return `<p class="omitted">[non-text content omitted: ${escapeHtml(block.reason)}]</p>`;
  if (block.type === 'image') {
    const asset = block.asset ?? {};
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

function roleCounts(messages) {
  const counts = new Map();
  for (const message of messages) counts.set(message.role, (counts.get(message.role) ?? 0) + 1);
  return [...counts.entries()].map(([role, count]) => `${count} ${ROLE_LABELS[role] ?? role}`).join(', ');
}

function railLabel(text) {
  const flat = String(text ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > 72 ? `${flat.slice(0, 71)}…` : (flat || 'Untitled prompt');
}

const EXPORT_CSS = `
:root { color-scheme: light; --bg: #f9f9f9; --surface: #fff; --text: #24292f; --muted: #57606a; --border: #e0e0e0; --user: #eef2ff; --assistant: #fff; --accent: #10a37f; --link: #0969da; }
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
.message { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 15px 18px; margin-bottom: 20px; position: relative; box-shadow: 0 2px 4px rgb(0 0 0 / .05); scroll-margin-top: 16px; }
.message.user { background: var(--user); border-color: #d1d8ff; }
.message:target { outline: 2px solid var(--accent); outline-offset: 2px; }
.message h2 { margin: 0; font-size: .95em; color: var(--muted); font-weight: 600; letter-spacing: .02em; }
.msg-time { font-weight: 400; letter-spacing: 0; color: #8b949e; margin-left: 8px; font-size: .92em; }
.content { overflow-wrap: anywhere; margin-top: 10px; }
.content a { color: var(--link); }
.content p { margin: 0 0 12px; }
.content p:last-child { margin-bottom: 0; }
.content code { background: rgb(175 184 193 / .2); padding: .15em .35em; border-radius: 4px; font-size: .9em; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.image-block { margin: 14px 0; text-align: center; }
.image-block img { display: inline-block; max-width: 100%; height: auto; border-radius: 6px; border: 1px solid var(--border); background: #fff; }
.image-block figcaption { margin-top: 6px; color: var(--muted); font-size: .82em; }

.content pre { white-space: pre; overflow-x: auto; background: #1f2328; color: #e6edf3; padding: 12px 14px; border-radius: 6px; margin: 12px 0; }
.content pre code { background: none; padding: 0; color: inherit; font-size: .88em; }
.omitted, .empty-message { color: var(--muted); font-style: italic; }
.export-footer { margin-top: 28px; color: var(--muted); font-size: .82rem; }
.copy-btn { position: absolute; top: 12px; right: 12px; padding: 4px 10px; background: var(--accent); color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
.copy-btn:hover { background: #0d8a6a; }
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

function renderConversationHtml(conversation, { exportedAt = new Date().toISOString(), sourceUrl = null, includeConversationId = false, includeTitle = true } = {}) {
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
    return `<article class="message ${escapeAttribute(message.role)} message-${escapeAttribute(message.role)}${hiddenClass}" id="${id}" data-message-index="${index + 1}" data-message-id="${escapeAttribute(message.id)}" dir="auto"><header class="message-header"><h2>${escapeHtml(message.authorLabel)}${timestamp ? `<span class="msg-time"><time${datetime}>${escapeHtml(timestamp)}</time></span>` : ''}</h2></header>${copyButton}<div class="content message-body">${blocks}</div></article>`;
  }).join('\n');

  const branchNote = conversation.activeBranch ? 'Active conversation branch exported.' : 'Message-array conversation exported.';
  const rawTitle = includeTitle ? conversation.title : 'ChatGPT conversation';
  const title = escapeHtml(rawTitle);
  const idMeta = includeConversationId && conversation.conversationId ? `<meta name="conversation-id" content="${escapeAttribute(conversation.conversationId)}">` : '';
  const sourceBlock = sourceUrl ? `<p class="meta">Source: <a href="${escapeAttribute(sourceUrl)}" rel="noopener noreferrer">${escapeHtml(sourceUrl)}</a></p>` : '';
  const metadata = `<p class="meta">Exported ${escapeHtml(exportedAt)} · ${conversation.stats.messageCount} message${conversation.stats.messageCount === 1 ? '' : 's'} (${escapeHtml(roleCounts(conversation.messages))})</p>`;
  const omissionLine = conversation.stats.omittedBlockCount > 0
    ? `<p class="meta flag-warn">${conversation.stats.omittedBlockCount} omitted non-text block${conversation.stats.omittedBlockCount === 1 ? '' : 's'}</p>`
    : '<p class="meta flag-ok">Text blocks complete</p>';
  const imageLine = Number.isFinite(conversation.stats.imageCount) && conversation.stats.imageCount > 0
    ? `<p class="meta">Images: ${conversation.stats.imageEmbeddedCount ?? 0} embedded, ${conversation.stats.imageUnavailableCount ?? 0} unavailable${conversation.stats.imageBudgetLimitedCount ? `; ${conversation.stats.imageBudgetLimitedCount} limited by export budget` : ''}${Number(conversation.stats.imageBytes) > 0 ? ` · ${Math.ceil(Number(conversation.stats.imageBytes) / 1024)} KB embedded` : ''}</p>`
    : '';
  const coverageLine = (conversation.stats.droppedNodeCount ?? 0) > 0 || (conversation.stats.duplicateMessageCount ?? 0) > 0
    ? `<p class="meta flag-warn">Coverage: ${conversation.stats.droppedNodeCount ?? 0} dropped node${conversation.stats.droppedNodeCount === 1 ? '' : 's'}, ${conversation.stats.duplicateMessageCount ?? 0} duplicate message${conversation.stats.duplicateMessageCount === 1 ? '' : 's'} removed</p>`
    : '';
  const hiddenLine = (conversation.stats.hiddenMessageCount ?? 0) > 0
    ? `<p class="meta flag-warn">${conversation.stats.hiddenMessageCount} message${conversation.stats.hiddenMessageCount === 1 ? '' : 's'} marked hidden by ChatGPT; included unchanged</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="chatgpt-thread-archiver 0.5.0">
<meta name="exported-at" content="${escapeAttribute(exportedAt)}">
${idMeta}
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">
<title>${title}</title>
<style>${EXPORT_CSS}</style>
</head>
<body>
<button id="rail-toggle" type="button" aria-controls="rail" aria-expanded="true">Hide</button>
<nav id="rail" aria-label="Prompts"><h2>Prompts</h2><ol>${railItems.join('')}</ol></nav>
<div class="wrap">
<header class="export-head">
<h1>${title}</h1>
${metadata}
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
<footer class="export-footer">${escapeHtml(branchNote)} Generated locally by chatgpt-thread-archiver 0.5.0. This file was generated locally and is designed to work offline.</footer>
</main>
</div>
<script>${EXPORT_JS}</script>
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

function parseConversationRoute(url = globalThis.location?.href ?? '') {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const routeIndex = parts.findIndex((part) => part === 'c' || part === 'conversation');
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
    return parsed.hostname === 'chatgpt.com' && /^\/(?:c|s)\/.+/.test(parsed.pathname);
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
  const routeIndex = parts.findIndex((part) => part === 'c' || part === 'conversation' || part === 'share');
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

const IMAGE_LIMITS = Object.freeze({ perImageBytes: 3 * 1024 * 1024, totalBytes: 12 * 1024 * 1024, embeddedImageCount: 64 });
const MAX_IMAGE_BYTES = IMAGE_LIMITS.perImageBytes;
const MAX_TOTAL_IMAGE_BYTES = IMAGE_LIMITS.totalBytes;
const MAX_EMBEDDED_IMAGE_COUNT = IMAGE_LIMITS.embeddedImageCount;

function applyImageBudget(result, { embeddedCount = 0, imageBytes = 0 } = {}, limits = IMAGE_LIMITS) {
  if (result?.status !== 'embedded') return result;
  if (embeddedCount >= limits.embeddedImageCount) return { status: 'unavailable', reason: `export exceeds the ${limits.embeddedImageCount} embedded-image limit`, budgetLimited: true };
  if (imageBytes + (result.byteLength ?? 0) > limits.totalBytes) return { status: 'unavailable', reason: `export exceeds the ${Math.round(limits.totalBytes / (1024 * 1024))} MiB total embedded image budget`, budgetLimited: true };
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

function allowedAssetUrl(raw) {
  try {
    const url = new URL(raw, currentAssetOrigin());
    if (url.origin !== currentAssetOrigin()) return null;
    const isEstuary = url.pathname === '/backend-api/estuary/content';
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

function bytesToDataUrl(bytes, mime) {
  let binary = '';
  const chunkSize = 0x2000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

async function fetchImageBytes(fetchImpl, url, headers, timeoutMs, remainingBytes = Infinity) {
  const response = await fetchWithTimeout(fetchImpl, url, {
    method: 'GET',
    credentials: 'same-origin',
    headers,
    cache: 'no-store',
  }, timeoutMs);
  if (!response.ok) return asAssetResult('unavailable', `asset HTTP ${response.status}`);
  const contentType = safeImageMime(response.headers.get('content-type'));
  if (!contentType) return asAssetResult('unavailable', 'asset response was not a supported image');
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_IMAGE_BYTES) return asAssetResult('unavailable', 'image exceeds the 3 MB embedded size limit');
  if (Number.isFinite(declaredSize) && declaredSize > remainingBytes) return asAssetResult('unavailable', 'image exceeds the 12 MiB total embedded image budget', { budgetLimited: true });
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_IMAGE_BYTES) return asAssetResult('unavailable', 'image exceeds the 3 MB embedded size limit');
  if (buffer.byteLength > remainingBytes) return asAssetResult('unavailable', 'image exceeds the 12 MiB total embedded image budget', { budgetLimited: true });
  const bytes = new Uint8Array(buffer);
  return asAssetResult('embedded', null, { dataUrl: bytesToDataUrl(bytes, contentType), mimeType: contentType, byteLength: buffer.byteLength });
}

async function resolveOneImage(asset, conversationId, postId, auth, fetchImpl, timeoutMs, remainingBytes) {
  const pointer = String(asset?.pointer ?? '');
  if (!pointer) return asAssetResult('unavailable', 'image asset pointer is missing');
  const direct = allowedAssetUrl(pointer);
  if (direct) return fetchImageBytes(fetchImpl, direct, auth.headers, timeoutMs, remainingBytes);

  const fileId = assetFileId(pointer);
  if (!fileId) return asAssetResult('unavailable', 'no file identifier was found in the image asset pointer');
  const candidates = imageRequestCandidates(fileId, conversationId, postId);
  let lastReason = 'no image download URL was returned';
  for (const path of candidates) {
    let response;
    try {
      response = await fetchWithTimeout(fetchImpl, new URL(path, currentAssetOrigin()).toString(), {
        method: 'GET',
        credentials: 'same-origin',
        headers: auth.headers,
        cache: 'no-store',
      }, timeoutMs);
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
      const result = await fetchImageBytes(fetchImpl, new URL(path, currentAssetOrigin()).toString(), auth.headers, timeoutMs, remainingBytes);
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
    const result = await fetchImageBytes(fetchImpl, downloadUrl, auth.headers, timeoutMs, remainingBytes);
    if (result.status === 'embedded') return result;
    if (result.budgetLimited) return result;
    lastReason = result.reason;
  }
  return asAssetResult('unavailable', lastReason, { fileId });
}

async function resolveConversationImages(conversation, { fetchImpl = globalThis.fetch, conversationId, timeoutMs = 20_000, onProgress, limits = IMAGE_LIMITS } = {}) {
  if (!conversation || !Array.isArray(conversation.messages)) return conversation;
  const imageBlocks = conversation.messages.flatMap((message) => (message.textBlocks ?? []).filter((block) => block.type === 'image').map((block) => ({ block, postId: message.id })));
  if (imageBlocks.length === 0) return { ...conversation, stats: { ...conversation.stats, imageCount: 0, imageEmbeddedCount: 0, imageUnavailableCount: 0, imageBytes: 0, imageBudgetLimitedCount: 0 } };

  const auth = await getAuthContext(fetchImpl);
  const cache = new Map();
  const occurrenceResults = [];
  let completed = 0;
  let embeddedCount = 0;
  let unavailableCount = 0;
  let imageBytes = 0;
  let budgetLimitedCount = 0;
  for (const block of imageBlocks) {
    const pointer = String(block.block.asset?.pointer ?? '');
    if (!cache.has(pointer)) {
      const budgetExhausted = embeddedCount >= limits.embeddedImageCount || imageBytes >= limits.totalBytes;
      cache.set(pointer, budgetExhausted
        ? asAssetResult('unavailable', embeddedCount >= limits.embeddedImageCount ? `export exceeds the ${limits.embeddedImageCount} embedded-image limit` : `export exceeds the ${Math.round(limits.totalBytes / (1024 * 1024))} MiB total embedded image budget`, { budgetLimited: true })
        : await resolveOneImage(block.block.asset, conversationId, block.postId, auth, fetchImpl, timeoutMs, limits.totalBytes - imageBytes));
    }
    let result = cache.get(pointer) ?? asAssetResult('unavailable', 'image resolution did not run');
    const budgetedResult = applyImageBudget(result, { embeddedCount, imageBytes }, limits);
    if (budgetedResult !== result) result = budgetedResult;
    if (result.status === 'embedded') {
      embeddedCount += 1;
      imageBytes += result.byteLength ?? 0;
    }
    if (result.status !== 'embedded') {
      unavailableCount += 1;
      if (result.budgetLimited) budgetLimitedCount += 1;
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
    stats: { ...conversation.stats, imageCount: imageBlocks.length, imageEmbeddedCount: embeddedCount, imageUnavailableCount: unavailableCount, imageBytes, imageBudgetLimitedCount: budgetLimitedCount },
  };
}

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
        ? ` ${conversation.stats.imageEmbeddedCount} image(s) embedded; ${conversation.stats.imageUnavailableCount} unavailable${conversation.stats.imageBudgetLimitedCount ? `; ${conversation.stats.imageBudgetLimitedCount} limited by export budget` : ''}.`
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
    if (!isChatGPTHost() || !isExporterRoute()) return;
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
    if (window.MutationObserver && document.documentElement) {
      const observer = new MutationObserver(() => install());
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  boot();
})();

})();
