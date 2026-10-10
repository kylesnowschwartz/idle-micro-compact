import type { EngineInterface, Next, PluginOptions, Register, SessionCompactInput, SessionContextUsage, Timer } from 'claude-code'
import { chooseBranch, estimateAfter } from './decide.ts'
import { microCompact } from './elide.ts'
import { type Outcome, approx, microLine, summaryLine } from './lines.ts'

// How long before a 1-hour cache lapses to compact. A 367k-token summary pass took about 2 minutes.
// Also how late the timer may fire and still compact.
const MARGIN_MS = 10 * 60_000
const HOUR_MS = 60 * 60_000
// Below this many conversation tokens a cold re-read is cheap; not worth losing detail. The system
// prompt and tools don't count: compaction leaves them in place, and they are re-cached either way.
const DEFAULT_MIN_TOKENS = 40_000
// At or under this many conversation tokens after eliding reads, the elided transcript is small
// enough to come back to, and no summary is written.
const DEFAULT_MICRO_TARGET_TOKENS = 150_000

// How this module's own compaction's instructions open: its session.compact hook tells that call
// from a /compact or another plugin's by it. The rest are the summary instructions, so a summary
// written without the hook (skipped, or deciding against eliding) is told the same.
const IDLE_OPENING = 'This idle compaction ran automatically at '

// When a session's last main-loop turn ended (declared in types/index.d.ts). Held by the host for the
// process, so it outlives a reload of this module.
const LAST_TURN = { plugin: 'idle-micro-compact', key: 'lastTurn' } as const

function nonNegative(raw: unknown): number | undefined {
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

const isIdleCompaction = (e: SessionCompactInput) => e.agentId === undefined && e.instructions?.startsWith(IDLE_OPENING) === true

const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5)

/**
 * What compaction can shrink: the conversation, as /context's Messages row counts it. The whole
 * context when there is no breakdown.
 *
 * The row is a residual: the last response's input less the other rows. That needs the `full`
 * breakdown, which counts the other rows with the token-count API; the `summary` one estimates
 * them, and was seen putting the tools at twice their size, which left 2 tokens of conversation.
 */
function conversationTokens(context: SessionContextUsage) {
  const row = context.breakdown?.categories.find((c) => c.kind === 'used' && c.name === 'Messages')
  return row?.tokens ?? context.tokens
}

/** Idle time before compacting. It assumes the 1-hour cache: the mod is no use on a 5-minute one. */
function idleDelayMs(options: PluginOptions) {
  const minutes = nonNegative(options.idleMinutes)
  return minutes ? minutes * 60_000 : HOUR_MS - MARGIN_MS
}

function minTokens(options: PluginOptions) {
  return nonNegative(options.minTokens) ?? DEFAULT_MIN_TOKENS
}

function microTargetTokens(options: PluginOptions) {
  return nonNegative(options.microTargetTokens) ?? DEFAULT_MICRO_TARGET_TOKENS
}

const instructions = (at: string, idleMin: number) =>
  `${IDLE_OPENING}${at}, after ${idleMin} minutes idle, before the prompt cache expired. ` +
  'Open the summary by saying so. Keep open tasks, decisions and their reasons, pending follow-ups with dates, ' +
  'file paths touched, and anything the user asked to be remembered.'

/** The conversation's size as the timer measured it just before asking for its compaction. */
type Pending = { conversation: number }

/** Per-activation state: the armed timer and what the module has put on screen. */
type State = {
  timer?: Timer
  // Bumped on every disarm, so an arm still awaiting its reads can tell it was overtaken.
  generation: number
  hasStatus: boolean
  // What the timer measured just before its compaction, for the session.compact hook.
  pending?: Pending
  // Set by the session.compact hook during this module's own compaction, read by the timer after.
  outcome?: Outcome
}

function disarm(state: State) {
  state.generation++
  state.timer?.cancel()
  state.timer = undefined
}

/** A reload while a turn runs, or after the session ended, must not re-arm. */
function forget($: EngineInterface) {
  return $.state.set(LAST_TURN, null).catch(() => {})
}

function clearStatus($: EngineInterface, state: State) {
  if (state.hasStatus) $.ui.status(undefined)
  state.hasStatus = false
}

/** The conversation's size once the compaction stands, as the Messages row has it, or undefined. */
async function measuredAfter($: EngineInterface) {
  try {
    const { context } = await $.session.usage({ breakdown: 'full' })
    return conversationTokens(context)
  } catch {
    return undefined
  }
}

async function compactIfWorthIt($: EngineInterface, state: State, idleSince: number, latest: number, floor: number, target: number) {
  const fired = state.generation
  try {
    const { context } = await $.session.usage({ breakdown: 'full' })
    // Unknown after a compaction until the next response: nothing to shrink then either.
    if (context.tokens === undefined) return
    const conversation = conversationTokens(context) ?? 0
    if (conversation < floor) {
      $.ui.log(`not compacted: the conversation is ${approx(conversation)} tokens, under the ${approx(floor)} floor`)
      return
    }
    const before = context.tokens ?? 0
    const now = await $.clock.now()
    const at = hhmm(now)
    const idleMin = Math.round((now - idleSince) / 60_000)
    // A timer that fires late (the machine slept) finds the cache cold: compacting now would cost
    // what the cold return costs, and lose detail on top.
    if (now > latest) {
      $.ui.log(`not compacted: the timer fired ${idleMin} min after the last turn, too late for a warm cache`)
      return
    }
    state.pending = { conversation }
    state.outcome = undefined
    // Through /compact rather than $.session.compact: the engine runs none of a plugin's own hooks
    // on an event its own code raised outside a hook, so this module's session.compact hook would
    // never see its own call. Beneath the command it does.
    await $.command.run({ command: 'compact', args: instructions(at, idleMin) }).finally(() => {
      state.pending = undefined
    })
    const outcome = state.outcome as Outcome | undefined
    state.outcome = undefined
    if (outcome === undefined) {
      $.ui.log(`not compacted by this mod at ${at}: /compact ran, but its session.compact hook never saw it`)
      return
    }
    const summary = outcome.summary
    // A summary a hook beneath vetoed has left its own notice.
    if (outcome.branch.kind === 'summary' && summary?.messages === undefined) return
    const after = await measuredAfter($)
    const line =
      summary?.messages === undefined
        ? microLine({ at, idleMin }, outcome, after)
        : summaryLine({ at, idleMin }, outcome, summary, before, after, target)
    $.ui.log(line)
    // A turn started while the summary ran has already cleared the status; don't pin a stale one.
    if (fired !== state.generation) return
    $.ui.status(line)
    state.hasStatus = true
  } catch {
    // a /compact refused or rejected is dropped; the next turn.complete re-arms the timer
  }
}

/** Starts the timer: due `ms` from now, it measures the idle time from `idleSince`. */
function schedule($: EngineInterface, state: State, idleSince: number, ms: number, delay: number, options: PluginOptions) {
  state.timer = $.clock.after(ms, () => {
    state.timer = undefined
    void compactIfWorthIt($, state, idleSince, idleSince + delay + MARGIN_MS, minTokens(options), microTargetTokens(options))
  })
}

async function arm($: EngineInterface, state: State, options: PluginOptions) {
  disarm(state)
  const armed = state.generation
  const delay = idleDelayMs(options)
  const idleSince = await $.clock.now()
  const sessionId = await $.session.id()
  if (armed !== state.generation) return
  schedule($, state, idleSince, delay, delay, options)
  // Kept for a reload of the module, which cancels the timer.
  await $.state.set(LAST_TURN, { sessionId, at: idleSince })
  // A turn.start that disarmed meanwhile may have cleared it before this write landed.
  if (armed !== state.generation) await forget($)
}

/** After a reload: re-arms for what is left of the delay since this session's last turn, if any. */
async function rearm($: EngineInterface, state: State, options: PluginOptions) {
  disarm(state)
  const armed = state.generation
  const delay = idleDelayMs(options)
  const { value: last } = await $.state.get(LAST_TURN)
  const sessionId = await $.session.id()
  const now = await $.clock.now()
  if (armed !== state.generation || !last || last.sessionId !== sessionId) return
  // Past the deadline the timer has fired already, or the session was resumed long after: either way
  // there's nothing to do now.
  const left = last.at + delay - now
  if (left > 0) schedule($, state, last.at, left, delay, options)
}

/**
 * Arms a timer at the end of every main-loop turn and cancels it when the next turn starts, so it
 * runs from the last model request: the last time the cache was refreshed. When it fires on time
 * and the conversation is over the floor, it compacts while the cache is still warm: by eliding
 * Read results and thinking when that is estimated to leave the conversation under the target,
 * with no model call, and by the model's summary otherwise. Either way it leaves a note in the
 * transcript and the status line. The time of the last turn is kept in `$.state`, so a reload of
 * the module, which cancels the timer, re-arms it for the time left.
 */
export const register: Register = (on, options) => {
  // A reloaded module can't tell whether the one before it pinned a status: assume it did.
  const state: State = { generation: 0, hasStatus: true }

  /**
   * Elides when that is estimated to land under the target, answering with no model call; hands the
   * call down to core's summary otherwise. `before` is the Messages row just before the call: the
   * event carries the transcript but not its size.
   */
  async function elideOrSummarize(e: SessionCompactInput, before: number, next: Next<'session.compact'>) {
    const { messages, stats } = microCompact(e.messages)
    const estimate = estimateAfter(before, e.messages, messages)
    const branch = chooseBranch(estimate, microTargetTokens(options), stats)
    if (branch.kind === 'micro') {
      state.outcome = { branch, before, estimate, stats }
      return { messages, tokensBefore: before, tokensAfter: estimate }
    }
    const summary = await next(e)
    state.outcome = { branch, before, estimate, stats, summary }
    return summary
  }

  // Only this module's idle compaction, which arrives as a /compact with its instructions: the
  // person's own /compact, auto-compaction, a subagent's and other plugins' calls go on untouched.
  on('session.compact', { trigger: 'manual' }, async ($, e, next) => {
    if (!isIdleCompaction(e)) return next(e)
    // Raised by someone other than this module's timer, which measured nothing: measure now.
    const before = state.pending?.conversation ?? conversationTokens((await $.session.usage({ breakdown: 'full' })).context)
    return before === undefined ? next(e) : elideOrSummarize(e, before, next)
  }).catch(($, e, next) => {
    // A throw before deciding still leaves a compaction: core's summary, with the same instructions.
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    disarm(state)
    clearStatus($, state)
    await forget($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      // never let arming the timer break the turn
      await arm($, state, options).catch(() => {})
    }
    return result
  })

  on('session.end', async ($, e, next) => {
    disarm(state)
    clearStatus($, state)
    await forget($)
    return next(e)
  })

  // Also fires when the module is reloaded (/reload-plugins, an update, an options change), which
  // cancels the timer: pick up where the last turn left off.
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await rearm($, state, options).catch(() => {})
    return result
  })
}
