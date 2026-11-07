// Fits O200K_TABLE in src/token-estimate.mjs against OpenAI's real o200k_base tokenizer.
//
// Development only: the userscript never runs this file and never loads a tokenizer.
//
//   npm install --no-save gpt-tokenizer@4.1.0
//   node tools/fit-token-estimate.mjs <corpus files or folders…>           prints a summary
//   node tools/fit-token-estimate.mjs --write <corpus files or folders…>   also rewrites the table
//
// A corpus file is read as plain text. A .json file holding a string `text`, or a MediaWiki
// answer with `query.pages[].extract`, gives that text instead. Folders are read recursively.
// Only averages leave this script; no corpus text is written anywhere.

import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { o200kLengthBand, o200kPieceEstimate, o200kSegments } from '../src/token-estimate.mjs';

const TABLE_FILE = resolve(new URL('..', import.meta.url).pathname, 'src', 'token-estimate.mjs');
const LENGTH_CAP = 16;
// Latin-script languages other than English get their own factors instead of shaping the
// shared table, so English and code, the most common chat text, set the base. `latin` is
// any other accented Latin-script paragraph.
const LATIN_LANGUAGES = new Set(['es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'tr', 'vi', 'id', 'latin']);

const round = (value) => Math.round(value * 1000) / 1000;

export function fitO200kTable(texts, countTokens, { smoothing = 5, minimumLetters = 400, minimumPieces = 20, minimumLengthPieces = 10 } = {}) {
  const sums = new Map();
  const segments = [];
  for (const text of texts) {
    for (const { entries, language } of o200kSegments(text)) {
      const counts = entries.map((entry) => countTokens(entry.piece));
      segments.push({ entries, language, counts });
      if (LATIN_LANGUAGES.has(language)) continue;
      entries.forEach((entry, index) => {
        const sum = sums.get(entry.family) ?? { pieces: new Array(LENGTH_CAP).fill(0), tokens: new Array(LENGTH_CAP).fill(0), length: 0, total: 0, longLength: 0, longTotal: 0 };
        const slot = Math.min(entry.length, LENGTH_CAP) - 1;
        sum.pieces[slot] += 1;
        sum.tokens[slot] += counts[index];
        sum.length += entry.length;
        sum.total += counts[index];
        if (entry.length >= LENGTH_CAP) {
          sum.longLength += entry.length;
          sum.longTotal += counts[index];
        }
        sums.set(entry.family, sum);
      });
    }
  }

  // Each length's average is pulled towards the family's per-character rate in proportion
  // to how rarely it was seen, so a length met a handful of times cannot swing the table.
  // A row stops at its last length seen `minimumLengthPieces` times; longer pieces use the
  // rate. Families seen fewer than `minimumPieces` times are left to the fallbacks.
  const families = {};
  let letterLength = 0;
  let letterTotal = 0;
  for (const family of [...sums.keys()].sort()) {
    const sum = sums.get(family);
    if (!/^(code\.)?(digits|space|newline|punct)/.test(family)) {
      letterLength += sum.length;
      letterTotal += sum.total;
    }
    if (sum.pieces.reduce((total, pieces) => total + pieces, 0) < minimumPieces) continue;
    const rate = sum.longLength > 0 ? sum.longTotal / sum.longLength : sum.total / sum.length;
    let last = 0;
    for (let length = 1; length < LENGTH_CAP; length += 1) if (sum.pieces[length - 1] >= minimumLengthPieces) last = length;
    const values = [];
    for (let length = 1; length <= Math.max(1, last); length += 1) {
      const prior = Math.max(1, rate * length);
      values.push(round((sum.tokens[length - 1] + smoothing * prior) / (sum.pieces[length - 1] + smoothing)));
    }
    values.push(round(rate));
    families[family] = values;
  }
  const table = { families, languages: {}, perCharacter: round(letterLength > 0 ? letterTotal / letterLength : 0.5) };

  // Language factors: real tokens over the base estimate for each band of word lengths.
  const bands = new Map();
  for (const { entries, language, counts } of segments) {
    if (!language) continue;
    entries.forEach((entry, index) => {
      if (!entry.letters) return;
      const sum = bands.get(language) ?? [0, 1, 2].map(() => ({ letters: 0, real: 0, estimate: 0 }));
      const band = sum[o200kLengthBand(entry.length)];
      band.letters += entry.length;
      band.real += counts[index];
      band.estimate += o200kPieceEstimate(entry, table);
      bands.set(language, sum);
    });
  }
  for (const language of [...bands.keys()].sort()) {
    table.languages[language] = bands.get(language).map((band) => (band.letters >= minimumLetters && band.estimate > 0 ? round(band.real / band.estimate) : 1));
  }
  return table;
}

export function formatO200kTable(table) {
  const families = Object.entries(table.families).map(([family, values]) => `    '${family}': [${values.join(', ')}],`).join('\n');
  const languages = Object.entries(table.languages).map(([language, values]) => `${language}: [${values.join(', ')}]`).join(', ');
  return [
    '// BEGIN GENERATED O200K_TABLE (tools/fit-token-estimate.mjs)',
    '// families: average tokens by length from 1 character up, then tokens per character.',
    '// languages: factors for word pieces of 1–3, 4–7 and 8 or more letters.',
    'const O200K_TABLE = {',
    '  families: {',
    families,
    '  },',
    `  languages: { ${languages} },`,
    `  perCharacter: ${table.perCharacter},`,
    '};',
    '// END GENERATED O200K_TABLE',
  ].join('\n');
}

async function corpusFiles(path) {
  const info = await stat(path);
  if (!info.isDirectory()) return [path];
  const names = (await readdir(path)).sort();
  return (await Promise.all(names.map((name) => corpusFiles(join(path, name))))).flat();
}

async function corpusText(file) {
  const raw = await readFile(file, 'utf8');
  if (!file.endsWith('.json')) return raw;
  try {
    const data = JSON.parse(raw);
    if (typeof data?.text === 'string') return data.text;
    const pages = Object.values(data?.query?.pages ?? {});
    if (pages.length > 0) return pages.map((page) => page.extract ?? '').join('\n');
  } catch {
    // Not JSON after all: use the file as written.
  }
  return raw;
}

async function main(args) {
  const write = args.includes('--write');
  const paths = args.filter((arg) => arg !== '--write');
  if (paths.length === 0) throw new Error('Name at least one corpus file or folder.');
  let encode;
  try {
    ({ encode } = await import('gpt-tokenizer/encoding/o200k_base'));
  } catch {
    throw new Error('gpt-tokenizer is not installed. Run: npm install --no-save gpt-tokenizer@4.1.0');
  }
  const cache = new Map();
  const countTokens = (piece) => {
    let count = cache.get(piece);
    if (count === undefined) {
      count = encode(piece).length;
      cache.set(piece, count);
    }
    return count;
  };
  const files = (await Promise.all(paths.map((path) => corpusFiles(resolve(path))))).flat();
  const texts = (await Promise.all(files.map(corpusText))).filter((text) => text.trim());
  const table = fitO200kTable(texts, countTokens);
  const characters = texts.reduce((sum, text) => sum + text.length, 0);
  console.log(`Fitted on ${texts.length} file(s), ${characters.toLocaleString('en-US')} characters: ${Object.keys(table.families).length} families, ${Object.keys(table.languages).length} language factors.`);
  const block = formatO200kTable(table);
  if (!write) {
    console.log(block);
    return;
  }
  const source = await readFile(TABLE_FILE, 'utf8');
  const pattern = /\/\/ BEGIN GENERATED O200K_TABLE[\s\S]*?\/\/ END GENERATED O200K_TABLE/;
  if (!pattern.test(source)) throw new Error(`No generated table markers in ${TABLE_FILE}.`);
  await writeFile(TABLE_FILE, source.replace(pattern, block));
  console.log(`Rewrote the table in ${TABLE_FILE}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
