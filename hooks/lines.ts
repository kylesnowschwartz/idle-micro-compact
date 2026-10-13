import type { ModelUsage, SessionCompactResult, SessionCompacted } from 'claude-code'
import type { Branch } from './decide.ts'
import type { MaskStats } from './mask.ts'

/** What the session.compact hook decided, for the line the timer writes once the compaction stands. */
export type Outcome = {
  branch: Branch
  // the conversation (the Messages row) just before the compaction
  conversationTokens: number
  estimate: number
  stats: MaskStats
  // core's answer on the summary branch
  summary?: SessionCompactResult
}

/** When and after how long idle the compaction ran, as the line opens with it. */
export type When = { at: string; idleMin: number }

/** One compaction in two renderings: a short pinned status and the fuller transcript log. */
export type Lines = { status: string; log: string }

export const inThousands = (n: number) => `${Math.round(n / 1000)}k`
// Small figures as they are: a 100-token floor isn't "0k".
export const approx = (n: number) => (n < 1000 ? `${n}` : inThousands(n))
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** How much of the summary request's input the prompt cache served: the saving this mod exists for. */
function cacheShare(usage: ModelUsage | undefined) {
  if (!usage) return ''
  const input = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  return input ? `${Math.floor((usage.cache_read_input_tokens * 100) / input)}% read from cache` : ''
}

/** Why trimming wasn't enough, as the summary line gives it; empty when the hook never decided. */
function whyNotMicro(outcome: Outcome | undefined, targetTokens: number) {
  if (outcome?.branch.kind !== 'summary') return ''
  if (outcome.branch.reason === 'nothing-to-mask') return 'nothing to trim'
  return `trimming would leave about ${approx(outcome.estimate)}, over the ${approx(targetTokens)} target`
}

type MicroLineInput = { when: When; outcome: Outcome }

/** The micro branch: the conversation before, the estimate after, and what was taken out. */
export function microLine({ when: { at, idleMin }, outcome }: MicroLineInput): Lines {
  const { masked, trimmedToHeadAndTail, errorsCutToStart, thinkingDropped } = outcome.stats
  const removed = [
    plural(masked, 'old tool result removed', 'old tool results removed'),
    `${trimmedToHeadAndTail} shortened`,
    // Rare enough to leave out when there are none.
    ...(errorsCutToStart ? [plural(errorsCutToStart, 'error cut to its start', 'errors cut to their start')] : []),
    plural(thinkingDropped, 'thinking block dropped', 'thinking blocks dropped'),
  ].join(', ')
  const sizes = `${approx(outcome.conversationTokens)} → about ${approx(outcome.estimate)} tokens`
  return { status: `trimmed at ${at}: ${sizes}`, log: `trimmed at ${at} after ${idleMin} min idle: ${sizes} (${removed})` }
}

type SummaryLineInput = {
  when: When
  outcome: Outcome | undefined
  result: SessionCompacted
  // the whole context just before the compaction, for when core's answer doesn't say
  contextTokens: number
  targetTokens: number
}

/**
 * The summary branch: the sizes, then in parentheses why trimming wasn't enough and the cache share.
 * With no outcome the hook never decided (it was skipped), and there is no reason.
 */
export function summaryLine({ when: { at, idleMin }, outcome, result, contextTokens, targetTokens }: SummaryLineInput): Lines {
  // tokensBefore is the whole context; tokensAfter is only the summary, without the system prompt and tools.
  const before = approx(result.tokensBefore ?? contextTokens)
  const sizes = result.tokensAfter === undefined ? `${before} tokens` : `${before} → ${approx(result.tokensAfter)} summary`
  const details = [whyNotMicro(outcome, targetTokens), cacheShare(result.usage)].filter(Boolean).join('; ')
  return { status: `summarized at ${at}: ${sizes}`, log: `summarized at ${at} after ${idleMin} min idle: ${sizes}${details ? ` (${details})` : ''}` }
}
