import type { ApiMessage, SessionMessage } from 'claude-code'
import type { MaskStats } from './mask.ts'

/**
 * How much of a message the model reads as text: its text, its tool calls' arguments and its tool
 * results. Each tool use also carries its result's text, which the result message holds already,
 * so it is left out to avoid counting a Read twice. Images and thinking have no text here: thinking
 * is counted from the API view instead (thinkingCharsIn), and images not at all.
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

// A rough rate for English text and code, used to turn removed characters into tokens.
const CHARS_PER_TOKEN = 4

// A thinking block sent back holds only its signature, not its text. Its size follows the
// signature's length closely: about this many characters of thinking per signature character,
// plus a fixed part.
const THINKING_CHARS_PER_SIGNATURE_CHAR = 1.218
const THINKING_CHARS_FIXED = 81.6

/** One thinking block's characters: its text when it holds any, else estimated from its signature. */
function thinkingCharsOf(block: ApiMessage['content'][number]) {
  if (typeof block.thinking === 'string' && block.thinking) return block.thinking.length
  // A redacted block carries its encrypted thinking in `data` rather than a signature.
  const signature = typeof block.signature === 'string' ? block.signature : typeof block.data === 'string' ? block.data : ''
  return signature ? Math.round(THINKING_CHARS_PER_SIGNATURE_CHAR * signature.length + THINKING_CHARS_FIXED) : 0
}

/**
 * The thinking the conversation sends back with each request, in characters. The hook's message
 * list shows thinking as empty rows, so this reads it from the Messages API form, where each
 * thinking block keeps its text or signature. Dropping thinking-only messages removes all of it.
 */
export function thinkingCharsIn(messages: readonly ApiMessage[]) {
  let n = 0
  for (const m of messages) {
    for (const block of m.content) if (block.type === 'thinking' || block.type === 'redacted_thinking') n += thinkingCharsOf(block)
  }
  return n
}

type EstimateInput = {
  // the Messages row just before compacting
  conversationTokens: number
  original: readonly SessionMessage[]
  compacted: readonly SessionMessage[]
  // the thinking the compaction drops, as thinkingCharsIn counts it
  droppedThinkingChars: number
}

/**
 * The conversation's size after micro-compaction: its measured size less the removed text and the
 * dropped thinking, at CHARS_PER_TOKEN characters a token. The measured size also holds context
 * with no text in the message list, which micro-compaction leaves in place, so only what was
 * removed comes off and the rest stays in the figure. Missing what dropping images saves, it errs
 * high, toward the summary branch. No token-count request: the timer fires with minutes to spare,
 * not hours.
 */
export function estimateAfter({ conversationTokens, original, compacted, droppedThinkingChars }: EstimateInput) {
  // A masked image or PDF swaps empty text for a longer placeholder: that removes nothing countable.
  const removedTextChars = Math.max(0, readableChars(original) - readableChars(compacted))
  const removedTokens = (removedTextChars + droppedThinkingChars) / CHARS_PER_TOKEN
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
