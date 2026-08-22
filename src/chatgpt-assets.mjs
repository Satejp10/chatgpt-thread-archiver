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

export function candidateDownloadUrl(value) {
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

async function resolveOneImage(asset, conversationId, postId, auth, fetchImpl, timeoutMs) {
  const pointer = String(asset?.pointer ?? '');
  if (!pointer) return asAssetResult('unavailable', 'image asset pointer is missing');
  const direct = allowedAssetUrl(pointer);
  if (direct) return fetchImageBytes(fetchImpl, direct, auth.headers, timeoutMs);

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
      const result = await fetchImageBytes(fetchImpl, new URL(path, currentAssetOrigin()).toString(), auth.headers, timeoutMs);
      if (result.status === 'embedded') return result;
      lastReason = result.reason;
      continue;
    }
    const metadata = await readJsonResponse(response);
    const downloadUrl = candidateDownloadUrl(metadata);
    if (!downloadUrl) {
      lastReason = 'asset metadata had no approved same-origin estuary image URL';
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
  const imageBlocks = conversation.messages.flatMap((message) => (message.textBlocks ?? []).filter((block) => block.type === 'image').map((block) => ({ block, postId: message.id })));
  if (imageBlocks.length === 0) return { ...conversation, stats: { ...conversation.stats, imageCount: 0, imageEmbeddedCount: 0, imageUnavailableCount: 0, imageBytes: 0 } };

  const auth = await getAuthContext(fetchImpl);
  const cache = new Map();
  let completed = 0;
  for (const block of imageBlocks) {
    const pointer = String(block.block.asset?.pointer ?? '');
    if (!cache.has(pointer)) {
      cache.set(pointer, await resolveOneImage(block.block.asset, conversationId, block.postId, auth, fetchImpl, timeoutMs));
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
