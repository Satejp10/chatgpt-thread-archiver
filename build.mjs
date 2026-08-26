import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(new URL('.', import.meta.url).pathname);
const source = async (name) => (await readFile(resolve(root, 'src', name), 'utf8')).replace(/^export\s+/gm, '');

const [core, client, claude, assets, stats, ui] = await Promise.all([
  source('core.mjs'),
  source('chatgpt-client.mjs'),
  source('claude-client.mjs'),
  source('chatgpt-assets.mjs'),
  source('export-stats.mjs'),
  readFile(resolve(root, 'src', 'exporter-ui.js'), 'utf8'),
]);

const banner = `// ==UserScript==
// @name         ChatGPT Thread Archiver
// @namespace    local.chatgpt-thread-archiver
// @version      0.10.0
// @description  Export ChatGPT or Claude.ai conversations to self-contained HTML with branch choices, image controls, and safe local statistics.
// @match        https://chatgpt.com/c/*
// @match        https://chatgpt.com/s/*
// @match        https://chatgpt.com/g/*
// @match        https://claude.ai/chat/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
`;

const bundle = `${banner}\n(() => {\n'use strict';\n${core}\n${client}
${claude}
${assets}
${stats}
${ui}\n})();\n`;
const output = resolve(root, 'dist', 'chatgpt-chats-exporter.user.js');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, bundle);
console.log(`Wrote ${output} (${bundle.length} bytes)`);
