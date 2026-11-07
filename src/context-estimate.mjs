// Context estimate (v0.19.0): about how many tokens of a model's context window a chat
// fills, for the gauge at the top of an export. It is local, like the other stats: it
// reads only the chat as normalized for the export, makes no request, and is never the
// provider's own figure.
//
// ChatGPT: the messages' text, counted with the o200k estimate (src/token-estimate.mjs).
// ChatGPT's data carries no system instructions, memory or hidden reasoning to count.
//
// Claude: five parts, added up.
// - Messages, tool calls and tool results: the o200k estimate × 1.4. Claude's tokenizer
//   is unpublished; a third-party test (October 2026) found that models from Opus 4.7 on
//   count about 1.4 times as many tokens as o200k on English text.
// - Thinking: Claude's app sends only summary lines, but every thinking step carries its
//   start and stop times. Opus 5.5 produced thinking at a median 96 tokens a second in a
//   measured session, so each second counts as 100 tokens. Anthropic's API keeps earlier
//   turns' thinking in context from Opus 4.5 on; the app is assumed to do the same.
// - Instructions: Claude's published app prompt for Opus 5.5 (October 2026) is about 6,200
//   o200k tokens, about 8,700 at × 1.4. Tool descriptions, memory, preferences and project
//   knowledge come on top and are not published.
// - Images: Anthropic's formula for models from Claude 4.7 on, ceil(w / 28) × ceil(h / 28)
//   tokens with the long edge scaled to at most 2,576 pixels, capped at 4,784 per image.
//   The size is that of the preview named in Claude's data.
// docs/version-history/v0.19.0.md gives the sources.

const CLAUDE_CONTEXT = {
  textFactor: 1.4,
  thinkingTokensPerSecond: 100,
  instructions: 8700,
  imagePatch: 28,
  imageLongEdge: 2576,
  imageMaxTokens: 4784,
};

export function claudeImageTokens(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0) || !(h > 0)) return null;
  const scale = Math.min(1, CLAUDE_CONTEXT.imageLongEdge / Math.max(w, h));
  const tokens = Math.ceil((w * scale) / CLAUDE_CONTEXT.imagePatch) * Math.ceil((h * scale) / CLAUDE_CONTEXT.imagePatch);
  return Math.min(CLAUDE_CONTEXT.imageMaxTokens, tokens);
}

// JSON.stringify throws on a cycle, and a tool input is provider data rather than ours.
function contextJson(value) {
  try {
    return value && typeof value === 'object' ? JSON.stringify(value) ?? '' : '';
  } catch {
    return '';
  }
}

// `countTokens` is estimateTextTokens. It is passed in because the source modules share
// one scope only inside the built userscript. The messages are the chat's current branch:
// only one branch is ever in the model's context.
export function estimateContextUse(messages, { provider = 'ChatGPT', countTokens = null } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const count = (text) => (text && typeof countTokens === 'function' ? Math.max(0, Number(countTokens(text)) || 0) : 0);
  const messageTexts = [];
  const toolTexts = [];
  let thinkingMs = 0;
  let thinkingSteps = 0;
  let untimedThinkingSteps = 0;
  let images = 0;
  let imageCount = 0;
  let unsizedImageCount = 0;
  for (const message of list) {
    const parts = [];
    for (const block of message?.textBlocks ?? []) {
      if (block?.type === 'text' || block?.type === 'code') parts.push(String(block.text ?? ''));
      else if (block?.type === 'tool_use') toolTexts.push([block.toolName, contextJson(block.input)].filter(Boolean).join('\n'));
      else if (block?.type === 'tool_result') toolTexts.push(String(block.text ?? ''));
      else if (block?.type === 'thinking') {
        thinkingSteps += 1;
        if (Number.isFinite(block.durationMs) && block.durationMs > 0) thinkingMs += block.durationMs;
        else untimedThinkingSteps += 1;
      } else if (block?.type === 'image') {
        imageCount += 1;
        const tokens = claudeImageTokens(block.asset?.width, block.asset?.height);
        if (tokens === null) unsizedImageCount += 1;
        else images += tokens;
      }
    }
    // Joined as the word count joins them, so for ChatGPT this is the stats line's figure.
    const text = parts.join('\n');
    if (text) messageTexts.push(text);
  }
  const messageTokens = count(messageTexts.join('\n'));
  if (provider !== 'Claude') return { provider, total: messageTokens, messages: messageTokens };

  const { textFactor, thinkingTokensPerSecond, instructions } = CLAUDE_CONTEXT;
  const messageShare = Math.round(messageTokens * textFactor);
  const tools = Math.round(count(toolTexts.filter(Boolean).join('\n')) * textFactor);
  const thinkingSeconds = thinkingMs / 1000;
  const thinking = Math.round(thinkingSeconds * thinkingTokensPerSecond);
  return {
    provider,
    total: messageShare + tools + thinking + instructions + images,
    messages: messageShare,
    tools,
    thinking,
    thinkingSeconds,
    thinkingSteps,
    untimedThinkingSteps,
    thinkingTokensPerSecond,
    instructions,
    images,
    imageCount,
    unsizedImageCount,
    textFactor,
  };
}
