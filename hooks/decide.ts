import type { SessionMessage } from 'claude-code'
import type { MicroCompactStats } from './elide.ts'

/**
 * How much of a message the model reads as text: its text, its tool calls' arguments and its tool
 * results. Each tool use also carries its result's text, which the result message holds already,
 * so it is left out to avoid counting a Read twice. Images and thinking have no text here, so the
 * estimate misses what dropping them saves.
 */
function chars(messages: readonly SessionMessage[]) {
  let n = 0
  for (const m of messages) {
    n += m.text.length
    for (const u of m.toolUses) n += JSON.stringify(u.input).length
    for (const r of m.toolResults ?? []) n += r.text.length
  }
  return n
}

/**
 * The conversation's size after micro-compaction, scaled from its measured size before by how much
 * text is left. No token-count request: the timer fires with minutes to spare, not hours.
 */
export function estimateAfter(before: number, original: readonly SessionMessage[], trimmed: readonly SessionMessage[]) {
  const total = chars(original)
  return total ? Math.round((before * chars(trimmed)) / total) : before
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
