import type { ModelUsage, SessionCompactResult, SessionCompacted } from 'claude-code'
import type { Branch } from './decide.ts'
import type { MicroCompactStats } from './elide.ts'

/** What the session.compact hook decided, for the line the timer writes once the compaction stands. */
export type Outcome = {
  branch: Branch
  // the conversation (the Messages row) just before the compaction
  conversationTokens: number
  estimate: number
  stats: MicroCompactStats
  // core's answer on the summary branch
  summary?: SessionCompactResult
}

/** When and after how long idle the compaction ran, as the line opens with it. */
export type When = { at: string; idleMin: number }

export const inThousands = (n: number) => `${Math.round(n / 1000)}k`
// Small figures as they are: a 100-token floor isn't "0k".
export const approx = (n: number) => (n < 1000 ? `${n}` : inThousands(n))
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const measured = (n: number | undefined) => (n === undefined ? 'measured size unknown' : `measured ${inThousands(n)}`)

/** How much of the summary request's input the prompt cache served: the saving this mod exists for. */
function cacheShare(usage: ModelUsage | undefined) {
  if (!usage) return ''
  const input = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  return input ? `, ${Math.floor((usage.cache_read_input_tokens * 100) / input)}% read from cache` : ''
}

/** Why micro-compaction wasn't enough, as the summary line opens with it; empty when the hook never decided. */
function whyNotMicro(outcome: Outcome | undefined, targetTokens: number) {
  if (outcome?.branch.kind !== 'summary') return ''
  if (outcome.branch.reason === 'nothing-to-elide') return 'nothing to elide; '
  return `micro est. ${inThousands(outcome.estimate)}, over the ${approx(targetTokens)} target; `
}

type MicroLineInput = {
  when: When
  outcome: Outcome
  // the conversation once the compaction stands; undefined when it couldn't be measured
  measuredAfter: number | undefined
}

/** The micro branch: the conversation before, the estimate after, and what was taken out. */
export function microLine({ when: { at, idleMin }, outcome, measuredAfter }: MicroLineInput) {
  const { elided, thinkingDropped } = outcome.stats
  const removed = `${plural(elided, 'read', 'reads')} and ${plural(thinkingDropped, 'thinking block', 'thinking blocks')} elided`
  const sizes = `${inThousands(outcome.conversationTokens)} conversation → est. ${inThousands(outcome.estimate)}, ${measured(measuredAfter)}`
  return `micro-compacted at ${at} after ${idleMin} min idle (${sizes}; ${removed}, no model call)`
}

type SummaryLineInput = {
  when: When
  outcome: Outcome | undefined
  result: SessionCompacted
  // the whole context just before the compaction, for when core's answer doesn't say
  contextTokens: number
  measuredAfter: number | undefined
  targetTokens: number
}

/**
 * The summary branch, as idle-compact words it, led by why micro-compaction wasn't enough. With no
 * outcome the hook never decided (it was skipped), and the line is idle-compact's alone.
 */
export function summaryLine({ when: { at, idleMin }, outcome, result, contextTokens, measuredAfter, targetTokens }: SummaryLineInput) {
  // tokensBefore is the whole context; tokensAfter is only the summary, without the system prompt and tools.
  const summary = result.tokensAfter === undefined ? '' : ` → ${inThousands(result.tokensAfter)} summary`
  const sizes = `${inThousands(result.tokensBefore ?? contextTokens)} tokens${summary}, ${measured(measuredAfter)}${cacheShare(result.usage)}`
  return `compacted at ${at} after ${idleMin} min idle (${whyNotMicro(outcome, targetTokens)}${sizes})`
}
