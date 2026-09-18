/*
 * TEMPORARY DIAGNOSTIC — console paste version. NOT part of the shipping exporter.
 *
 * Same job and same privacy boundary as claude-attachment-probe.user.js, without
 * Tampermonkey: open a Claude conversation that has an uploaded image, open the
 * browser console, paste this whole file, press Enter. The report is printed and
 * copied to the clipboard.
 *
 * What it prints: field NAMES, value TYPES, redacted route shapes such as
 *                 (same-origin) /api/<id:36>/files/<id:36>/preview, HTTP status
 *                 categories, and whether a response's content type is an image.
 *
 * What it never prints: prompts, message text, file names, image bytes, full or
 *                 signed URLs, query-string values, conversation IDs, organization
 *                 IDs, tokens, cookies, or headers.
 *
 * Delete this file once the question is answered.
 */

(async () => {
  'use strict';

  const MAX_ATTACHMENTS = 10;
  const MAX_DEPTH = 5;
  const SAFE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;

  const isObj = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

  function redactSegment(segment) {
    if (!segment) return segment;
    if (segment.length > 24) return `<id:${segment.length}>`;
    if (/^[0-9a-f-]{16,}$/i.test(segment)) return `<id:${segment.length}>`;
    if (/\d/.test(segment) && /[a-z]/i.test(segment) && segment.length > 12) return `<id:${segment.length}>`;
    if (/^\d+$/.test(segment)) return '<num>';
    return /^[a-z0-9_.-]+$/i.test(segment) ? segment : `<seg:${segment.length}>`;
  }

  function routeShape(rawUrl) {
    let parsed;
    try {
      parsed = new URL(String(rawUrl), location.origin);
    } catch {
      return `<unparseable url, len=${String(rawUrl).length}>`;
    }
    const sameOrigin = parsed.origin === location.origin;
    const origin = sameOrigin ? '(same-origin)' : `(cross-origin host, len=${parsed.hostname.length})`;
    const path = parsed.pathname.split('/').map(redactSegment).join('/');
    const names = [...parsed.searchParams.keys()].map((name) => (SAFE_TOKEN_RE.test(name) ? name : `<param:${name.length}>`));
    const query = names.length ? ` ?${names.join('&')}=<redacted>` : '';
    return `${origin} ${path}${query}`;
  }

  const URLISH_KEY_RE = /url|href|src|link|path|endpoint/i;
  // A short file name such as "a.png" is identifier-shaped enough to pass the safe-token
  // test, so name-ish keys are reported by length only. The shape is the point; the name
  // is the user's content.
  const NAMEISH_KEY_RE = /name|title|caption|text|label|filename/i;
  // A uuid is a private identifier, and it is short enough to pass the safe-token test.
  // Only its length matters here: support has to know the field carries an id, not which.
  const ID_VALUE_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$|^[0-9a-f]{16,}$/i;

  function describe(key, value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `array[${value.length}]`;
    if (isObj(value)) return `object{${Object.keys(value).length}}`;
    const type = typeof value;
    if (type === 'boolean' || type === 'number') return `${type}:${value}`;
    if (type !== 'string') return type;
    const trimmed = value.trim();
    if (URLISH_KEY_RE.test(key) || /^https?:\/\//i.test(trimmed) || trimmed.startsWith('/api/')) {
      return `URL -> ${routeShape(trimmed)}`;
    }
    if (/^[a-z]+\/[a-z0-9.+-]+$/i.test(trimmed)) return `mime:"${trimmed}"`;
    if (NAMEISH_KEY_RE.test(key)) return `string(len=${value.length})`;
    if (ID_VALUE_RE.test(trimmed)) return `<id:${trimmed.length}>`;
    if (SAFE_TOKEN_RE.test(trimmed) && !/\s/.test(trimmed)) return `string:"${trimmed}"`;
    return `string(len=${value.length})`;
  }

  function shape(obj, label, out, depth = 0) {
    const pad = '  '.repeat(depth);
    if (!isObj(obj)) return;
    if (depth > MAX_DEPTH) {
      out.push(`${pad}${label}: <depth limit>`);
      return;
    }
    out.push(`${pad}${label}:`);
    for (const key of Object.keys(obj).sort()) {
      const value = obj[key];
      if (isObj(value)) {
        shape(value, key, out, depth + 1);
        continue;
      }
      if (Array.isArray(value) && value.some(isObj)) {
        out.push(`${'  '.repeat(depth + 1)}${key} = array[${value.length}]`);
        value.slice(0, 3).forEach((item, i) => shape(item, `${key}[${i}]`, out, depth + 2));
        continue;
      }
      out.push(`${'  '.repeat(depth + 1)}${key} = ${describe(key, value)}`);
    }
  }

  function organizationId() {
    const prefix = 'lastActiveOrg=';
    const raw = document.cookie.split('; ').find((item) => item.startsWith(prefix));
    return raw ? decodeURIComponent(raw.slice(prefix.length)) : null;
  }

  // The console version is deliberately forgiving about the route: it takes the last
  // UUID-shaped path segment, so it still works if Claude moves conversations off
  // /chat/<id>. The userscript's strict route check is what kept the button hidden.
  function conversationId() {
    const parts = location.pathname.split('/').filter(Boolean);
    for (const part of [...parts].reverse()) {
      if (/^[A-Za-z0-9_-]{16,120}$/.test(part)) return part;
    }
    return null;
  }

  async function conversation(org, id) {
    const query = 'tree=true&rendering_mode=messages&render_all_tools=true';
    const res = await fetch(`/api/organizations/${encodeURIComponent(org)}/chat_conversations/${encodeURIComponent(id)}?${query}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`conversation request HTTP ${res.status}`);
    return res.json();
  }

  function statusCategory(status) {
    if (status >= 200 && status < 300) return `${status} ok`;
    if (status === 401 || status === 403) return `${status} auth-rejected`;
    if (status === 404) return `${status} not-found`;
    if (status >= 500) return `${status} server-error`;
    return String(status);
  }

  async function reachability(url) {
    try {
      const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      const type = String(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      const length = res.headers.get('content-length');
      const size = length && /^\d+$/.test(length) ? `${Math.round(Number(length) / 1024)} KB` : 'unknown size';
      return `${statusCategory(res.status)} · ${type || 'no content-type'} · ${size} · ${type.startsWith('image/') ? 'IS an image' : 'NOT an image'}`;
    } catch (error) {
      return `request failed (${error?.name ?? 'error'})`;
    }
  }

  function collectUrls(value, found, depth = 0) {
    if (depth > MAX_DEPTH) return;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/api/')) found.add(trimmed);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collectUrls(item, found, depth + 1);
      return;
    }
    if (isObj(value)) {
      for (const item of Object.values(value)) collectUrls(item, found, depth + 1);
    }
  }

  async function probe(convo) {
    const out = [];
    const blockTypes = new Map();
    const carriers = [];

    for (const message of Array.isArray(convo?.chat_messages) ? convo.chat_messages : []) {
      if (!isObj(message)) continue;
      const sender = String(message?.sender ?? '?');
      for (const block of Array.isArray(message?.content) ? message.content : []) {
        const kind = typeof block === 'string' ? 'string' : String(block?.type ?? 'object-untyped');
        const label = `${sender}/${kind}`;
        blockTypes.set(label, (blockTypes.get(label) ?? 0) + 1);
      }
      for (const key of ['files', 'attachments', 'files_v2', 'sync_sources']) {
        const list = message?.[key];
        if (Array.isArray(list) && list.length > 0 && carriers.length < MAX_ATTACHMENTS) {
          carriers.push({ sender, key, list });
        }
      }
    }

    out.push('=== CONTENT BLOCK CENSUS (sender/type = count) ===');
    for (const [label, count] of [...blockTypes].sort()) out.push(`  ${label} = ${count}`);
    out.push('');
    out.push('=== TOP-LEVEL MESSAGE KEYS SEEN (union across all messages) ===');
    const messageKeys = new Set();
    for (const message of Array.isArray(convo?.chat_messages) ? convo.chat_messages : []) {
      if (isObj(message)) for (const key of Object.keys(message)) messageKeys.add(key);
    }
    out.push(`  ${[...messageKeys].sort().join(', ') || '(none)'}`);

    out.push('');
    out.push(`=== ATTACHMENT CARRIERS FOUND: ${carriers.length} ===`);
    const urls = new Set();
    carriers.forEach(({ sender, key, list }, index) => {
      out.push('');
      out.push(`--- carrier #${index + 1}: ${sender}.${key}, ${list.length} entr${list.length === 1 ? 'y' : 'ies'} ---`);
      list.slice(0, 3).forEach((entry, i) => {
        shape(entry, `${key}[${i}]`, out, 1);
        collectUrls(entry, urls);
      });
    });

    out.push('');
    out.push(`=== REACHABILITY OF DISTINCT URL-SHAPED VALUES: ${urls.size} ===`);
    for (const url of [...urls].slice(0, MAX_ATTACHMENTS)) {
      out.push(`  ${routeShape(url)}`);
      out.push(`    -> ${await reachability(url)}`);
    }
    if (urls.size === 0) {
      out.push('  (none — the payload carries no URL-shaped field; support would need a');
      out.push('   separate file-download endpoint, so report the id-shaped keys above)');
    }

    return out.join('\n');
  }

  let report;
  try {
    const org = organizationId();
    if (!org) throw new Error('no lastActiveOrg cookie — sign in and reload');
    const id = conversationId();
    if (!id) throw new Error('no conversation ID in this URL');
    report = await probe(await conversation(org, id));
  } catch (error) {
    report = `PROBE FAILED: ${error.message}`;
  }

  console.log(report);
  try {
    await navigator.clipboard?.writeText(report);
    console.log('\n(copied to clipboard)');
  } catch {
    console.log('\n(clipboard blocked — select the text above and copy it)');
  }
})();
