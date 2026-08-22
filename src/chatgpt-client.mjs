const DEFAULT_TIMEOUT_MS = 20_000;
const TOKEN_TTL_MS = 60_000;
const CONVERSATION_PATH_RE = /^\/backend-api\/conversation\/[A-Za-z0-9_-]{1,100}(?:\?[A-Za-z0-9_=&-]{0,200})?$/;
let cachedAccessToken = null;
let tokenFetchedAt = 0;
let authInvalidationInstalled = false;
let lastObservedLocation = '';

export class ChatGPTClientError extends Error {
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

export function parseConversationRoute(url = globalThis.location?.href ?? '') {
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

export function getConversationIdFromUrl(url = globalThis.location?.href ?? '') {
  const route = parseConversationRoute(url);
  return route.kind === 'conversation' ? route.conversationId : null;
}

export function isChatGPTHost(locationLike = globalThis.location) {
  const host = locationLike?.hostname ?? '';
  return host === 'chatgpt.com' || host === 'chat.openai.com';
}

export function isExporterRoute(url = globalThis.location?.href ?? '') {
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

export function clearAccessTokenCache() {
  cachedAccessToken = null;
  tokenFetchedAt = 0;
}

export function observeLocationChange() {
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

export function installAuthCacheInvalidation() {
  if (authInvalidationInstalled) return;
  authInvalidationInstalled = true;
  lastObservedLocation = globalThis.location?.href ?? '';
  globalThis.document?.addEventListener?.('visibilitychange', () => {
    if (globalThis.document.hidden) clearAccessTokenCache();
  });
  globalThis.addEventListener?.('popstate', observeLocationChange);
}

export function getResourceHints(conversationId = '') {
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

export function endpointCandidates(conversationId, resourceHints = getResourceHints(conversationId)) {
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

export async function getAuthContext(fetchImpl = globalThis.fetch) {
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

export async function fetchConversation(conversationId, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
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

export function describeClientError(error) {
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
