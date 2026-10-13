import type { ApiMessage, SessionMessage } from 'claude-code'
import type { MaskStats } from './mask.ts'

/**
 * How much of a message the model reads as text: its text, its tool calls' arguments and its tool
 * results. Each tool use also carries its result's text, which the result message holds already,
 * so it is left out to avoid counting a Read twice. Masking changes only tool results, so the
 * difference before and after it is the tool-result text removed.
 */
function readableChars(messages: readonly SessionMessage[]) {
  let n = 0
  for (const m of messages) {
    n += m.text.length
    for (const u of m.toolUses) n += JSON.stringify(u.input).length
    for (const r of m.toolResults ?? []) n += r.text.length
  }
  return n
}

// Token rates for Opus 5.5's tokenizer.
// Tool-result text (file contents, command output, search results): about 2.3 characters a token.
const TOKENS_PER_TOOL_RESULT_CHAR = 0.44
// A thinking block sent back holds only its signature, not its text. Its cost follows the
// signature's length less a fixed part per block, so a short signature costs nothing countable.
const THINKING_TOKENS_PER_SIGNATURE_CHAR = 0.2745
const THINKING_TOKENS_SUBTRACTED_PER_BLOCK = 274
// Stopgap, not calibrated: a thinking block that carries its text costs at least a token per 4
// characters of it.
const THINKING_CHARS_PER_TOKEN = 4
// An image the API reads at up to 1568 px on its long edge, scaled down to fit, at a token per
// 750 pixels, and at most about 1600 tokens an image. Stopgap: a model that reads images at a
// higher resolution costs more than this, so the estimate errs high for it.
const IMAGE_MAX_LONG_EDGE_PX = 1568
const PIXELS_PER_IMAGE_TOKEN = 750
const MAX_TOKENS_PER_IMAGE = 1600
// A PDF, or an image of unknown size: the message list shows it as no text.
const TOKENS_PER_MASKED_MEDIA = 1000

/** An image's or a PDF's size as the model reads it: in pixels for an image, unknown otherwise. */
export type MediaSize = { width: number; height: number } | undefined

/** The tokens a masked image or PDF costs. */
export function mediaTokens(size: MediaSize) {
  if (size === undefined) return TOKENS_PER_MASKED_MEDIA
  const scale = Math.min(1, IMAGE_MAX_LONG_EDGE_PX / Math.max(size.width, size.height))
  const pixels = Math.round(size.width * scale) * Math.round(size.height * scale)
  return Math.min(MAX_TOKENS_PER_IMAGE, Math.round(pixels / PIXELS_PER_IMAGE_TOKEN))
}

/** One thinking block's tokens: from its signature's length, or its text's when that is more. */
function thinkingTokensOf(block: ApiMessage['content'][number]) {
  // Stopgap: a redacted block carries its encrypted thinking in `data` rather than a signature, and
  // is costed at the signature rate until redacted blocks have a rate of their own.
  const signature = typeof block.signature === 'string' ? block.signature : typeof block.data === 'string' ? block.data : ''
  const bySignature = Math.max(0, THINKING_TOKENS_PER_SIGNATURE_CHAR * signature.length - THINKING_TOKENS_SUBTRACTED_PER_BLOCK)
  const text = typeof block.thinking === 'string' ? block.thinking : ''
  return Math.max(bySignature, text.length / THINKING_CHARS_PER_TOKEN)
}

/**
 * The tokens of the thinking the conversation sends back with each request. The hook's message
 * list shows thinking as empty rows, so this reads it from the Messages API form, where each
 * thinking block keeps its signature. Dropping thinking-only messages removes all of it.
 */
export function thinkingTokensIn(messages: readonly ApiMessage[]) {
  let n = 0
  for (const m of messages) {
    for (const block of m.content) if (block.type === 'thinking' || block.type === 'redacted_thinking') n += thinkingTokensOf(block)
  }
  return Math.round(n)
}

type EstimateInput = {
  // the Messages row just before compacting
  conversationTokens: number
  original: readonly SessionMessage[]
  compacted: readonly SessionMessage[]
  // the thinking the compaction drops, as thinkingTokensIn counts it. Masking drops every thinking
  // block, so this is also all the thinking the conversation holds.
  droppedThinkingTokens: number
  // the tokens of the images and PDFs the compaction replaced with a placeholder, as mediaTokens counts them
  maskedMediaTokens: number
}

/**
 * The conversation's size after micro-compaction: its measured size less the removed tool-result
 * text, the dropped thinking and the masked images and PDFs, each at a fixed token rate. Two
 * removals are not counted: attachments the engine drops along with a rebuilt message, and images
 * in other tools' results, which the message list does not show. So the estimate errs high, toward
 * the summary. No token-count request: the timer fires with minutes to spare, not hours.
 */
export function estimateAfter({ conversationTokens, original, compacted, droppedThinkingTokens, maskedMediaTokens }: EstimateInput) {
  // A masked image or PDF swaps empty text for a longer placeholder: its text removes nothing.
  const removedToolResultChars = Math.max(0, readableChars(original) - readableChars(compacted))
  const removedTokens = TOKENS_PER_TOOL_RESULT_CHAR * removedToolResultChars + droppedThinkingTokens + maskedMediaTokens
  return Math.max(0, Math.round(conversationTokens - removedTokens))
}

export type Branch = { kind: 'micro' } | { kind: 'summary'; reason: 'over-target' | 'nothing-to-mask' }

/**
 * Micro-compaction when it removed something and is estimated to land at or under the target;
 * the model's summary otherwise. A pass that removed nothing would rewrite the transcript for no
 * saving, while the conversation is still over the floor that made compacting worth it.
 */
export function chooseBranch(estimate: number, target: number, stats: MaskStats): Branch {
  const changed = stats.masked + stats.trimmedToHeadAndTail + stats.errorsCutToStart + stats.thinkingDropped
  if (changed === 0) return { kind: 'summary', reason: 'nothing-to-mask' }
  return estimate <= target ? { kind: 'micro' } : { kind: 'summary', reason: 'over-target' }
}
