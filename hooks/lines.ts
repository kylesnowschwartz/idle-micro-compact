import type { ModelUsage, SessionCompactResult, SessionCompacted } from 'claude-code'
import type { Branch } from './decide.ts'
import type { MicroCompactStats } from './elide.ts'

/** What the session.compact hook decided, for the line the timer writes once the compaction stands. */
export type Outcome = {
  branch: Branch
  before: number
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

/** The micro branch: the conversation before, the estimate after, and what was taken out. */
export function microLine({ at, idleMin }: When, outcome: Outcome, after: number | undefined) {
  const { elided, thinkingDropped } = outcome.stats
  const removed = `${plural(elided, 'read', 'reads')} and ${plural(thinkingDropped, 'thinking block', 'thinking blocks')} elided`
  const sizes = `${inThousands(outcome.before)} conversation → est. ${inThousands(outcome.estimate)}, ${measured(after)}`
  return `micro-compacted at ${at} after ${idleMin} min idle (${sizes}; ${removed}, no model call)`
}

/**
 * The summary branch, as idle-compact words it, led by why micro-compaction wasn't enough. With no
 * outcome the hook never decided (it was skipped), and the line is idle-compact's alone.
 */
export function summaryLine(
  { at, idleMin }: When,
  outcome: Outcome | undefined,
  result: SessionCompacted,
  contextBefore: number,
  after: number | undefined,
  target: number,
) {
  let why = ''
  if (outcome?.branch.kind === 'summary') {
    why =
      outcome.branch.reason === 'nothing-to-elide'
        ? 'nothing to elide; '
        : `micro est. ${inThousands(outcome.estimate)}, over the ${approx(target)} target; `
  }
  // tokensBefore is the whole context; tokensAfter is only the summary, without the system prompt and tools.
  const summary = result.tokensAfter === undefined ? '' : ` → ${inThousands(result.tokensAfter)} summary`
  const sizes = `${inThousands(result.tokensBefore ?? contextBefore)} tokens${summary}, ${measured(after)}${cacheShare(result.usage)}`
  return `compacted at ${at} after ${idleMin} min idle (${why}${sizes})`
}
