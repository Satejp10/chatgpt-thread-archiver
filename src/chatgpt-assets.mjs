const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
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

function imageRequestCandidates(fileId, conversationId) {
  const fid = encodeURIComponent(fileId);
  const cid = encodeURIComponent(conversationId);
  return [
    `/backend-api/files/download/${fid}?conversation_id=${cid}&inline=false`,
    `/backend-api/files/${fid}/${cid}`,
    `/backend-api/files/${fid}/simple`,
  ];
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
  if (!value || typeof value !== 'object') return null;
  const urls = [value.download_url, value.url, value.downloadUrl]
    .filter((item) => typeof item === 'string' && item.trim());
  for (const raw of urls) {
    const allowed = allowedAssetUrl(raw);
    if (allowed) return allowed;
  }
  return null;
}

function bytesToDataUrl(bytes, mime) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

async function fetchImageBytes(fetchImpl, url, headers, timeoutMs) {
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
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_IMAGE_BYTES) return asAssetResult('unavailable', 'image exceeds the 3 MB embedded size limit');
  const bytes = new Uint8Array(buffer);
  return asAssetResult('embedded', null, { dataUrl: bytesToDataUrl(bytes, contentType), mimeType: contentType, byteLength: buffer.byteLength });
}

async function resolveOneImage(asset, conversationId, auth, fetchImpl, timeoutMs) {
  const pointer = String(asset?.pointer ?? '');
  if (!pointer) return asAssetResult('unavailable', 'image asset pointer is missing');
  const direct = allowedAssetUrl(pointer);
  if (direct) return fetchImageBytes(fetchImpl, direct, auth.headers, timeoutMs);

  const fileId = assetFileId(pointer);
  if (!fileId) return asAssetResult('unavailable', 'no file identifier was found in the image asset pointer');
  const candidates = imageRequestCandidates(fileId, conversationId);
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
      const result = await fetchImageBytes(fetchImpl, new URL(path, currentAssetOrigin()).toString(), auth.headers, timeoutMs);
      if (result.status === 'embedded') return result;
      lastReason = result.reason;
      continue;
    }
    const metadata = await readJsonResponse(response);
    const downloadUrl = candidateDownloadUrl(metadata);
    if (!downloadUrl) {
      lastReason = 'asset metadata did not contain a same-origin estuary download URL';
      continue;
    }
    const result = await fetchImageBytes(fetchImpl, downloadUrl, auth.headers, timeoutMs);
    if (result.status === 'embedded') return result;
    lastReason = result.reason;
  }
  return asAssetResult('unavailable', lastReason, { fileId });
}

export async function resolveConversationImages(conversation, { fetchImpl = globalThis.fetch, conversationId, timeoutMs = 20_000, onProgress } = {}) {
  if (!conversation || !Array.isArray(conversation.messages)) return conversation;
  const imageBlocks = conversation.messages.flatMap((message) => (message.textBlocks ?? []).filter((block) => block.type === 'image'));
  if (imageBlocks.length === 0) return { ...conversation, stats: { ...conversation.stats, imageCount: 0, imageEmbeddedCount: 0, imageUnavailableCount: 0, imageBytes: 0 } };

  const auth = await getAuthContext(fetchImpl);
  const cache = new Map();
  let completed = 0;
  for (const block of imageBlocks) {
    const pointer = String(block.asset?.pointer ?? '');
    if (!cache.has(pointer)) {
      cache.set(pointer, await resolveOneImage(block.asset, conversationId, auth, fetchImpl, timeoutMs));
    }
    completed += 1;
    onProgress?.(completed, imageBlocks.length);
  }

  let embeddedCount = 0;
  let unavailableCount = 0;
  let imageBytes = 0;
  const messages = conversation.messages.map((message) => ({
    ...message,
    textBlocks: (message.textBlocks ?? []).map((block) => {
      if (block.type !== 'image') return block;
      const result = cache.get(String(block.asset?.pointer ?? '')) ?? asAssetResult('unavailable', 'image resolution did not run');
      if (result.status === 'embedded') {
        embeddedCount += 1;
        imageBytes += result.byteLength ?? 0;
      } else {
        unavailableCount += 1;
      }
      return { ...block, asset: { ...block.asset, ...result } };
    }),
  }));
  return {
    ...conversation,
    messages,
    stats: { ...conversation.stats, imageCount: imageBlocks.length, imageEmbeddedCount: embeddedCount, imageUnavailableCount: unavailableCount, imageBytes },
  };
}
