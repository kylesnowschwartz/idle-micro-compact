import type { SessionMessage } from 'claude-code'
import type { MicroCompactStats } from './elide.ts'

/**
 * How much of a message the model reads as text: its text, its tool calls' arguments and its tool
 * results. Each tool use also carries its result's text, which the result message holds already,
 * so it is left out to avoid counting a Read twice. Images and thinking have no text here, so the
 * estimate misses what dropping them saves.
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

/**
 * The conversation's size after micro-compaction: its measured size less the removed text, at
 * CHARS_PER_TOKEN characters a token. The measured size also holds context with no text in the
 * message list, which micro-compaction leaves in place, so only the removed text comes off and the
 * rest stays in the figure. Missing what dropping images and thinking saves, it errs high, toward
 * the summary branch. No token-count request: the timer fires with minutes to spare, not hours.
 */
export function estimateAfter(conversationTokens: number, original: readonly SessionMessage[], trimmed: readonly SessionMessage[]) {
  const removedTokens = (readableChars(original) - readableChars(trimmed)) / CHARS_PER_TOKEN
  return Math.max(0, Math.round(conversationTokens - removedTokens))
}

export type Branch = { kind: 'micro' } | { kind: 'summary'; reason: 'over-target' | 'nothing-to-elide' }

/**
 * Micro-compaction when it removed something and is estimated to land at or under the target;
 * the model's summary otherwise. A pass that removed nothing would rewrite the transcript for no
 * saving, while the conversation is still over the floor that made compacting worth it.
 */
export function chooseBranch(estimate: number, target: number, stats: MicroCompactStats): Branch {
  if (stats.elided === 0 && stats.thinkingDropped === 0) return { kind: 'summary', reason: 'nothing-to-elide' }
  return estimate <= target ? { kind: 'micro' } : { kind: 'summary', reason: 'over-target' }
}
