// ==UserScript==
// @name         Claude Attachment Probe (temporary diagnostic)
// @namespace    https://github.com/Satejp10/chatgpt-thread-archiver
// @version      0.1.1
// @description  One-off diagnostic. Reports ONLY structural field names, value types, and redacted route shapes for Claude attachments, so image-upload support can be built against the real payload instead of a guess. Never outputs prompts, file names, image bytes, full URLs, or conversation text.
// @match        https://claude.ai/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * TEMPORARY DIAGNOSTIC — NOT PART OF THE SHIPPING EXPORTER.
 *
 * Why it exists:  the exporter embeds images on ChatGPT but not on Claude, because
 *                 Claude image support was never built. Claude's conversation API is
 *                 undocumented, so the field that carries a fetchable image URL is
 *                 unknown. This probe reports that shape without exposing content.
 *
 * What it reads:  the same signed-in conversation record the exporter already reads,
 *                 plus one HEAD-style request per distinct attachment URL to learn
 *                 whether the bytes are reachable same-origin.
 *
 * What it prints: field NAMES, value TYPES, redacted route shapes such as
 *                 /api/<id:36>/files/<id:36>/preview, HTTP status categories, and
 *                 whether a response's content type is an image.
 *
 * What it never prints: prompts, message text, file names, image bytes, full or
 *                 signed URLs, query-string values, conversation IDs, organization
 *                 IDs, tokens, cookies, or headers.
 *
 * Delete this file once the question is answered.
 */

(() => {
  'use strict';

  const MAX_ATTACHMENTS = 10;
  const MAX_DEPTH = 5;
  const SAFE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;

  const isObj = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

  // A path segment is kept only when it is a short, non-identifier-looking word such as
  // "api", "files" or "preview". Anything long, or carrying digits mixed with letters,
  // is an identifier and is reduced to its length.
  function redactSegment(segment) {
    if (!segment) return segment;
    if (segment.length > 24) return `<id:${segment.length}>`;
    if (/^[0-9a-f-]{16,}$/i.test(segment)) return `<id:${segment.length}>`;
    if (/\d/.test(segment) && /[a-z]/i.test(segment) && segment.length > 12) return `<id:${segment.length}>`;
    if (/^\d+$/.test(segment)) return '<num>';
    return /^[a-z0-9_.-]+$/i.test(segment) ? segment : `<seg:${segment.length}>`;
  }

  // Query values are never printed. Parameter names are, and only when they are short
  // and identifier-shaped — a signed URL's signature lives in the value, not the name.
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

  function describe(key, value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `array[${value.length}]`;
    if (isObj(value)) return `object{${Object.keys(value).length}}`;
    const type = typeof value;
    if (type === 'boolean' || type === 'number') return `${type}:${value}`;
    if (type !== 'string') return type;
    const trimmed = value.trim();
    // Route shapes are the point of this probe, so a URL-ish field is shown redacted.
    if (URLISH_KEY_RE.test(key) || /^https?:\/\//i.test(trimmed) || trimmed.startsWith('/api/')) {
      return `URL -> ${routeShape(trimmed)}`;
    }
    // A short, plain token (a MIME type, a "file_kind", an extension) is safe to show.
    if (SAFE_TOKEN_RE.test(trimmed) && !/\s/.test(trimmed)) return `string:"${trimmed}"`;
    if (/^[a-z]+\/[a-z0-9.+-]+$/i.test(trimmed)) return `mime:"${trimmed}"`;
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

  function conversationId() {
    const parts = location.pathname.split('/').filter(Boolean);
    return parts[0] === 'chat' ? parts[1] || null : null;
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

  // Confirms only that the bytes are reachable with the signed-in session and that the
  // response is an image. The body is never read.
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

  function panel(text) {
    document.getElementById('claude-probe-panel')?.remove();
    const box = document.createElement('div');
    box.id = 'claude-probe-panel';
    box.style.cssText = 'position:fixed;inset:5% 5% auto 5%;z-index:2147483647;background:#111;color:#eee;border:1px solid #555;border-radius:8px;padding:12px;font:12px/1.4 ui-monospace,monospace;max-height:85vh;display:flex;flex-direction:column;gap:8px;box-shadow:0 8px 32px rgba(0,0,0,.5)';
    const area = document.createElement('textarea');
    area.readOnly = true;
    area.value = text;
    area.style.cssText = 'flex:1;min-height:50vh;width:100%;background:#000;color:#0f0;border:1px solid #333;border-radius:4px;padding:8px;font:12px/1.4 ui-monospace,monospace;resize:vertical';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px';
    const copy = document.createElement('button');
    copy.textContent = 'Copy';
    const close = document.createElement('button');
    close.textContent = 'Close';
    for (const button of [copy, close]) button.style.cssText = 'padding:6px 14px;cursor:pointer;border-radius:4px;border:1px solid #666;background:#222;color:#eee';
    copy.onclick = () => { area.select(); navigator.clipboard?.writeText(area.value); copy.textContent = 'Copied'; };
    close.onclick = () => box.remove();
    row.append(copy, close);
    box.append(area, row);
    document.body.appendChild(box);
  }

  const BUTTON_ID = 'claude-probe-button';
  const LABEL = 'Claude attachment probe';

  function makeButton() {
    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = LABEL;
    button.style.cssText = 'position:fixed;bottom:64px;right:16px;z-index:2147483646;padding:8px 14px;border-radius:6px;border:1px solid #666;background:#222;color:#eee;font:13px system-ui;cursor:pointer';
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Reading…';
      try {
        const org = organizationId();
        if (!org) throw new Error('no lastActiveOrg cookie — sign in and reload');
        const id = conversationId();
        if (!id) throw new Error('no conversation ID in this URL');
        panel(await probe(await conversation(org, id)));
      } catch (error) {
        panel(`PROBE FAILED: ${error.message}`);
      } finally {
        button.disabled = false;
        button.textContent = LABEL;
      }
    });
    return button;
  }

  // claude.ai is a single-page app: a client-side navigation never re-runs a userscript,
  // and a React re-render can drop a node appended to body. The shipping exporter
  // reinstalls its control on every DOM mutation for exactly this reason, and the probe
  // has to do the same or it simply never appears.
  function install() {
    const onConversation = conversationId() !== null;
    const existing = document.getElementById(BUTTON_ID);
    if (!onConversation) {
      existing?.remove();
      return;
    }
    if (existing || !document.body) return;
    document.body.appendChild(makeButton());
  }

  function boot() {
    if (!document.body) return window.setTimeout(boot, 50);
    install();
    if (window.MutationObserver && document.documentElement) {
      new MutationObserver(() => install()).observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  boot();
})();
