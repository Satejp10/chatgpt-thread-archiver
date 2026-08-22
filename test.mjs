import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeConversation, renderConversationHtml, sanitizeFilename, textToBlocks, ConversationShapeError } from './src/core.mjs';
import { ChatGPTClientError, clearAccessTokenCache, describeClientError, endpointCandidates, getAuthContext, getConversationIdFromUrl, parseConversationRoute } from './src/chatgpt-client.mjs';
import { candidateDownloadUrl } from './src/chatgpt-assets.mjs';

const load = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const clientSource = await readFile(new URL('./src/chatgpt-client.mjs', import.meta.url), 'utf8');
const coreSource = await readFile(new URL('./src/core.mjs', import.meta.url), 'utf8');
const uiSource = await readFile(new URL('./src/exporter-ui.js', import.meta.url), 'utf8');
const assetsSource = await readFile(new URL('./src/chatgpt-assets.mjs', import.meta.url), 'utf8');
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
assert.match(simpleHtml, /class="copy-btn"/);
assert.match(simpleHtml, /querySelector\("\.content"\)/);
assert.match(simpleHtml, /2 messages \(1 You, 1 ChatGPT\)/);
assert.match(simpleHtml, /Content-Security-Policy/);
assert.match(simpleHtml, /name="generator" content="chatgpt-thread-archiver 0\.5\.0"/);
assert.match(simpleHtml, /Generated locally by chatgpt-thread-archiver 0\.5\.0/);
assert.match(simpleHtml, /color-scheme: light/);
assert.match(simpleHtml, /scroll-margin-top: 16px/);
assert.match(simpleHtml, /\.content \{ overflow-wrap: anywhere; margin-top: 10px; \}/);
assert.doesNotMatch(simpleHtml, /\.content \{[^}]*white-space:\s*pre-wrap/);
assert.match(simpleHtml, /\.content pre \{ white-space: pre;/);
assert.doesNotMatch(simpleHtml, /name="conversation-id"/);
assert.doesNotMatch(simpleHtml, /Source:/);
assert.match(simpleHtml, /<script>\(function \(\)/);
assert.doesNotMatch(simpleHtml.match(/<script>[\s\S]*?<\/script>/)?.[0] ?? '', /A small test chat|world|formatting/);
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

const pastedJson = normalizeConversation({ title: 'Pasted JSON', mapping: { root: { parent: null, children: ['pasted'] }, pasted: { parent: 'root', children: [], message: { id: 'pasted', author: { role: 'user' }, content: { parts: ['{\\"message\\":\\"hi\\\\nthere\\",\\"id\\":42,\\"secret\\":\\"keep-me\\"}'] } } } }, current_node: 'pasted' });
const pastedJsonHtml = renderConversationHtml(pastedJson);
assert.match(pastedJsonHtml, /hi<br>there/);
assert.match(pastedJsonHtml, /&quot;id&quot;: 42/);
assert.match(pastedJsonHtml, /&quot;secret&quot;: &quot;keep-me&quot;/);

const attachmentConversation = normalizeConversation({ title: 'Attachment', mapping: { root: { parent: null, children: ['attachment'] }, attachment: { parent: 'root', children: [], message: { id: 'attachment', author: { role: 'user' }, metadata: { attachments: [{ id: 'file-attachment', name: 'report.pdf' }] }, content: { parts: ['Attached report'] } } } }, current_node: 'attachment' });
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

const imageConversation = normalizeConversation(await load('image-conversation.json'));
assert.equal(imageConversation.messages[0].textBlocks[0].type, 'image');
assert.equal(imageConversation.messages[0].textBlocks[0].asset.width, 2);
const embeddedImage = imageConversation.messages[0].textBlocks[0];
embeddedImage.asset = { ...embeddedImage.asset, status: 'embedded', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', byteLength: 8 };
const embeddedImageHtml = renderConversationHtml({ ...imageConversation, stats: { ...imageConversation.stats, imageCount: 1, imageEmbeddedCount: 1, imageUnavailableCount: 0 } }, { exportedAt: '2026-08-15T00:00:00.000Z' });
assert.match(embeddedImageHtml, /class="image-block"/);
assert.match(embeddedImageHtml, /src="data:image\/png;base64,iVBORw0KGgo="/);
assert.match(embeddedImageHtml, /Images: 1 embedded, 0 unavailable/);
assert.match(renderConversationHtml({ ...imageConversation, stats: { ...imageConversation.stats, imageCount: 1, imageEmbeddedCount: 1, imageUnavailableCount: 0, imageBytes: 4097 } }), /5 KB embedded/);
assert.match(embeddedImageHtml, /Generated locally by chatgpt-thread-archiver 0\.5\.0/);
embeddedImage.asset = { ...embeddedImage.asset, status: 'unavailable', reason: 'asset expired' };
const unavailableImageHtml = renderConversationHtml({ ...imageConversation, stats: { ...imageConversation.stats, imageCount: 1, imageEmbeddedCount: 0, imageUnavailableCount: 1 } }, { exportedAt: '2026-08-15T00:00:00.000Z' });
assert.match(unavailableImageHtml, /\[image unavailable: asset expired\]/);
assert.match(assetsSource, /MAX_IMAGE_BYTES = 3 \* 1024 \* 1024/);
assert.match(assetsSource, /\/backend-api\/files\/download/);
assert.match(assetsSource, /\/backend-api\/estuary\/content/);
assert.match(assetsSource, /conversation_id=/);
assert.match(assetsSource, /download_intent=download/);
assert.match(assetsSource, /include_library_file_state=true/);
assert.match(assetsSource, /post_id=/);
assert.match(assetsSource, /data:\$\{mime\};base64/);
const approvedImageUrl = 'https://chatgpt.com/backend-api/estuary/content?id=test&ts=1&p=fs&sig=test&v=0';
assert.equal(candidateDownloadUrl({ nested: { href: approvedImageUrl } }), approvedImageUrl);
assert.equal(candidateDownloadUrl({ download_url: 'https://example.invalid/image.png' }), null);

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
assert.equal(getConversationIdFromUrl('https://chatgpt.com/'), null);
assert.deepEqual(parseConversationRoute('https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').kind, 'conversation');
assert.deepEqual(parseConversationRoute('https://chatgpt.com/share/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').kind, 'share');
assert.deepEqual(parseConversationRoute('https://chatgpt.com/images').kind, 'not-conversation');
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
assert.match(coreSource, /is_visually_hidden_from_conversation/);
assert.match(coreSource, /droppedNodeCount/);
assert.match(coreSource, /duplicateMessageCount/);
assert.match(coreSource, /timestampIso/);
assert.match(coreSource, /html\.js #rail \{ position: fixed[\s\S]*max-width: none/);
assert.match(uiSource, /const PREF_KEY = 'chatgpt-thread-archiver-prefs'/);
assert.match(uiSource, /const LEGACY_PREF_KEY = 'chatgpt-chats-exporter-prefs'/);
assert.match(uiSource, /function migratePrefsOnce/);
assert.match(uiSource, /new MutationObserver\(\(\) => install\(\)\)/);
assert.match(assetsSource, /const chunkSize = 0x2000/);
assert.match(uiSource, /localStorage\.removeItem\(LEGACY_PREF_KEY\)/);
assert.match(buildSource, /@name         ChatGPT Thread Archiver/);
assert.match(buildSource, /@namespace    local\.chatgpt-thread-archiver/);
assert.match(buildSource, /@version      0\.5\.0/);
assert.match(buildSource, /source\('chatgpt-assets\.mjs'\)/);
assert.match(buildSource, /\$\{assets\}/);

assert.throws(() => normalizeConversation({ title: 'No messages' }), ConversationShapeError);

console.log('All fixture checks passed.');
