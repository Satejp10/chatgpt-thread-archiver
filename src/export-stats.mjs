function statText(message) {
  return (message?.textBlocks ?? [])
    .filter((block) => block.type === 'text' || block.type === 'code')
    .map((block) => String(block.text ?? ''))
    .join('\n');
}

function wordCount(text) {
  const value = String(text ?? '').trim();
  return value ? value.split(/\s+/u).length : 0;
}

function safeModelIdentifier(value) {
  const model = String(value ?? '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(model) ? model : null;
}

export function deriveExportStats(messages, baseStats = {}, { model = null } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const text = list.map(statText).filter(Boolean).join('\n');
  const modelsUsed = [...new Set([
    safeModelIdentifier(model),
    ...list.map((message) => safeModelIdentifier(message?.modelSlug)),
  ].filter(Boolean))];
  const textBlockCount = list.reduce((sum, message) => sum + (message?.textBlocks ?? []).filter((block) => block.type === 'text' || block.type === 'code').length, 0);
  return {
    ...baseStats,
    messageCount: list.length,
    userMessageCount: list.filter((message) => message.role === 'user').length,
    assistantMessageCount: list.filter((message) => message.role === 'assistant').length,
    toolMessageCount: list.filter((message) => message.role === 'tool').length,
    textBlockCount,
    wordCount: wordCount(text),
    characterCount: [...text].length,
    modelsUsed,
  };
}
