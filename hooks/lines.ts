import type { ModelUsage, SessionCompactResult, SessionCompacted } from 'claude-code'
import type { Branch } from './decide.ts'
import type { MaskStats } from './mask.ts'

/** What the session.compact hook decided, for the line written once the compaction stands. */
export type Outcome = {
  branch: Branch
  // the conversation (the Messages row) just before the compaction
  conversationTokens: number
  estimate: number
  stats: MaskStats
  // core's answer on the summary branch
  summary?: SessionCompactResult
}

/** When the compaction ran, and what set it off: the idle timer after `idleMin` minutes, or a slash command. */
export type When = { at: string; idleMin: number } | { at: string; command: string }

/** What set the compaction off, as the line says it: `after 50 min idle`, `by /micro-compact`. */
const cause = (when: When) => ('command' in when ? `by /${when.command}` : `after ${when.idleMin} min idle`)

/** One compaction in up to three renderings: a short pinned status, the transcript log, and tuning detail for the debug log. */
export type Lines = { status: string; log: string; debug?: string }

export const inThousands = (n: number) => `${Math.round(n / 1000)}k`
// Small figures as they are: a 100-token floor isn't "0k".
export const approx = (n: number) => (n < 1000 ? `${n}` : inThousands(n))
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** How much of the summary request's input the prompt cache served: the saving this mod exists for. */
function cacheShare(usage: ModelUsage | undefined) {
  if (!usage) return ''
  const input = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  return input ? `summary request ${Math.floor((usage.cache_read_input_tokens * 100) / input)}% cached` : ''
}

/** Why trimming wasn't enough, for the debug line; empty when the hook never decided. */
function whyNotMicro(outcome: Outcome | undefined, targetTokens: number) {
  if (outcome?.branch.kind !== 'summary') return ''
  return `trim estimate ${approx(outcome.estimate)}, target ${approx(targetTokens)}`
}

/**
 * What a trim took out, with the conversation's size before it and the estimate after it. The
 * sizes are absent when the size before was unknown, as right after a compaction.
 */
export type Trim = { stats: MaskStats; conversationTokens?: number; estimate?: number }

type MicroLineInput = { when: When; outcome: Trim }

/** The micro branch: the conversation before and the estimate after, when known, and what was taken out. */
export function microLine({ when, outcome }: MicroLineInput): Lines {
  const { masked, trimmedToHeadAndTail, errorsCutToStart, thinkingDropped } = outcome.stats
  const removed = [
    plural(masked, 'old tool result removed', 'old tool results removed'),
    `${trimmedToHeadAndTail} shortened`,
    // Rare enough to leave out when there are none.
    ...(errorsCutToStart ? [plural(errorsCutToStart, 'error cut to its start', 'errors cut to their start')] : []),
    plural(thinkingDropped, 'thinking block dropped', 'thinking blocks dropped'),
  ].join(', ')
  const { conversationTokens, estimate } = outcome
  if (conversationTokens === undefined || estimate === undefined) {
    return { status: `trimmed at ${when.at}`, log: `trimmed at ${when.at} ${cause(when)} (${removed})` }
  }
  const sizes = `${approx(conversationTokens)} → ~${approx(estimate)} tokens`
  return { status: `trimmed at ${when.at}: ${sizes}`, log: `trimmed at ${when.at} ${cause(when)}: ${sizes} (${removed})` }
}

/** A trim that found nothing to take out, so the transcript stays as it is. */
export const nothingLeftLine = (when: When) =>
  `trimmed at ${when.at} ${cause(when)}: nothing left to remove (old tool results are already placeholders or among the 5 newest)`

// A share as a percentage, to a tenth at most: 0.1 is "10%", 0.025 is "2.5%".
const percent = (share: number) => `${Number((share * 100).toFixed(1))}%`

type LeftAloneLineInput = { when: When; outcome: Outcome; minSavedShare: number }

/** The leave-alone branch, for the transcript alone: what a trim would save, against the minimum. */
export function leftAloneLine({ when, outcome, minSavedShare }: LeftAloneLineInput) {
  const saved = Math.max(0, outcome.conversationTokens - outcome.estimate)
  return (
    `not trimmed at ${when.at} ${cause(when)}: a trim would save ~${approx(saved)} of ` +
    `${approx(outcome.conversationTokens)} tokens, under the ${percent(minSavedShare)} minimum`
  )
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
 * The summary branch: the sizes in the status and the log. The debug line holds why trimming wasn't
 * enough and the cache share, and is absent when neither is known. With no outcome the hook never
 * decided (it was skipped), and there is no reason.
 */
export function summaryLine({ when, outcome, result, contextTokens, targetTokens }: SummaryLineInput): Lines {
  // tokensBefore is the whole context; tokensAfter is only the summary, without the system prompt and tools.
  const before = approx(result.tokensBefore ?? contextTokens)
  const sizes = result.tokensAfter === undefined ? `${before} tokens` : `${before} → ${approx(result.tokensAfter)} summary`
  const details = [whyNotMicro(outcome, targetTokens), cacheShare(result.usage)].filter(Boolean).join('; ')
  return {
    status: `summarized at ${when.at}: ${sizes}`,
    log: `summarized at ${when.at} ${cause(when)}: ${sizes}`,
    ...(details ? { debug: `summary chosen: ${details}` } : {}),
  }
}
