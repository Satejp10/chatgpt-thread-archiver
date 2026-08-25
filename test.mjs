import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeConversation, renderConversationHtml, sanitizeFilename, textToBlocks, ConversationShapeError, selectConversationBranch } from './src/core.mjs';
import { ChatGPTClientError, clearAccessTokenCache, describeClientError, endpointCandidates, getAuthContext, getConversationIdFromUrl, isExporterRoute, parseConversationRoute } from './src/chatgpt-client.mjs';
import { applyImageBudget, candidateDownloadUrl, IMAGE_LIMITS, resolveConversationImages } from './src/chatgpt-assets.mjs';
import { deriveExportStats } from './src/export-stats.mjs';
import { ClaudeClientError, claudeConversationPath, fetchClaudeConversation, getClaudeConversationIdFromUrl, isClaudeExporterRoute, normalizeClaudeConversation, parseClaudeConversationRoute } from './src/claude-client.mjs';

const load = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const clientSource = await readFile(new URL('./src/chatgpt-client.mjs', import.meta.url), 'utf8');
const coreSource = await readFile(new URL('./src/core.mjs', import.meta.url), 'utf8');
const uiSource = await readFile(new URL('./src/exporter-ui.js', import.meta.url), 'utf8');
const assetsSource = await readFile(new URL('./src/chatgpt-assets.mjs', import.meta.url), 'utf8');
const statsSource = await readFile(new URL('./src/export-stats.mjs', import.meta.url), 'utf8');
const claudeSource = await readFile(new URL('./src/claude-client.mjs', import.meta.url), 'utf8');
const buildSource = await readFile(new URL('./build.mjs', import.meta.url), 'utf8');

const simple = normalizeConversation(await load('simple-conversation.json'));
assert.equal(simple.messages.length, 2);
assert.equal(simple.messages[0].role, 'user');
assert.equal(simple.messages[1].role, 'assistant');
assert.equal(simple.stats.omittedBlockCount, 0);

const simpleHtml = renderConversationHtml(simple, { exportedAt: '2026-08-15T00:00:00.000Z' });
assert.match(simpleHtml, /A small test chat/);
assert.match(simpleHtml, /You/);
assert.match(simpleHtml, /ChatGPT/);
assert.match(simpleHtml, /&lt;world&gt;/);
assert.match(simpleHtml, /<strong>formatting<\/strong>/);
assert.match(simpleHtml, /const answer = 42;/);
assert.doesNotMatch(simpleHtml, /<world>/);
assert.match(simpleHtml, /data-message-index="2"/);
assert.match(simpleHtml, /class="message user message-user"/);
assert.match(simpleHtml, /class="content message-body"/);
assert.match(simpleHtml, /class="msg-time"/);
assert.match(simpleHtml, /id="m-0001"/);
assert.match(simpleHtml, /id="rail"/);
assert.match(simpleHtml, /id="rail-toggle"/);
assert.match(simpleHtml, /id="theme-toggle"/);
assert.match(simpleHtml, /Dark mode/);
assert.match(simpleHtml, /Light mode/);
assert.match(simpleHtml, /chatgpt-thread-archiver-theme/);
assert.match(simpleHtml, /html\.dark/);
assert.match(simpleHtml, /classList\.toggle\("dark"/);
assert.match(simpleHtml, /class="copy-btn"/);
assert.match(simpleHtml, /querySelector\("\.content"\)/);
assert.match(simpleHtml, /2 messages \(1 You, 1 ChatGPT\)/);
assert.match(simpleHtml, /Content-Security-Policy/);
assert.match(simpleHtml, /name="generator" content="chatgpt-thread-archiver 0\.9\.0"/);
assert.match(simpleHtml, /Generated locally by chatgpt-thread-archiver 0\.9\.0/);
assert.match(simpleHtml, /color-scheme: light/);
assert.match(simpleHtml, /scroll-margin-top: 16px/);
assert.match(simpleHtml, /\.content \{ overflow-wrap: anywhere; margin-top: 10px; \}/);
assert.doesNotMatch(simpleHtml, /\.content \{[^}]*white-space:\s*pre-wrap/);
assert.match(simpleHtml, /\.content pre \{ white-space: pre;/);
assert.doesNotMatch(simpleHtml, /name="conversation-id"/);
assert.doesNotMatch(simpleHtml, /Source:/);
assert.match(simpleHtml, /<script>\(function \(\)/);
assert.doesNotMatch(simpleHtml.match(/<script>[\s\S]*?<\/script>/)?.[0] ?? '', /A small test chat|world|formatting/);
const simpleStats = deriveExportStats(simple.messages, simple.stats, { model: 'gpt-5' });
assert.equal(simpleStats.messageCount, 2);
assert.equal(simpleStats.userMessageCount, 1);
assert.equal(simpleStats.assistantMessageCount, 1);
assert.equal(simpleStats.toolMessageCount, 0);
assert.ok(simpleStats.wordCount > 0);
assert.ok(simpleStats.characterCount > simpleStats.wordCount);
assert.deepEqual(simpleStats.modelsUsed, ['gpt-5']);
const statsHtml = renderConversationHtml({ ...simple, stats: simpleStats }, { exportedAt: '2026-08-15T00:00:00.000Z' });
assert.match(statsHtml, /Model: gpt-5/);
assert.match(statsHtml, /class="msg-model">Model: unknown \/ not found/);
const statsWithoutMessageModelsHtml = renderConversationHtml({ ...simple, stats: simpleStats }, { includeMessageModels: false });
assert.doesNotMatch(statsWithoutMessageModelsHtml, /class="msg-model"/);
assert.match(statsHtml, /Safe local stats:/);
assert.match(statsHtml, /Counted from exported text only; provider token and context-window usage are not included/);
assert.doesNotMatch(statsHtml, /Authorization|Bearer|OPENAI_API_KEY/);
const modelTagged = normalizeConversation({ title: 'Model tagged', mapping: { root: { parent: null, children: ['assistant'] }, assistant: { parent: 'root', children: [], message: { id: 'assistant', author: { role: 'assistant' }, metadata: { model_slug: 'gpt-5-mini' }, content: { parts: ['Answer'] } } } }, current_node: 'assistant' });
assert.equal(modelTagged.messages[1].modelSlug, 'gpt-5-mini');
assert.match(renderConversationHtml(modelTagged), /class="msg-model">Model: gpt-5-mini/);
assert.deepEqual(deriveExportStats(modelTagged.messages, modelTagged.stats, { model: modelTagged.model }).modelsUsed, ['gpt-5-mini']);
const railHrefs = [...simpleHtml.matchAll(/<a href="#(m-\d{4})"><span>/g)].map((match) => match[1]);
assert.deepEqual(railHrefs, ['m-0001']);
for (const href of railHrefs) assert.match(simpleHtml, new RegExp(`id="${href}"`));

const privateHtml = renderConversationHtml(simple, {
  exportedAt: '2026-08-15T00:00:00.000Z',
  sourceUrl: 'https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  includeConversationId: true,
});
assert.match(privateHtml, /name="conversation-id"/);
assert.match(privateHtml, /Source: <a href="https:\/\/chatgpt\.com\/c\//);

const noTitleHtml = renderConversationHtml(simple, { includeTitle: false });
assert.match(noTitleHtml, /<title>ChatGPT conversation<\/title>/);
assert.doesNotMatch(noTitleHtml, /A small test chat/);

const branching = normalizeConversation(await load('branching-conversation.json'));
assert.deepEqual(branching.messages.map((message) => message.id), ['u1', 'a2']);
assert.equal(branching.activeBranch, true);
assert.equal(branching.branches.length, 2);
assert.deepEqual(branching.branches[0].messages.map((message) => message.id), ['u1', 'a2']);
assert.deepEqual(branching.branches[1].messages.map((message) => message.id), ['u1', 'a1']);
assert.deepEqual(selectConversationBranch(branching, 1).messages.map((message) => message.id), ['u1', 'a1']);
const allBranchStats = deriveExportStats(branching.branches.flatMap((branch) => branch.messages), branching.stats, { model: branching.model });
const allBranchesHtml = renderConversationHtml({ ...branching, stats: allBranchStats }, { includeAllBranches: true });
assert.match(allBranchesHtml, /id="branch-nav"/);
assert.match(allBranchesHtml, /Branch 1\/2/);
assert.match(allBranchesHtml, /4 messages \(2 You, 2 ChatGPT\)/);
assert.match(allBranchesHtml, /First answer/);
assert.match(allBranchesHtml, /Second answer/);
assert.match(allBranchesHtml, /All ChatGPT conversation branches exported/);
assert.equal((allBranchesHtml.match(/class="branch-view"/g) ?? []).length, 2);
assert.match(allBranchesHtml, /branch-prev/);
assert.match(allBranchesHtml, /branch-next/);
assert.match(allBranchesHtml, /branch-view/);

const editedBranches = normalizeConversation(await load('edited-prompt-branches.json'));
assert.deepEqual(editedBranches.messages.map((message) => message.id), ['u1', 'u2', 'a2']);
assert.equal(editedBranches.branches.length, 2);
assert.deepEqual(editedBranches.branches[0].messages.map((message) => message.id), ['u1', 'u2', 'a2']);
assert.deepEqual(editedBranches.branches[1].messages.map((message) => message.id), ['u1', 'a1']);
assert.equal(editedBranches.stats.branchCount, 2);
const editedAllHtml = renderConversationHtml({ ...editedBranches, stats: deriveExportStats(editedBranches.branches.flatMap((branch) => branch.messages), editedBranches.stats) }, { includeAllBranches: true });
assert.match(editedAllHtml, /Original prompt/);
assert.match(editedAllHtml, /Edited prompt/);
assert.match(editedAllHtml, /Original answer/);
assert.match(editedAllHtml, /Edited answer/);

const long = normalizeConversation(await load('long-conversation.json'));
assert.equal(long.messages.length, 8);
assert.equal(long.messages[4].textBlocks[0].text, 'Message 5: special characters <tag> & "quotes"');

const toolConversation = normalizeConversation({
  title: 'Tool output',
  mapping: {
    root: { parent: null, children: ['tool-1'] },
    'tool-1': { parent: 'root', children: [], message: { id: 'tool-1', author: { role: 'tool' }, content: { parts: ['[L1] {\\"content\\":\\"# Audit\\\\n\\\\nFresh review of index.html\\"}'] } } },
  },
  current_node: 'tool-1',
});
const toolHtml = renderConversationHtml(toolConversation, { exportedAt: '2026-08-15T00:00:00.000Z' });
assert.match(toolHtml, /Fresh review of index\.html/);
assert.doesNotMatch(toolHtml, /\\\\n/);
const jsonTool = normalizeConversation({ title: 'JSON tool', mapping: { root: { parent: null, children: ['tool-2'] }, 'tool-2': { parent: 'root', children: [], message: { id: 'tool-2', author: { role: 'tool' }, content: { parts: ['{\\"path\\":\\"/tmp/report\\",\\"ok\\":true}'] } } } }, current_node: 'tool-2' });
const jsonToolHtml = renderConversationHtml(jsonTool, { exportedAt: '2026-08-15T00:00:00.000Z' });
assert.match(jsonToolHtml, /data-language="json"/);
assert.match(jsonToolHtml, /&quot;path&quot;: &quot;\/tmp\/report&quot;/);

const pastedJson = normalizeConversation({ title: 'Pasted JSON', mapping: { root: { parent: null, children: ['pasted'] }, pasted: { parent: 'root', children: [], message: { id: 'pasted', author: { role: 'tool' }, content: { parts: ['{\\"message\\":\\"hi\\\\nthere\\",\\"id\\":42,\\"secret\\":\\"keep-me\\"}'] } } } }, current_node: 'pasted' });
const pastedJsonHtml = renderConversationHtml(pastedJson);
assert.match(pastedJsonHtml, /hi<br>there/);
assert.match(pastedJsonHtml, /&quot;id&quot;: 42/);
assert.match(pastedJsonHtml, /&quot;secret&quot;: &quot;keep-me&quot;/);

const attachmentConversation = normalizeConversation({ title: 'Attachment', mapping: { root: { parent: null, children: ['attachment'] }, attachment: { parent: 'root', children: [], message: { id: 'attachment', author: { role: 'user' }, metadata: { attachments: [{ id: 'file-attachment', name: 'report.pdf' }] }, content: 'Attached report' } } }, current_node: 'attachment' });
assert.equal(attachmentConversation.stats.omittedBlockCount, 1);
assert.match(renderConversationHtml(attachmentConversation), /\[non-text content omitted: attachment or file content\]/);

const hiddenConversation = normalizeConversation({ title: 'Hidden', mapping: { root: { parent: null, children: ['hidden'] }, hidden: { parent: 'root', children: [], message: { id: 'hidden', author: { role: 'system' }, is_visually_hidden_from_conversation: true, content: { parts: ['hidden but intentionally retained'] } } } }, current_node: 'hidden' });
assert.equal(hiddenConversation.stats.hiddenMessageCount, 1);
assert.match(renderConversationHtml(hiddenConversation), /hidden by ChatGPT/);

const droppedConversation = normalizeConversation({ title: 'Dropped', mapping: { root: { parent: null, children: ['good'] }, good: { parent: 'root', children: ['bad'], message: { id: 'good', author: { role: 'user' }, content: { parts: ['kept'] } } }, bad: { parent: 'good', children: [], message: [] } }, current_node: 'bad' });
assert.equal(droppedConversation.stats.droppedNodeCount, 1);
assert.match(renderConversationHtml(droppedConversation), /Coverage: 1 dropped node/);

const chronologicalFallback = normalizeConversation({ title: 'Chronological branch', mapping: { root: { parent: null, children: ['branch-a', 'branch-b'], message: null }, 'branch-b': { parent: 'root', children: [], message: { id: 'branch-b', author: { role: 'assistant' }, create_time: 2000, content: { parts: ['newer branch'] } } }, 'branch-a': { parent: 'root', children: [], message: { id: 'branch-a', author: { role: 'assistant' }, create_time: 1000, content: { parts: ['older branch'] } } } } });
assert.deepEqual(chronologicalFallback.messages.map((message) => message.id), ['branch-b']);

const timestampConversation = normalizeConversation({ title: 'Timestamp', mapping: { root: { parent: null, children: ['timestamp'] }, timestamp: { parent: 'root', children: [], message: { id: 'timestamp', author: { role: 'user' }, create_time: '1755.0', content: { parts: ['time'] } } } }, current_node: 'timestamp' });
assert.match(renderConversationHtml(timestampConversation), /datetime="1970-01-01T00:29:15\.000Z"/);

const duplicateParts = normalizeConversation({ title: 'Duplicate parts', mapping: { root: { parent: null, children: ['duplicate'], message: null }, duplicate: { parent: 'root', children: [], message: { id: 'duplicate', author: { role: 'user' }, content: { parts: [{ type: 'text', text: 'preferred' }], content: [{ type: 'text', text: 'preferred' }, { type: 'text', text: 'fallback-only' }] } } } }, current_node: 'duplicate' });
assert.deepEqual(duplicateParts.messages[0].textBlocks.map((block) => block.text), ['preferred']);

const literalEscapes = normalizeConversation({ title: 'Literal escapes', mapping: { root: { parent: null, children: ['literal'], message: null }, literal: { parent: 'root', children: [], message: { id: 'literal', author: { role: 'user' }, content: { parts: ['literal \\n \\t \\u0041 C:\\\\temp\\\\file regex \\d+'] } } } }, current_node: 'literal' });
assert.equal(literalEscapes.messages[0].textBlocks[0].text, 'literal \\n \\t \\u0041 C:\\\\temp\\\\file regex \\d+');

assert.deepEqual(IMAGE_LIMITS, { perImageBytes: 3 * 1024 * 1024, totalBytes: 12 * 1024 * 1024, embeddedImageCount: 64 });
const embeddedResult = { status: 'embedded', byteLength: 8, dataUrl: 'data:image/png;base64,AA==' };
assert.equal(applyImageBudget(embeddedResult, { embeddedCount: 0, imageBytes: IMAGE_LIMITS.totalBytes - 8 }).status, 'embedded');
assert.equal(applyImageBudget({ ...embeddedResult, byteLength: 9 }, { embeddedCount: 0, imageBytes: IMAGE_LIMITS.totalBytes - 8 }).reason, 'export exceeds the 12 MiB total embedded image budget');
assert.equal(applyImageBudget(embeddedResult, { embeddedCount: IMAGE_LIMITS.embeddedImageCount, imageBytes: 0 }).reason, 'export exceeds the 64 embedded-image limit');

const imageConversation = normalizeConversation(await load('image-conversation.json'));
assert.equal(imageConversation.messages[0].textBlocks[0].type, 'image');
assert.equal(imageConversation.messages[0].textBlocks[0].asset.width, 2);
const embeddedImage = imageConversation.messages[0].textBlocks[0];
embeddedImage.asset = { ...embeddedImage.asset, status: 'embedded', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', byteLength: 8 };
const embeddedImageHtml = renderConversationHtml({ ...imageConversation, stats: { ...imageConversation.stats, imageCount: 1, imageEmbeddedCount: 1, imageUnavailableCount: 0 } }, { exportedAt: '2026-08-15T00:00:00.000Z' });
assert.match(embeddedImageHtml, /class="image-block"/);
assert.match(embeddedImageHtml, /src="data:image\/png;base64,iVBORw0KGgo="/);
assert.match(embeddedImageHtml, /Images: 1 embedded, 0 excluded, 0 unavailable/);
assert.match(renderConversationHtml({ ...imageConversation, stats: { ...imageConversation.stats, imageCount: 1, imageEmbeddedCount: 1, imageUnavailableCount: 0, imageBytes: 4097 } }), /5 KB embedded/);
assert.match(embeddedImageHtml, /Generated locally by chatgpt-thread-archiver 0\.9\.0/);
embeddedImage.asset = { ...embeddedImage.asset, status: 'unavailable', reason: 'asset expired' };
const unavailableImageHtml = renderConversationHtml({ ...imageConversation, stats: { ...imageConversation.stats, imageCount: 1, imageEmbeddedCount: 0, imageUnavailableCount: 1 } }, { exportedAt: '2026-08-15T00:00:00.000Z' });
assert.match(unavailableImageHtml, /\[image unavailable: asset expired\]/);
const imageVariants = normalizeConversation({
  title: 'Image variants',
  mapping: {
    root: { parent: null, children: ['user-images'], message: null },
    'user-images': { parent: 'root', children: ['assistant-images'], message: { id: 'user-images', author: { role: 'user' }, content: { parts: [
      { content_type: 'image_asset_pointer', asset_pointer: 'data:image/png;base64,iVBORw0KGgo=' },
      { type: 'image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
    ] } } },
    'assistant-images': { parent: 'user-images', children: [], message: { id: 'assistant-images', author: { role: 'assistant' }, content: { content_type: 'execution_output' }, metadata: { aggregate_result: { messages: [
      { message_type: 'image', image_url: 'data:image/png;base64,iVBORw0KGgo=', width: 640, height: 480 },
    ] } } } },
  },
  current_node: 'assistant-images',
});
assert.equal(imageVariants.messages.flatMap((message) => message.textBlocks).filter((block) => block.type === 'image').length, 3);
assert.equal(imageVariants.messages[1].textBlocks[0].asset.width, 640);
const imageAuthResponse = { status: 200, ok: true, headers: { get: () => 'application/json' }, json: async () => ({ accessToken: 'test-token' }) };
const resolvedDataImages = await resolveConversationImages(imageVariants, {
  conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  fetchImpl: async () => imageAuthResponse,
  authContext: { headers: {} },
});
assert.equal(resolvedDataImages.stats.imageCount, 3);
assert.equal(resolvedDataImages.stats.imageEmbeddedCount, 3);
assert.equal(resolvedDataImages.stats.imageUnavailableCount, 0);
assert.equal(resolvedDataImages.stats.imageBytes, 24);
const excludedImages = await resolveConversationImages(imageVariants, {
  conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  includeImages: false,
  fetchImpl: async () => { throw new Error('excluded images must not be downloaded'); },
});
assert.equal(excludedImages.stats.imageEmbeddedCount, 0);
assert.equal(excludedImages.stats.imageExcludedCount, 3);
assert.equal(excludedImages.stats.imageUnavailableCount, 0);
assert.ok(excludedImages.messages.flatMap((message) => message.textBlocks).filter((block) => block.type === 'image').every((block) => block.asset.status === 'excluded'));
assert.match(renderConversationHtml(excludedImages), /\[image excluded by export settings\]/);
const selectedImages = await resolveConversationImages(imageVariants, {
  conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  selectedImageIndices: new Set([1]),
  authContext: { headers: {} },
  fetchImpl: async () => { throw new Error('unselected data images must not be downloaded'); },
});
assert.equal(selectedImages.stats.imageEmbeddedCount, 1);
assert.equal(selectedImages.stats.imageExcludedCount, 2);
assert.equal(selectedImages.stats.imageUnavailableCount, 0);
const offsetSelectedImages = await resolveConversationImages(imageVariants, {
  conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  selectedImageIndices: new Set([4]),
  imageIndexOffset: 3,
  authContext: { headers: {} },
  fetchImpl: async () => { throw new Error('only the globally selected image may be downloaded'); },
});
assert.equal(offsetSelectedImages.stats.imageEmbeddedCount, 1);
assert.equal(offsetSelectedImages.stats.imageExcludedCount, 2);
const offsetImageBlocks = offsetSelectedImages.messages.flatMap((message) => message.textBlocks).filter((block) => block.type === 'image');
assert.deepEqual(offsetImageBlocks.map((block) => block.asset.status), ['excluded', 'embedded', 'excluded']);
const metadataRequests = [];
const metadataConversation = normalizeConversation({ title: 'Metadata image', mapping: { root: { parent: null, children: ['image'] }, image: { parent: 'root', children: [], message: { id: 'image', author: { role: 'user' }, content: { parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file-abc123' }] } } } }, current_node: 'image' });
const resolvedMetadataImage = await resolveConversationImages(metadataConversation, {
  conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  authContext: { headers: {} },
  fetchImpl: async (url) => {
    metadataRequests.push(url);
    if (url.includes('/backend-api/files/download/file-abc123')) return { status: 200, ok: true, headers: { get: () => 'application/json' }, json: async () => ({ download_url: 'https://chatgpt.com/backend-api/estuary/content?id=abc&ts=1&p=fs&sig=test&v=0' }) };
    if (url.includes('/backend-api/estuary/content')) return { status: 200, ok: true, headers: { get: (name) => name === 'content-type' ? 'image/png' : '8' }, arrayBuffer: async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer };
    return { status: 404, ok: false, headers: { get: () => 'application/json' } };
  },
});
assert.equal(resolvedMetadataImage.stats.imageEmbeddedCount, 1);
assert.equal(resolvedMetadataImage.messages[1].textBlocks[0].asset.status, 'embedded');
assert.match(metadataRequests[0], /files\/download\/file-abc123/);
assert.match(coreSource, /imagePointerFromValue|execution-output/);
assert.match(assetsSource, /files\/download/);
assert.match(assetsSource, /dataImageResult/);
assert.match(assetsSource, /perImageBytes: 3 \* 1024 \* 1024/);
assert.match(assetsSource, /totalBytes: 12 \* 1024 \* 1024/);
assert.match(assetsSource, /embeddedImageCount: 64/);
assert.match(assetsSource, /applyImageBudget/);
assert.match(assetsSource, /\/backend-api\/files\/download/);
assert.match(assetsSource, /\/backend-api\/estuary\/content/);
assert.match(assetsSource, /conversation_id=/);
assert.match(assetsSource, /download_intent=download/);
assert.match(assetsSource, /include_library_file_state=true/);
assert.match(assetsSource, /IMAGE_LIMITS/);
assert.match(assetsSource, /imageIndexOffset/);
assert.match(assetsSource, /data:\$\{mime\};base64/);
assert.match(assetsSource, /includeImages/);
assert.match(assetsSource, /imageExcludedCount/);
const approvedImageUrl = 'https://chatgpt.com/backend-api/estuary/content?id=test&ts=1&p=fs&sig=test&v=0';
assert.equal(candidateDownloadUrl({ nested: { href: approvedImageUrl } }), approvedImageUrl);
assert.equal(candidateDownloadUrl({ download_url: 'https://example.invalid/image.png' }), null);
assert.equal(candidateDownloadUrl({ download_url: 'https://chatgpt.com/backend-api/files/download/file-abc123?inline=false' }), null);

const blocks = textToBlocks('before\n\n```python\nprint("ok")\n```\n\nafter');
assert.equal(blocks.length, 3);
assert.equal(blocks[1].type, 'code');
assert.equal(blocks[1].language, 'python');
assert.match(blocks[1].html, /print/);

const deepParts = { content: { parts: [{ type: 'nested', parts: [] }] } };
let cursor = deepParts.content.parts[0];
for (let index = 0; index < 20; index += 1) {
  cursor.parts = [{ type: 'nested', parts: [] }];
  cursor = cursor.parts[0];
}
const deep = normalizeConversation({ title: 'Deep', mapping: { root: { parent: null, children: ['u'], message: null }, u: { parent: 'root', children: [], message: { id: 'u', author: { role: 'user' }, content: deepParts.content } } }, current_node: 'u' });
assert.ok(deep.stats.omittedBlockCount >= 1);

assert.equal(sanitizeFilename('  unsafe:/name<>  '), 'unsafe name');
assert.equal(sanitizeFilename('report\u202Ecod.exe'), 'report cod.exe');
assert.equal(sanitizeFilename('CON'), '_CON');
assert.equal(sanitizeFilename('nul.txt'), '_nul.txt');
assert.equal(getConversationIdFromUrl('https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
assert.equal(getConversationIdFromUrl('https://chatgpt.com/s/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
assert.equal(getConversationIdFromUrl('https://chatgpt.com/g/project-123/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
assert.equal(getConversationIdFromUrl('https://chatgpt.com/g/project-123'), null);
assert.equal(getConversationIdFromUrl('https://chatgpt.com/'), null);
assert.deepEqual(parseConversationRoute('https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').kind, 'conversation');
assert.deepEqual(parseConversationRoute('https://chatgpt.com/g/project-123/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').routeSegment, 'g');
assert.deepEqual(parseConversationRoute('https://chatgpt.com/g/project-123').kind, 'project');
assert.deepEqual(parseConversationRoute('https://chatgpt.com/g/g-custom-instructions').kind, 'project');
assert.deepEqual(parseConversationRoute('https://chatgpt.com/share/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').kind, 'share');
assert.deepEqual(parseConversationRoute('https://chatgpt.com/images').kind, 'not-conversation');
assert.equal(isExporterRoute('https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), true);
assert.equal(isExporterRoute('https://chatgpt.com/s/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), true);
assert.equal(isExporterRoute('https://chatgpt.com/g/project-123/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), true);
assert.equal(isExporterRoute('https://chatgpt.com/g/project-123'), false);
assert.equal(isExporterRoute('https://chatgpt.com/g/g-custom-instructions'), false);
assert.equal(isExporterRoute('https://chatgpt.com/settings'), false);
assert.equal(isExporterRoute('https://chat.openai.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), false);
const validId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
assert.deepEqual(endpointCandidates(validId), [
  `/backend-api/conversation/${validId}`,
  `/backend-api/conversation/${validId}?history_and_training_disabled=false`,
]);
assert.deepEqual(endpointCandidates('a/b'), []);
assert.ok(endpointCandidates(validId, [
  '/backend-api/conversation/one',
  '/backend-api/conversation/two',
  '/backend-api/conversation/three',
  '/backend-api/conversation/four',
  '/backend-api/conversation/five',
]).length <= 4);

const claude = normalizeClaudeConversation(await load('claude-conversation.json'), 'claude-conversation-id');
assert.equal(claude.provider, 'Claude');
assert.equal(claude.model, 'claude-sonnet-4-20250514');
assert.equal(claude.activeBranch, true);
assert.deepEqual(claude.messages.map((message) => message.id), ['claude-root', 'claude-a1', 'claude-a2']);
assert.equal(claude.messages[0].role, 'user');
assert.equal(claude.messages[1].role, 'assistant');
assert.equal(claude.messages[1].textBlocks[0].text, 'Here is the plan.\n\n```text\nstep one\n```');
assert.match(renderConversationHtml(claude, { exportedAt: '2026-08-22T00:00:00.000Z' }), /Claude text test/);
assert.match(renderConversationHtml(claude, { exportedAt: '2026-08-22T00:00:00.000Z' }), /Model: claude-sonnet-4-20250514/);
assert.match(renderConversationHtml(claude, { exportedAt: '2026-08-22T00:00:00.000Z' }), /3 messages \(2 You, 1 Claude\)/);
assert.equal(claude.branches.length, 2);
assert.deepEqual(claude.branches[0].messages.map((message) => message.id), ['claude-root', 'claude-a1', 'claude-a2']);
assert.deepEqual(claude.branches[1].messages.map((message) => message.id), ['claude-root', 'claude-alt']);
const claudeAllHtml = renderConversationHtml({ ...claude, stats: deriveExportStats(claude.branches.flatMap((branch) => branch.messages), claude.stats, { model: claude.model }) }, { includeAllBranches: true });
assert.match(claudeAllHtml, /This regenerated branch should not be selected/);
assert.match(claudeAllHtml, /All Claude conversation branches exported/);
assert.match(claudeAllHtml, /Branch 1\/2/);
assert.match(renderConversationHtml(claude, { exportedAt: '2026-08-22T00:00:00.000Z' }), /\[non-text content omitted: Claude tool_use content\]/);
assert.match(renderConversationHtml(claude, { exportedAt: '2026-08-22T00:00:00.000Z' }), /\[non-text content omitted: Claude attachment or file content\]/);
assert.doesNotMatch(renderConversationHtml(claude), /private reasoning/);
assert.doesNotMatch(renderConversationHtml(claude), /This regenerated branch should not be selected/);
assert.doesNotMatch(renderConversationHtml(claude), /name="conversation-id"/);
assert.match(renderConversationHtml(claude, { includeConversationId: true }), /name="conversation-id" content="claude-conversation-id"/);
assert.equal(getClaudeConversationIdFromUrl('https://claude.ai/chat/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
assert.equal(getClaudeConversationIdFromUrl('https://claude.ai/new'), null);
assert.equal(parseClaudeConversationRoute('https://claude.ai/chat/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').kind, 'conversation');
assert.equal(isClaudeExporterRoute('https://claude.ai/chat/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), true);
assert.equal(isClaudeExporterRoute('https://claude.ai/projects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), false);
assert.equal(claudeConversationPath('org-123', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), '/api/organizations/org-123/chat_conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa?tree=true&rendering_mode=messages&render_all_tools=true');
assert.equal(claudeConversationPath('', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), null);
assert.equal(claudeConversationPath('org/123', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), null);
const claudeResponse = (status, payload = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => 'application/json' }, json: async () => payload });
const fetchedClaude = await fetchClaudeConversation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { organizationId: 'org-123', fetchImpl: async (url, options) => { assert.match(url, /chat_conversations\/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/); assert.equal(options.credentials, 'same-origin'); return claudeResponse(200, { name: 'Fetched', chat_messages: [{ uuid: 'm', sender: 'human', content: [{ type: 'text', text: 'ok' }] }] }); } });
assert.equal(fetchedClaude.name, 'Fetched');
await assert.rejects(() => fetchClaudeConversation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { fetchImpl: async () => claudeResponse(401, {}) }), ClaudeClientError);

assert.match(claudeSource, /lastActiveOrg/);
assert.match(claudeSource, /render_all_tools=true/);
assert.match(claudeSource, /current_leaf_message_uuid/);
assert.match(claudeSource, /type === 'thinking' \|\| block\.type === 'tool_result'/);
assert.match(claudeSource, /provider: 'Claude'/);

const response = (status, payload = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => 'application/json' }, json: async () => payload });
clearAccessTokenCache();
assert.equal((await getAuthContext(async () => response(401))).authFailure.code, 'signed-out');
clearAccessTokenCache();
assert.equal((await getAuthContext(async () => response(429))).authFailure.code, 'session-rate-limit');
clearAccessTokenCache();
assert.equal((await getAuthContext(async () => response(500))).authFailure.code, 'session-http');
clearAccessTokenCache();
assert.equal((await getAuthContext(async () => ({ status: 200, ok: true, headers: { get: () => 'application/json' }, json: async () => { throw new Error('bad json'); } }))).authFailure.code, 'session-malformed');
clearAccessTokenCache();
assert.equal((await getAuthContext(async () => { throw new Error('offline'); })).authFailure.code, 'session-network');
clearAccessTokenCache();
assert.equal((await getAuthContext(async () => response(200, {}))).authFailure.code, 'missing-token');
clearAccessTokenCache();
assert.equal((await getAuthContext(async () => response(200, { accessToken: 'test-token' }))).hasAccessToken, true);

assert.doesNotMatch(clientSource, /history\.(pushState|replaceState)/);
assert.match(clientSource, /popstate/);
assert.match(clientSource, /parts\[0\] === 'g'/);
assert.match(clientSource, /visibilitychange/);
assert.doesNotMatch(clientSource, /JSON\.stringify\(value\)\.slice\(/);
assert.match(clientSource, /function boundedJsonString/);
assert.match(clientSource, /__NEXT_DATA__.*slice\(0, 262_144\)/);
assert.match(clientSource, /JSON\.stringify\(value, /);
assert.doesNotMatch(clientSource, /cachedAccessToken !== 'dummy'/);
assert.match(clientSource, /token\.toLowerCase\(\) !== 'dummy'/);
assert.match(clientSource, /response\.status === 400 \|\| response\.status === 404/);
const diagnosticId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const diagnostic = describeClientError(new ChatGPTClientError('test', 'diagnostic failure', { route: { pathname: `/c/${diagnosticId}` }, parsedId: '<id:36>' }));
assert.match(diagnostic, /Page path: \/c\/<id:36>/);
assert.doesNotMatch(diagnostic, new RegExp(diagnosticId));
assert.match(coreSource, /#rail \{ max-width: 820px;/);
assert.match(coreSource, /branch-nav/);
assert.match(coreSource, /includeAllBranches/);
assert.match(coreSource, /is_visually_hidden_from_conversation/);
assert.match(coreSource, /droppedNodeCount/);
assert.match(coreSource, /duplicateMessageCount/);
assert.match(coreSource, /timestampIso/);
assert.match(coreSource, /unknown \/ not found/);
assert.match(coreSource, /includeMessageModels/);
assert.match(coreSource, /msg-model/);
assert.match(coreSource, /html\.js #rail \{ position: fixed[\s\S]*max-width: none/);
assert.match(uiSource, /const PREF_KEY = 'chatgpt-thread-archiver-prefs'/);
assert.match(uiSource, /const LEGACY_PREF_KEY = 'chatgpt-chats-exporter-prefs'/);
assert.match(uiSource, /function migratePrefsOnce/);
assert.match(uiSource, /new MutationObserver\(\(\) => install\(\)\)/);
assert.match(uiSource, /bottom: calc\(84px \+ env\(safe-area-inset-bottom/);
assert.match(uiSource, /bottom: calc\(138px \+ env\(safe-area-inset-bottom/);
assert.match(assetsSource, /const chunkSize = 0x2000/);
assert.match(uiSource, /localStorage\.removeItem\(LEGACY_PREF_KEY\)/);
assert.match(uiSource, /deriveExportStats/);
assert.match(uiSource, /Choose images after loading the conversation/);
assert.match(uiSource, /imageMode/);
assert.match(uiSource, /Include edited and regenerated branches/);
assert.match(uiSource, /resolveAllConversationBranches/);
assert.match(uiSource, /imageIndexOffset/);
assert.match(uiSource, /branchMode/);
assert.match(uiSource, /Show a model label on each assistant message/);
assert.match(uiSource, /messageModels/);
assert.match(uiSource, /Show a model label on each assistant message/);
assert.match(statsSource, /wordCount/);
assert.match(statsSource, /characterCount/);
assert.doesNotMatch(statsSource, /authorization|bearer|billing|context-window|token/i);
assert.match(buildSource, /@name         ChatGPT Thread Archiver/);
assert.match(buildSource, /@namespace    local\.chatgpt-thread-archiver/);
assert.match(buildSource, /@version      0\.9\.0/);
assert.ok(buildSource.includes('// @match        https://chatgpt.com/c/*'));
assert.ok(buildSource.includes('// @match        https://chatgpt.com/s/*'));
assert.ok(buildSource.includes('// @match        https://chatgpt.com/g/*'));
assert.ok(buildSource.includes('// @match        https://claude.ai/chat/*'));
assert.ok(!buildSource.includes('// @match        https://chatgpt.com/*'));
assert.match(buildSource, /source\('claude-client\.mjs'\)/);
assert.match(buildSource, /source\('chatgpt-assets\.mjs'\)/);
assert.match(buildSource, /source\('export-stats\.mjs'\)/);
assert.match(buildSource, /\$\{claude\}/);
assert.match(buildSource, /\$\{assets\}/);
assert.match(buildSource, /\$\{stats\}/);
assert.match(statsSource, /Counted from exported text only|wordCount/);

assert.throws(() => normalizeConversation({ title: 'No messages' }), ConversationShapeError);

console.log('All fixture checks passed.');
