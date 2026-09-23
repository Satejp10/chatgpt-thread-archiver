import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import { normalizeConversation, renderConversationHtml, sanitizeFilename, textToBlocks, ConversationShapeError, selectConversationBranch, messagesFromBranchTree, discoverImageModelMetadata, extractTextBlocks } from './src/core.mjs';
import { ChatGPTClientError, clearAccessTokenCache, describeClientError, endpointCandidates, getAuthContext, getConversationIdFromUrl, isExporterRoute, parseConversationRoute } from './src/chatgpt-client.mjs';
import { applyImageBudget, candidateDownloadUrl, IMAGE_LIMITS, resolveClaudeConversationImages, resolveConversationImages, retryDelayMs } from './src/assets.mjs';
import { deriveExportStats } from './src/export-stats.mjs';
import { ClaudeClientError, claudeConversationPath, fetchClaudeConversation, getClaudeConversationIdFromUrl, isClaudeExporterRoute, normalizeClaudeConversation, parseClaudeConversationRoute } from './src/claude-client.mjs';

const load = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const clientSource = await readFile(new URL('./src/chatgpt-client.mjs', import.meta.url), 'utf8');
const coreSource = await readFile(new URL('./src/core.mjs', import.meta.url), 'utf8');
const uiSource = await readFile(new URL('./src/exporter-ui.js', import.meta.url), 'utf8');
const assetsSource = await readFile(new URL('./src/assets.mjs', import.meta.url), 'utf8');
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
assert.match(simpleHtml, /name="generator" content="chatgpt-thread-archiver 0\.16\.0"/);
assert.match(simpleHtml, /Generated locally by chatgpt-thread-archiver 0\.16\.0/);
assert.match(simpleHtml, /color-scheme: light/);
assert.match(simpleHtml, /scroll-margin-top: 16px/);
assert.match(simpleHtml, /\.content \{ overflow-wrap: anywhere; margin-top: 10px; \}/);
assert.doesNotMatch(simpleHtml, /\.content \{[^}]*white-space:\s*pre-wrap/);
const exportedScript = simpleHtml.match(/<script>([\s\S]*)<\/script>/)?.[1];
assert.ok(exportedScript);
assert.doesNotThrow(() => new Script(exportedScript));
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
const allBranchStats = deriveExportStats(messagesFromBranchTree(branching.branchTree), branching.stats, { model: branching.model });
const allBranchesHtml = renderConversationHtml({ ...branching, stats: allBranchStats }, { includeAllBranches: true });
assert.doesNotMatch(allBranchesHtml, /id="branch-nav"/);
assert.match(allBranchesHtml, /3 messages \(1 You, 2 ChatGPT\)/);
assert.match(allBranchesHtml, /First answer/);
assert.match(allBranchesHtml, /Second answer/);
assert.match(allBranchesHtml, /All ChatGPT conversation branches exported with local fork controls/);
assert.equal((allBranchesHtml.match(/class="branch-fork"/g) ?? []).length, 1);
assert.equal((allBranchesHtml.match(/class="branch-option"/g) ?? []).length, 2);
assert.match(allBranchesHtml, /data-branch-position>1\/2/);
assert.match(allBranchesHtml, /data-branch-prev/);
assert.match(allBranchesHtml, /data-branch-next/);

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

// The export applies no image budget by default: the chooser is the control.
assert.deepEqual(IMAGE_LIMITS, { perImageBytes: Infinity, totalBytes: Infinity, embeddedImageCount: Infinity });
const embeddedResult = { status: 'embedded', byteLength: 8, dataUrl: 'data:image/png;base64,AA==' };
assert.equal(applyImageBudget(embeddedResult, { embeddedCount: 4096, imageBytes: 5 * 1024 * 1024 * 1024 }).status, 'embedded');
// A caller may still opt into a finite budget, and the messages follow it.
const cappedLimits = { perImageBytes: 3 * 1024 * 1024, totalBytes: 12 * 1024 * 1024, embeddedImageCount: 64 };
assert.equal(applyImageBudget(embeddedResult, { embeddedCount: 0, imageBytes: cappedLimits.totalBytes - 8 }, cappedLimits).status, 'embedded');
assert.equal(applyImageBudget({ ...embeddedResult, byteLength: 9 }, { embeddedCount: 0, imageBytes: cappedLimits.totalBytes - 8 }, cappedLimits).reason, 'export exceeds the 12 MiB total embedded image budget');
assert.equal(applyImageBudget(embeddedResult, { embeddedCount: cappedLimits.embeddedImageCount, imageBytes: 0 }, cappedLimits).reason, 'export exceeds the 64 embedded-image limit');

// Retry-After parsing stays inside sane bounds, whatever the provider sends.
assert.equal(retryDelayMs(null), 5000);
assert.equal(retryDelayMs('not-a-number'), 5000);
assert.equal(retryDelayMs('2'), 2000);
assert.equal(retryDelayMs('0.1'), 1000);
assert.equal(retryDelayMs('9999'), 15000);

const imageConversation = normalizeConversation(await load('image-conversation.json'));
// The fixture's parts are image-then-text, the shape ChatGPT sends for an upload.
// A user's own words are shown first and their attachments after.
assert.deepEqual(imageConversation.messages[0].textBlocks.map((block) => block.type), ['text', 'image']);
assert.equal(imageConversation.messages[0].textBlocks[0].text, 'Reference image');
assert.equal(imageConversation.messages[0].textBlocks[1].asset.width, 2);
const embeddedImage = imageConversation.messages[0].textBlocks[1];
// An assistant message keeps provider order: there the text introduces the image below it.
const assistantImageMessage = { author: { role: 'assistant' }, content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-assistant', width: 2, height: 2 }, 'Here it is.'] } };
assert.deepEqual(extractTextBlocks(assistantImageMessage).blocks.map((block) => block.type), ['image', 'text']);
// A user message with no text keeps its single image; reordering must not drop it.
const imageOnlyMessage = { author: { role: 'user' }, content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-only', width: 2, height: 2 }] } };
assert.deepEqual(extractTextBlocks(imageOnlyMessage).blocks.map((block) => block.type), ['image']);
embeddedImage.asset = { ...embeddedImage.asset, status: 'embedded', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', byteLength: 8 };
const embeddedImageHtml = renderConversationHtml({ ...imageConversation, stats: { ...imageConversation.stats, imageCount: 1, imageEmbeddedCount: 1, imageUnavailableCount: 0 } }, { exportedAt: '2026-08-15T00:00:00.000Z' });
assert.match(embeddedImageHtml, /class="image-block"/);
assert.match(embeddedImageHtml, /src="data:image\/png;base64,iVBORw0KGgo="/);
assert.match(embeddedImageHtml, /Images: 1 embedded, 0 excluded, 0 unavailable/);
assert.match(renderConversationHtml({ ...imageConversation, stats: { ...imageConversation.stats, imageCount: 1, imageEmbeddedCount: 1, imageUnavailableCount: 0, imageBytes: 4097 } }), /5 KB embedded/);
assert.match(embeddedImageHtml, /Generated locally by chatgpt-thread-archiver 0\.16\.0/);
embeddedImage.asset = { ...embeddedImage.asset, status: 'unavailable', reason: 'asset expired' };
const unavailableImageHtml = renderConversationHtml({ ...imageConversation, stats: { ...imageConversation.stats, imageCount: 1, imageEmbeddedCount: 0, imageUnavailableCount: 1 } }, { exportedAt: '2026-08-15T00:00:00.000Z' });
assert.match(unavailableImageHtml, /\[image unavailable: asset expired\]/);
assert.deepEqual(discoverImageModelMetadata({ metadata: { generation: { model: 'gpt-image-2.5-sunburst' } } }), { found: true, model: 'gpt-image-2.5-sunburst' });
assert.deepEqual(discoverImageModelMetadata({ metadata: { dalle: true } }), { found: false, model: 'unknown / not found' });
assert.deepEqual(discoverImageModelMetadata({ image_model: 'javascript:alert(1)' }), { found: false, model: 'unknown / not found' });
const imageModelConversation = normalizeConversation({
  title: 'Image model',
  mapping: {
    root: { parent: null, children: ['image-model'] },
    'image-model': {
      parent: 'root',
      children: [],
      message: {
        id: 'image-model',
        author: { role: 'assistant' },
        content: { parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file-model', metadata: { generation: { model: 'gpt-image-2.5-sunburst' } } }] },
      },
    },
  },
  current_node: 'image-model',
});
assert.equal(imageModelConversation.messages[1].textBlocks[0].asset.imageModel, 'gpt-image-2.5-sunburst');
const embeddedModelMessages = imageModelConversation.messages.map((message) => ({ ...message, textBlocks: message.textBlocks.map((block) => block.type === 'image' ? { ...block, asset: { ...block.asset, status: 'embedded', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' } } : block) }));
assert.match(renderConversationHtml({ ...imageModelConversation, messages: embeddedModelMessages }), /Image model: gpt-image-2\.5-sunburst/);
assert.doesNotMatch(renderConversationHtml({ ...imageModelConversation, messages: embeddedModelMessages }, { includeMessageModels: false }), /Image model:/);
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

// A single generated image now well over the old 3 MiB per-image cap embeds.
const bigPng = new Uint8Array(4 * 1024 * 1024);
const bigImageConversation = normalizeConversation({
  title: 'Large image',
  mapping: {
    root: { parent: null, children: ['big'] },
    big: { parent: 'root', children: [], message: { id: 'big', author: { role: 'assistant' }, content: { parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file-bigimage', metadata: { generation: {} } }] } } },
  },
  current_node: 'big',
});
const okImageResponse = () => ({ status: 200, ok: true, headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'image/png' : null) }, arrayBuffer: async () => bigPng.buffer });
const bigResolved = await resolveConversationImages(bigImageConversation, {
  conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  authContext: { headers: {} },
  fetchImpl: async () => okImageResponse(),
});
assert.equal(bigResolved.stats.imageEmbeddedCount, 1);
assert.equal(bigResolved.stats.imageBudgetLimitedCount, 0);
assert.equal(bigResolved.stats.imageBytes, bigPng.length);

// A 429 mid-export is retried once rather than dropping the image.
let throttledCalls = 0;
const sleptFor = [];
const throttledResolved = await resolveConversationImages(bigImageConversation, {
  conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  authContext: { headers: {} },
  sleep: async (ms) => { sleptFor.push(ms); },
  fetchImpl: async () => {
    throttledCalls += 1;
    if (throttledCalls === 1) return { status: 429, ok: false, headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? '2' : 'image/png') } };
    return okImageResponse();
  },
});
assert.equal(throttledResolved.stats.imageEmbeddedCount, 1);
assert.deepEqual(sleptFor, [2000]);

// A second 429 is a real failure, not an endless retry loop.
const alwaysThrottled = await resolveConversationImages(bigImageConversation, {
  conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  authContext: { headers: {} },
  sleep: async () => {},
  fetchImpl: async () => ({ status: 429, ok: false, headers: { get: () => null } }),
});
assert.equal(alwaysThrottled.stats.imageEmbeddedCount, 0);
assert.equal(alwaysThrottled.stats.imageUnavailableCount, 1);
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
assert.match(assetsSource, /perImageBytes: Infinity/);
assert.match(assetsSource, /totalBytes: Infinity/);
assert.match(assetsSource, /embeddedImageCount: Infinity/);
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
assert.match(coreSource, /IMAGE_MODEL_KEYS/);
assert.match(coreSource, /unknown \/ not found/);
assert.match(uiSource, /imageModel/);
// The image chooser carries a select-all toggle and a running size readout.
assert.match(uiSource, /cge-image-select-all/);
assert.match(uiSource, /Select all/);
assert.match(uiSource, /indeterminate/);
assert.match(uiSource, /cge-selection-summary/);
assert.match(uiSource, /aria-live/);
assert.match(uiSource, /of \$\{inputs\.length\} selected/);
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

// ChatGPT temporary chats keep the id out of the address bar; the page's own requests
// to the conversation API carry it.
{
  const tempUrl = 'https://chatgpt.com/?temporary-chat=true';
  const tempId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const older = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const entries = [
    { name: `https://chatgpt.com/backend-api/conversation/${older}`, startTime: 5 },
    { name: `https://chatgpt.com/backend-api/conversation/${tempId}/stream_status`, startTime: 20 },
    { name: 'https://chatgpt.com/backend-api/f/conversation', startTime: 25 },
    { name: `https://evil.example/backend-api/conversation/${older}`, startTime: 30 },
  ];
  const route = parseConversationRoute(tempUrl, { resourceEntries: entries });
  assert.equal(route.kind, 'conversation');
  assert.equal(route.conversationId, tempId, 'the latest same-origin conversation request wins');
  assert.equal(route.temporary, true);
  assert.equal(parseConversationRoute(tempUrl, { resourceEntries: [] }).kind, 'temporary-pending');
  assert.equal(parseConversationRoute('https://chatgpt.com/?temporary-chat=false', { resourceEntries: entries }).kind, 'not-conversation');
  assert.equal(parseConversationRoute('https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa?temporary-chat=true').conversationId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
}
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
// Thinking and tool blocks are now captured rather than dropped, so they sit in the
// block list ahead of the text they preceded in the payload.
assert.deepEqual(claude.messages[1].textBlocks.map((block) => block.type), ['thinking', 'text', 'tool_use']);
assert.equal(claude.messages[1].textBlocks[1].text, 'Here is the plan.\n\n```text\nstep one\n```');
assert.match(renderConversationHtml(claude, { exportedAt: '2026-08-22T00:00:00.000Z' }), /Claude text test/);
assert.match(renderConversationHtml(claude, { exportedAt: '2026-08-22T00:00:00.000Z' }), /Model: claude-sonnet-4-20250514/);
assert.match(renderConversationHtml(claude, { exportedAt: '2026-08-22T00:00:00.000Z' }), /3 messages \(2 You, 1 Claude\)/);
assert.equal(claude.branches.length, 2);
assert.deepEqual(claude.branches[0].messages.map((message) => message.id), ['claude-root', 'claude-a1', 'claude-a2']);
assert.deepEqual(claude.branches[1].messages.map((message) => message.id), ['claude-root', 'claude-alt']);
const claudeAllHtml = renderConversationHtml({ ...claude, stats: deriveExportStats(messagesFromBranchTree(claude.branchTree), claude.stats, { model: claude.model }) }, { includeAllBranches: true });
assert.match(claudeAllHtml, /This regenerated branch should not be selected/);
assert.match(claudeAllHtml, /All Claude conversation branches exported with local fork controls/);
assert.match(claudeAllHtml, /4 messages \(2 You, 2 Claude\)/);
assert.match(claudeAllHtml, /class="branch-fork"/);
assert.match(claudeAllHtml, /data-branch-position>1\/2/);
// Captured but excluded by default: nothing is rendered, and the header says how many.
assert.doesNotMatch(renderConversationHtml(claude, { exportedAt: '2026-08-22T00:00:00.000Z' }), /<details class="thinking-block"|<div class="tool-block"/);
assert.match(renderConversationHtml(claude, { exportedAt: '2026-08-22T00:00:00.000Z' }), /Not exported: 2 thinking and tool blocks/);
const claudeThinkingHtml = renderConversationHtml(claude, { exportedAt: '2026-08-22T00:00:00.000Z', includeThinking: true });
assert.match(claudeThinkingHtml, /<details class="thinking-block"><summary>Thought/);
assert.match(claudeThinkingHtml, /<div class="tool-block">/);
assert.doesNotMatch(claudeThinkingHtml, /Not exported: \d+ thinking/);
assert.match(renderConversationHtml(claude, { exportedAt: '2026-08-22T00:00:00.000Z' }), /\[non-text content omitted: Claude attachment or file content\]/);
assert.doesNotMatch(renderConversationHtml(claude), /private reasoning/);
assert.doesNotMatch(renderConversationHtml(claude), /This regenerated branch should not be selected/);
// Claude uploaded images (payload shape confirmed live on 2026-09-18).
const claudeImages = normalizeClaudeConversation(await load('claude-image-conversation.json'), 'claude-image-id');
const claudeImageBlocks = claudeImages.messages[0].textBlocks;
assert.deepEqual(claudeImageBlocks.map((block) => block.type), ['text', 'image', 'omitted']);
assert.equal(claudeImageBlocks[0].text, 'What is in this screenshot?');
assert.equal(claudeImageBlocks[1].asset.width, 1162);
assert.equal(claudeImageBlocks[1].asset.height, 616);
assert.equal(claudeImageBlocks[1].asset.sizeBytes, 61202);
// Claude has no image generation, so no export may ever label one of these generated.
assert.equal(claudeImageBlocks[1].asset.generated, false);
assert.equal(claudeImageBlocks[1].asset.imageModel, null);
// A non-image attachment still has no fetchable representation and stays a marker.
assert.equal(claudeImageBlocks[2].reason, 'Claude attachment or file content');
assert.equal(claudeImages.messages[0].omittedCount, 1);
// The pointer is never reported to the reader; only the embedded bytes are.
assert.doesNotMatch(renderConversationHtml(claudeImages), /files\/[0-9a-f-]{36}\/preview/);

const claudePng = 'iVBORw0KGgo=';
const claudeImageFetch = async (url) => {
  assert.match(String(url), /^https:\/\/claude\.ai\/api\/[0-9a-f-]+\/files\/[0-9a-f-]+\/preview$/);
  return { status: 200, ok: true, headers: { get: (name) => (name === 'content-type' ? 'image/webp' : null) }, arrayBuffer: async () => Uint8Array.from(atob(claudePng), (c) => c.charCodeAt(0)).buffer };
};
const claudeResolved = await resolveClaudeConversationImages(claudeImages, { fetchImpl: claudeImageFetch, conversationId: 'claude-image-id' });
assert.equal(claudeResolved.stats.imageCount, 1);
assert.equal(claudeResolved.stats.imageEmbeddedCount, 1);
assert.equal(claudeResolved.messages[0].textBlocks[1].asset.status, 'embedded');
assert.match(claudeResolved.messages[0].textBlocks[1].asset.dataUrl, /^data:image\/webp;base64,/);
assert.match(renderConversationHtml(claudeResolved), /<figure class="image-block">/);
assert.match(renderConversationHtml(claudeResolved), /Uploaded\/reference image/);
// No image-model caption may appear for a provider that cannot generate images.
assert.doesNotMatch(renderConversationHtml(claudeResolved, { includeMessageModels: true }), /Image model:/);

// A URL outside the confirmed same-origin file route is refused rather than fetched.
const offRouteConversation = { ...claudeImages, messages: [{ ...claudeImages.messages[0], textBlocks: [{ type: 'image', asset: { pointer: 'https://evil.example/api/x/files/y/preview' } }] }] };
const offRouteResolved = await resolveClaudeConversationImages(offRouteConversation, { fetchImpl: async () => { throw new Error('must not fetch an unapproved host'); } });
assert.equal(offRouteResolved.messages[0].textBlocks[0].asset.status, 'unavailable');
assert.match(offRouteResolved.messages[0].textBlocks[0].asset.reason, /approved same-origin Claude file route/);
// The Claude path must not mint or read a bearer token.
const noAuthResolved = await resolveClaudeConversationImages(claudeImages, { fetchImpl: claudeImageFetch, authContext: null });
assert.equal(noAuthResolved.stats.imageEmbeddedCount, 1);
assert.match(assetsSource, /requiresAuth = true/);
assert.match(uiSource, /resolveClaudeConversationImages/);

// Claude thinking and tool blocks (payload shape confirmed live on 2026-09-18).
const claudeReasoning = normalizeClaudeConversation(await load('claude-reasoning-conversation.json'), 'claude-reasoning-id');
const reasoningBlocks = claudeReasoning.messages[1].textBlocks;
assert.deepEqual(reasoningBlocks.map((block) => block.type), ['thinking', 'tool_use', 'tool_result', 'text']);
// Live payloads send thinking_hidden with an empty thinking string: the summaries are all
// there is, and the export must not claim it dropped something Claude never sent.
assert.equal(reasoningBlocks[0].text, '');
assert.equal(reasoningBlocks[0].withheldByProvider, true);
assert.equal(reasoningBlocks[0].summaries.length, 2);
assert.equal(reasoningBlocks[0].durationMs, 56000);
assert.equal(reasoningBlocks[1].toolName, 'consensus_search');
assert.equal(reasoningBlocks[1].integration, 'Consensus');
assert.deepEqual(reasoningBlocks[1].input, { query: 'effects of sleep on memory consolidation' });
assert.equal(reasoningBlocks[2].text, 'Study one: consolidation improves with slow-wave sleep.\n\nStudy two: effect size is moderate.');
assert.equal(reasoningBlocks[2].isError, false);
// Capturing these blocks must not inflate the omitted-block warning.
assert.equal(claudeReasoning.messages[1].omittedCount, 0);

const reasoningOff = renderConversationHtml(claudeReasoning, { exportedAt: '2026-09-18T19:00:00.000Z' });
assert.doesNotMatch(reasoningOff, /<details class="thinking-block"|<div class="tool-block"/);
assert.doesNotMatch(reasoningOff, /effects of sleep on memory consolidation/);
assert.doesNotMatch(reasoningOff, /slow-wave sleep/);
assert.match(reasoningOff, /Not exported: 3 thinking and tool blocks/);

const reasoningOn = renderConversationHtml(claudeReasoning, { exportedAt: '2026-09-18T19:00:00.000Z', includeThinking: true });
assert.match(reasoningOn, /<summary>Thought for 56s<\/summary>/);
assert.match(reasoningOn, /Drafting a concise answer with a practical tip\./);
assert.match(reasoningOn, /Full reasoning text is not provided by Claude/);
assert.match(reasoningOn, /Consensus · consensus_search · Search/);
assert.match(reasoningOn, /effects of sleep on memory consolidation/);
assert.match(reasoningOn, /<summary>Tool result · Consensus · consensus_search for 5s<\/summary>/);
assert.match(reasoningOn, /slow-wave sleep/);
// display_content duplicates the content array; carrying both would double the file.
assert.doesNotMatch(reasoningOn, /not read by the exporter/);
// A tool id is provider plumbing, not conversation content, and is never rendered.
assert.doesNotMatch(reasoningOn, /toolu_01ABCDEF/);

const reasoningAll = renderConversationHtml(
  { ...claudeReasoning, stats: deriveExportStats(messagesFromBranchTree(claudeReasoning.branchTree), claudeReasoning.stats, { model: claudeReasoning.model }) },
  { includeAllBranches: true, includeThinking: true },
);
// A payload that does carry reasoning text renders it instead of the summary list.
assert.match(reasoningAll, /A payload that does carry the reasoning text should render it\./);
assert.match(reasoningAll, /Claude stopped this reasoning early\./);
assert.match(reasoningAll, /tool-block tool-error/);
assert.match(reasoningAll, /Tool error · failing_tool/);

const nestedBranches = normalizeConversation(await load('nested-branches.json'));
assert.equal(nestedBranches.branches.length, 4);
assert.equal(messagesFromBranchTree(nestedBranches.branchTree).length, 7);
assert.equal(nestedBranches.branchTree[0].children.length, 2);
const editedPromptNode = nestedBranches.branchTree[0].children.find((node) => node.message.id === 'u2');
const originalAnswerNode = nestedBranches.branchTree[0].children.find((node) => node.message.id === 'a1');
assert.equal(editedPromptNode.children.length, 2);
assert.equal(originalAnswerNode.children.length, 2);
const nestedHtml = renderConversationHtml({ ...nestedBranches, stats: deriveExportStats(messagesFromBranchTree(nestedBranches.branchTree), nestedBranches.stats, { model: nestedBranches.model }) }, { includeAllBranches: true });
assert.equal((nestedHtml.match(/class="branch-fork"/g) ?? []).length, 3);
assert.equal((nestedHtml.match(/class="branch-choice"/g) ?? []).length, 3);
assert.equal((nestedHtml.match(/data-branch-position>1\/2/g) ?? []).length, 3);
assert.match(nestedHtml, /Edited regenerated answer two/);
assert.match(nestedHtml, /Regenerated original answer one/);
assert.match(nestedHtml, /All ChatGPT conversation branches exported with local fork controls/);
assert.doesNotMatch(renderConversationHtml(claude), /name="conversation-id"/);
assert.match(renderConversationHtml(claude, { includeConversationId: true }), /name="conversation-id" content="claude-conversation-id"/);
assert.equal(getClaudeConversationIdFromUrl('https://claude.ai/chat/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
assert.equal(getClaudeConversationIdFromUrl('https://claude.ai/new'), null);
assert.equal(parseClaudeConversationRoute('https://claude.ai/chat/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').kind, 'conversation');
assert.equal(isClaudeExporterRoute('https://claude.ai/chat/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), true);
assert.equal(isClaudeExporterRoute('https://claude.ai/projects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), false);

// Claude incognito chats: only the send-message request names the chat for certain.
{
  const incognitoUrl = 'https://claude.ai/new?incognito=';
  const incognitoId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const other = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const org = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const entries = [
    { name: `https://claude.ai/api/organizations/${org}/chat_conversations/${incognitoId}/completion`, startTime: 10 },
    { name: `https://claude.ai/api/organizations/${org}/chat_conversations/${other}?tree=True`, startTime: 40 },
  ];
  const route = parseClaudeConversationRoute(incognitoUrl, { resourceEntries: entries });
  assert.equal(route.kind, 'conversation');
  assert.equal(route.conversationId, incognitoId, 'a plain fetch of another conversation is ignored');
  assert.equal(route.incognito, true);
  assert.equal(parseClaudeConversationRoute('https://claude.ai/new?incognito', { resourceEntries: entries }).conversationId, incognitoId);
  assert.equal(parseClaudeConversationRoute(incognitoUrl, { resourceEntries: entries.slice(1) }).kind, 'incognito-pending');
  assert.equal(parseClaudeConversationRoute('https://claude.ai/new', { resourceEntries: entries }).kind, 'not-conversation');
}
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
// Thinking and tool blocks must be normalized, never silently skipped as they once were.
assert.match(claudeSource, /claudeThinkingBlock\(block\)/);
assert.match(claudeSource, /claudeToolUseBlock\(block\)/);
assert.match(claudeSource, /claudeToolResultBlock\(block\)/);
assert.doesNotMatch(claudeSource, /block\.type === 'thinking' \|\| block\.type === 'tool_result'/);
assert.match(claudeSource, /provider: 'Claude'/);

// A Claude chat whose server-side current-branch pointer lags the screen: the leaf
// points at stale-reply-2 while the regenerated stale-reply-3 is what the user sees.
// Exporting every branch is what keeps the regenerated reply in the file.
const staleLeaf = normalizeClaudeConversation(await load('claude-stale-leaf.json'), 'claude-stale-leaf-id');
assert.equal(staleLeaf.activeBranch, true);
assert.equal(staleLeaf.branches.length, 3);
assert.deepEqual(staleLeaf.branches[0].messages.map((message) => message.id), ['stale-prompt-2', 'stale-reply-2']);
assert.equal(staleLeaf.stats.droppedNodeCount, 0);
assert.equal(staleLeaf.stats.alternateBranchMessageCount, 3);
const staleAllHtml = renderConversationHtml({ ...staleLeaf, stats: deriveExportStats(messagesFromBranchTree(staleLeaf.branchTree), staleLeaf.stats, { model: staleLeaf.model }) }, { includeAllBranches: true });
assert.match(staleAllHtml, /Reply to the original prompt/);
assert.match(staleAllHtml, /Reply the server still points at/);
assert.match(staleAllHtml, /Regenerated reply the screen actually shows/);
// Two switchers: the edited prompt forks the conversation at the root, the regenerated
// reply forks below it. Root-level alternatives must not stack as separate messages.
assert.equal((staleAllHtml.match(/class="branch-fork"/g) ?? []).length, 2);
assert.equal((staleAllHtml.match(/class="branch-choice"/g) ?? []).length, 2);
assert.equal((staleAllHtml.match(/data-branch-position>1\/2/g) ?? []).length, 2);
assert.match(staleAllHtml, /^\s*<div class="branch-fork" data-fork-id="fork-001">/m);
// The switcher is above the alternatives it governs, not below them.
assert.match(staleAllHtml, /<div class="branch-fork" data-fork-id="fork-001"><div class="branch-choice"/);
assert.doesNotMatch(staleAllHtml, /<\/div><div class="branch-choice" data-fork-id="fork-001"/);
assert.doesNotMatch(staleAllHtml, /Not exported:/);
assert.doesNotMatch(staleAllHtml, /dropped node/);
const staleActiveHtml = renderConversationHtml(staleLeaf, { exportedAt: '2026-09-18T12:58:28.687Z' });
assert.match(staleActiveHtml, /Not exported: 3 messages on 2 other branches/);
assert.match(staleActiveHtml, /Include edited and regenerated branches/);
assert.doesNotMatch(staleActiveHtml, /dropped node/);
assert.doesNotMatch(staleActiveHtml, /flag-warn">Coverage/);
assert.match(staleActiveHtml, /2 alternate branches available \(edited prompts or regenerated replies\)/);

// Every version is captured unless the owner deliberately narrows the export.
assert.match(uiSource, /const PREFS_VERSION = 1;/);
assert.match(uiSource, /branchMode: 'all', thinking: false, prefsVersion: PREFS_VERSION/);
// Reasoning must be opt-in: only a literal true in stored preferences turns it on, so an
// older saved preference cannot opt someone in to sharing it.
assert.match(uiSource, /const thinking = value\.thinking === true;/);
assert.match(uiSource, /includeThinking: prefs\.thinking === true/);
assert.match(uiSource, /Include Claude thinking and tool calls/);
assert.match(uiSource, /if \(prefs\.prefsVersion < PREFS_VERSION\) \{/);
assert.match(uiSource, /\['all', 'Include edited and regenerated branches'\], \['active', 'Export current branch only'\]/);

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
assert.match(buildSource, /@version      0\.16\.0/);
assert.ok(buildSource.includes('// @match        https://chatgpt.com/c/*'));
assert.ok(buildSource.includes('// @match        https://chatgpt.com/s/*'));
assert.ok(buildSource.includes('// @match        https://chatgpt.com/g/*'));
assert.ok(buildSource.includes('// @match        https://claude.ai/chat/*'));
assert.ok(!buildSource.includes('// @match        https://chatgpt.com/*'));
assert.ok(buildSource.includes('// @match        https://chatgpt.com/?temporary-chat=*'));
assert.ok(buildSource.includes('// @match        https://claude.ai/new?incognito*'));
assert.ok(!buildSource.includes('// @match        https://claude.ai/*\n'));
assert.ok(uiSource.includes('installTemporaryChatObserver()') && uiSource.includes('installClaudeIncognitoObserver()'));
assert.match(buildSource, /source\('claude-client\.mjs'\)/);
assert.match(buildSource, /source\('assets\.mjs'\)/);
assert.match(buildSource, /source\('export-stats\.mjs'\)/);
assert.match(buildSource, /\$\{claude\}/);
assert.match(buildSource, /\$\{assets\}/);
assert.match(buildSource, /\$\{stats\}/);
assert.match(statsSource, /Counted from exported text only|wordCount/);

assert.throws(() => normalizeConversation({ title: 'No messages' }), ConversationShapeError);

console.log('All fixture checks passed.');
