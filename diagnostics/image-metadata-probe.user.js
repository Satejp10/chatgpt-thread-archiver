// ==UserScript==
// @name         ChatGPT Image Metadata Probe (temporary diagnostic)
// @namespace    https://github.com/Satejp10/chatgpt-thread-archiver
// @version      0.2.0
// @description  One-off diagnostic. Reports ONLY structural field names for generated images so we can learn whether ChatGPT exposes an image-model identifier. Never outputs prompts, image bytes, URLs, or conversation text.
// @match        https://chatgpt.com/c/*
// @match        https://chatgpt.com/g/*
// @match        https://chatgpt.com/s/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * TEMPORARY DIAGNOSTIC — NOT PART OF THE SHIPPING EXPORTER.
 *
 * What it reads:  the same signed-in conversation record the exporter already reads.
 * What it prints: field NAMES and value TYPES only, plus the literal value of a field
 *                 ONLY when that field's name looks model-related AND its value passes
 *                 the exporter's safe-identifier test.
 * What it never prints: prompts, captions, message text, image bytes, asset URLs,
 *                 conversation IDs, tokens, cookies, headers, or any free-form string.
 *
 * Delete this file once the question is answered.
 */

(() => {
  'use strict';

  const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,120}$/;
  const MODELISH_KEY_RE = /model|engine|generator|version/i;
  const MAX_IMAGES = 12;

  const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

  // A value is only ever printed if its key looks model-related and it is a short,
  // identifier-shaped string. Everything else is reduced to its type.
  function describe(key, value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `array[${value.length}]`;
    if (isObj(value)) return `object{${Object.keys(value).length}}`;
    const type = typeof value;
    if (type === 'boolean' || type === 'number') return `${type}:${value}`;
    if (type === 'string') {
      const trimmed = value.trim();
      if (MODELISH_KEY_RE.test(key) && SAFE_ID_RE.test(trimmed)) return `string:"${trimmed}"`;
      return `string(len=${value.length})`;
    }
    return type;
  }

  const MAX_DEPTH = 5;

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

  function conversationId() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts[0] === 'g' && parts[2] === 'c') return parts[3] || null;
    const i = parts.findIndex((p) => p === 'c' || p === 's');
    return i >= 0 ? parts[i + 1] || null : null;
  }

  async function token() {
    const res = await fetch('/api/auth/session?unstable_client=true', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`session lookup HTTP ${res.status}`);
    const body = await res.json();
    return body?.accessToken ?? body?.access_token ?? body?.token ?? null;
  }

  function cookie(name) {
    return document.cookie.split('; ').find((c) => c.startsWith(`${name}=`))?.split('=')[1] ?? null;
  }

  async function conversation(id) {
    const bearer = await token();
    const did = cookie('oai-did') || cookie('oai-device-id');
    const res = await fetch(`/backend-api/conversation/${encodeURIComponent(id)}`, {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(did ? { 'oai-device-id': did } : {}),
      },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`conversation request HTTP ${res.status}`);
    return res.json();
  }

  function isImagePart(part) {
    if (!isObj(part)) return false;
    const type = String(part.content_type ?? part.type ?? '').toLowerCase();
    return type.includes('image') || 'asset_pointer' in part || 'image_url' in part;
  }

  function probe(convo) {
    const out = [];
    const partTypes = new Map();
    const images = [];

    for (const node of Object.values(convo?.mapping ?? {})) {
      const message = node?.message;
      if (!isObj(message)) continue;
      const parts = message?.content?.parts;
      const role = message?.author?.role ?? '?';
      const recipient = message?.recipient ?? '?';

      if (!Array.isArray(parts) || parts.length === 0) {
        const label = `${role}/${recipient}/${message?.content?.content_type ?? 'none'}/no-parts`;
        partTypes.set(label, (partTypes.get(label) ?? 0) + 1);
        continue;
      }

      for (const part of parts) {
        const kind = typeof part === 'string'
          ? 'string'
          : String(part?.content_type ?? part?.type ?? 'object-untyped');
        const label = `${role}/${recipient}/${kind}`;
        partTypes.set(label, (partTypes.get(label) ?? 0) + 1);
        if (isImagePart(part) && images.length < MAX_IMAGES) images.push({ part, message });
      }
    }

    out.push('=== PART TYPE CENSUS (role/recipient/content_type = count) ===');
    for (const [label, count] of [...partTypes].sort()) out.push(`  ${label} = ${count}`);

    out.push('');
    out.push(`=== IMAGE PARTS FOUND: ${images.length} ===`);
    images.forEach(({ part, message }, i) => {
      out.push('');
      out.push(`--- image #${i + 1} ---`);
      shape(part, 'part', out);
      if (isObj(message?.metadata)) shape(message.metadata, 'message.metadata', out);
      const slug = message?.metadata?.model_slug;
      out.push(`message.metadata.model_slug = ${typeof slug === 'string' && SAFE_ID_RE.test(slug) ? `"${slug}"` : 'absent/unsafe'}`);
    });

    return out.join('\n');
  }

  function panel(text) {
    document.getElementById('cgpt-probe-panel')?.remove();
    const box = document.createElement('div');
    box.id = 'cgpt-probe-panel';
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
    for (const b of [copy, close]) b.style.cssText = 'padding:6px 14px;cursor:pointer;border-radius:4px;border:1px solid #666;background:#222;color:#eee';
    copy.onclick = () => { area.select(); navigator.clipboard?.writeText(area.value); copy.textContent = 'Copied'; };
    close.onclick = () => box.remove();
    row.append(copy, close);
    box.append(area, row);
    document.body.appendChild(box);
  }

  const button = document.createElement('button');
  button.textContent = 'Image metadata probe';
  button.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483646;padding:8px 14px;border-radius:6px;border:1px solid #666;background:#222;color:#eee;font:13px system-ui;cursor:pointer';
  button.onclick = async () => {
    button.disabled = true;
    button.textContent = 'Reading…';
    try {
      const id = conversationId();
      if (!id) throw new Error('no conversation ID in this URL');
      panel(probe(await conversation(id)));
    } catch (error) {
      panel(`PROBE FAILED: ${error.message}`);
    } finally {
      button.disabled = false;
      button.textContent = 'Image metadata probe';
    }
  };
  document.body.appendChild(button);
})();
