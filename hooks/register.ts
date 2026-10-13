import type { EngineInterface, Next, PluginOptions, Register, SessionCompactInput, SessionContextUsage, Timer } from 'claude-code'
import { type AppendedRows, appendedRows } from './carried.ts'
import { chooseBranch, estimateAfter, thinkingTokensIn } from './decide.ts'
import { maskOldToolResults } from './mask.ts'
import { type Outcome, type When, approx, microLine, summaryLine } from './lines.ts'

const MINUTE_MS = 60_000
// The prompt cache's lifetime from the last request; past it the cache is cold.
const HOUR_MS = 60 * MINUTE_MS
// The default lead before the cache lapses, leaving a summary pass time to finish.
const MARGIN_MS = 10 * MINUTE_MS
// Below this many conversation tokens a cold re-read is cheap; not worth losing detail. The system
// prompt and tools don't count: compaction leaves them in place, and they are re-cached either way.
const DEFAULT_MIN_TOKENS = 40_000
// At or under this many conversation tokens after masking old tool results, the masked transcript
// is small enough to come back to, and no summary is written.
const DEFAULT_MICRO_TARGET_TOKENS = 150_000

// How the instructions of this module's own /compact open. Its session.compact hook looks for this
// opening to tell its own call apart from a person's /compact or another plugin's. The rest of the
// instructions guide the summary, so a summary written without the hook's help (the hook was
// skipped, or chose the summary) gets the same guidance.
const IDLE_OPENING = 'This idle compaction ran automatically at '

// When a session's last main-loop turn ended (declared in types/index.d.ts). Held by the host for the
// process, so it outlives a reload of this module.
const LAST_TURN = { plugin: 'idle-micro-compact', key: 'lastTurn' } as const

/** The plugin options, read once: changing them reloads the module. */
type Settings = {
  // idle time before compacting
  idleMs: number
  // the conversation size below which compacting isn't worth it
  minTokens: number
  // the conversation size at or under which masking old tool results is enough
  microTargetTokens: number
}

/** When the idle time began, and the last moment the cache is still warm enough to compact. */
type IdleWindow = { since: number; latest: number }

/** The sizes just before compacting: the whole context, and the conversation within it. */
type SizesBefore = { contextTokens: number; conversationTokens: number }

/** The conversation's size as the timer measured it just before asking for its compaction. */
type Pending = { conversationTokens: number }

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

function nonNegative(raw: unknown): number | undefined {
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/** The idle time assumes the 1-hour cache: the mod is no use on a 5-minute one. */
function readSettings(options: PluginOptions): Settings {
  const idleMinutes = nonNegative(options.idleMinutes)
  return {
    idleMs: idleMinutes ? idleMinutes * MINUTE_MS : HOUR_MS - MARGIN_MS,
    minTokens: nonNegative(options.minTokens) ?? DEFAULT_MIN_TOKENS,
    microTargetTokens: nonNegative(options.microTargetTokens) ?? DEFAULT_MICRO_TARGET_TOKENS,
  }
}

const isIdleCompaction = (e: SessionCompactInput) => e.agentId === undefined && e.instructions?.startsWith(IDLE_OPENING) === true

const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5)

/**
 * What compaction can shrink: the conversation, as /context's Messages row counts it. The whole
 * context when there is no breakdown.
 *
 * The row is a residual: the last response's input less the other rows. That needs the `full`
 * breakdown, which counts the other rows with the token-count API. The `summary` breakdown
 * estimates them and can be badly off, leaving next to nothing for the conversation.
 */
function conversationTokensOf(context: SessionContextUsage) {
  const row = context.breakdown?.categories.find((c) => c.kind === 'used' && c.name === 'Messages')
  return row?.tokens ?? context.tokens
}

const instructions = ({ at, idleMin }: When) =>
  `${IDLE_OPENING}${at}, after ${idleMin} minutes idle, before the prompt cache expired. ` +
  'Open the summary by saying so. Keep open tasks, decisions and their reasons, pending follow-ups with dates, ' +
  'file paths touched, and anything the user asked to be remembered.'

function disarm(state: State) {
  state.generation++
  state.timer?.cancel()
  state.timer = undefined
}

/** A check for whether a disarm has come since this call. */
function overtakenSince(state: State) {
  const generation = state.generation
  return () => generation !== state.generation
}

/** A reload while a turn runs, or after the session ended, must not re-arm. */
function forget($: EngineInterface) {
  return $.state.set(LAST_TURN, null).catch(() => {})
}

function clearStatus($: EngineInterface, state: State) {
  if (state.hasStatus) $.ui.status(undefined)
  state.hasStatus = false
}

/** What the session.compact hook decided, cleared so the next compaction starts without it. */
function takeOutcome(state: State) {
  const { outcome } = state
  state.outcome = undefined
  return outcome
}

/** The sizes just before compacting; undefined while the context size is unknown. */
async function measureBefore($: EngineInterface): Promise<SizesBefore | undefined> {
  const { context } = await $.session.usage({ breakdown: 'full' })
  // Unknown after a compaction until the next response: nothing to shrink then either.
  if (context.tokens === undefined) return undefined
  return { contextTokens: context.tokens, conversationTokens: conversationTokensOf(context) ?? context.tokens }
}

/**
 * The thinking the conversation sends back, in tokens. 0 when the API view can't be read: the
 * estimate then takes no thinking off.
 */
async function sentBackThinkingTokens($: EngineInterface) {
  try {
    return thinkingTokensIn(await $.session.messages({ as: 'api' }))
  } catch {
    return 0
  }
}

type Compaction = {
  e: SessionCompactInput
  next: Next<'session.compact'>
  conversationTokens: number
  state: State
  settings: Settings
  rows: AppendedRows
}

/**
 * Masks when that is estimated to land under the target, answering with no model call; hands the
 * call down to core's summary otherwise. `conversationTokens` is the Messages row just before the
 * call: the event carries the transcript but not its size.
 */
async function maskOrSummarize($: EngineInterface, { e, next, conversationTokens, state, settings, rows }: Compaction) {
  const { messages, stats } = maskOldToolResults(e.messages, rows.carriers(e.messages))
  // Dropping the thinking-only messages drops all the thinking the API view holds; with none dropped, none counts.
  const droppedThinkingTokens = stats.thinkingDropped ? await sentBackThinkingTokens($) : 0
  const estimate = estimateAfter({
    conversationTokens, original: e.messages, compacted: messages, droppedThinkingTokens, maskedMedia: stats.mediaMasked,
  })
  const branch = chooseBranch(estimate, settings.microTargetTokens, stats)
  if (branch.kind === 'micro') {
    state.outcome = { branch, conversationTokens, estimate, stats }
    return { messages, tokensBefore: conversationTokens, tokensAfter: estimate }
  }
  const summary = await next(e)
  state.outcome = { branch, conversationTokens, estimate, stats, summary }
  return summary
}

/** Runs /compact with the measured size held for the session.compact hook, and returns what the hook decided. */
async function runIdleCompaction($: EngineInterface, state: State, conversationTokens: number, when: When) {
  state.pending = { conversationTokens }
  state.outcome = undefined
  // Through the /compact command rather than $.session.compact: the engine doesn't run a plugin's
  // own hooks on an event that plugin's code raises outside a hook, so this module's session.compact
  // hook would miss its own call. Raised by the command, the event reaches it.
  await $.command.run({ command: 'compact', args: instructions(when) }).finally(() => {
    state.pending = undefined
  })
  return takeOutcome(state)
}

type Report = { outcome: Outcome; when: When; contextTokens: number; settings: Settings; isOvertaken: () => boolean }

/** Writes the line for a compaction that stands to the transcript, and pins it as the status. */
async function report($: EngineInterface, state: State, { outcome, when, contextTokens, settings, isOvertaken }: Report) {
  const { summary } = outcome
  // A summary a hook beneath vetoed has left its own notice.
  if (outcome.branch.kind === 'summary' && summary?.messages === undefined) return
  const { status, log, debug } =
    summary?.messages === undefined
      ? microLine({ when, outcome })
      : summaryLine({ when, outcome, result: summary, contextTokens, targetTokens: settings.microTargetTokens })
  $.ui.log(log)
  if (debug) $.ui.log(debug, { to: 'debug' })
  // A turn started while the summary ran has already cleared the status; don't pin a stale one.
  if (isOvertaken()) return
  $.ui.status(status)
  state.hasStatus = true
}

async function compactIfWorthIt($: EngineInterface, state: State, { idle, settings }: { idle: IdleWindow; settings: Settings }) {
  const isOvertaken = overtakenSince(state)
  try {
    const sizes = await measureBefore($)
    if (sizes === undefined) return
    const { contextTokens, conversationTokens } = sizes
    if (conversationTokens < settings.minTokens) {
      $.ui.log(`not compacted: the conversation is ${approx(conversationTokens)} tokens, under the ${approx(settings.minTokens)} floor`)
      return
    }
    const now = await $.clock.now()
    const when: When = { at: hhmm(now), idleMin: Math.round((now - idle.since) / MINUTE_MS) }
    // A timer that fires late (the machine slept) finds the cache cold: compacting now would cost
    // what the cold return costs, and lose detail on top.
    if (now > idle.latest) {
      $.ui.log(`not compacted: the timer fired ${when.idleMin} min after the last turn, too late for a warm cache`)
      return
    }
    // A turn that started while the timer measured means the person is back: leave the conversation be.
    if (isOvertaken()) return
    const outcome = await runIdleCompaction($, state, conversationTokens, when)
    if (outcome === undefined) {
      $.ui.log(`not compacted by this mod at ${when.at}: /compact ran, but its session.compact hook never saw it`)
      return
    }
    await report($, state, { outcome, when, contextTokens, settings, isOvertaken })
  } catch (err) {
    // The next turn.complete re-arms the timer.
    $.ui.log(`not compacted: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Starts the timer, due in `dueInMs`. The idle time counts from `idleSince`. */
function schedule($: EngineInterface, state: State, settings: Settings, { idleSince, dueInMs }: { idleSince: number; dueInMs: number }) {
  const idle: IdleWindow = { since: idleSince, latest: idleSince + HOUR_MS }
  state.timer = $.clock.after(dueInMs, () => {
    state.timer = undefined
    void compactIfWorthIt($, state, { idle, settings })
  })
}

async function arm($: EngineInterface, state: State, settings: Settings) {
  disarm(state)
  const isOvertaken = overtakenSince(state)
  const idleSince = await $.clock.now()
  const sessionId = await $.session.id()
  if (isOvertaken()) return
  schedule($, state, settings, { idleSince, dueInMs: settings.idleMs })
  // Kept for a reload of the module, which cancels the timer.
  await $.state.set(LAST_TURN, { sessionId, at: idleSince })
  // A turn.start that disarmed meanwhile may have cleared it before this write landed.
  if (isOvertaken()) await forget($)
}

/** After a reload: re-arms for what is left of the delay since this session's last turn, if any. */
async function rearm($: EngineInterface, state: State, settings: Settings) {
  disarm(state)
  const isOvertaken = overtakenSince(state)
  const { value: lastTurn } = await $.state.get(LAST_TURN)
  const sessionId = await $.session.id()
  const now = await $.clock.now()
  if (isOvertaken() || !lastTurn || lastTurn.sessionId !== sessionId) return
  // Past the deadline the timer has fired already, or the session was resumed long after: either way
  // there's nothing to do now.
  const dueInMs = lastTurn.at + settings.idleMs - now
  if (dueInMs > 0) schedule($, state, settings, { idleSince: lastTurn.at, dueInMs })
}

/**
 * Arms a timer at the end of every main-loop turn and cancels it when the next turn starts, so it
 * runs from the last model request: the last time the cache was refreshed. When it fires on time
 * and the conversation is over the floor, it compacts while the cache is still warm: by masking
 * old tool results and dropping thinking when that is estimated to leave the conversation under
 * the target, with no model call, and by the model's summary otherwise. Either way it leaves a note in the
 * transcript and the status line. The time of the last turn is kept in `$.state`, so a reload of
 * the module, which cancels the timer, re-arms it for the time left.
 */
export const register: Register = (on, options) => {
  const settings = readSettings(options)
  // A reloaded module can't tell whether the one before it pinned a status: assume it did.
  const state: State = { generation: 0, hasStatus: true }
  // Starts empty on every load, so a reloaded or resumed session protects nothing it did not see arrive.
  const rows = appendedRows()

  // Records each row as it arrives, unchanged, so a trim knows which messages carry a subagent's
  // report or a queued user message.
  on('session.append', async ($, e, next) => {
    rows.record(e)
    return next(e)
  })

  // Registered before the idle compaction's hook, so it stands above it and sees every compaction
  // that stands, this module's own trim included. Each one gives every message a new handle.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.messages !== undefined) rows.clear()
    return result
  })

  // Only this module's idle compaction, which arrives as a /compact with its instructions: the
  // person's own /compact, auto-compaction, a subagent's and other plugins' calls go on untouched.
  on('session.compact', { trigger: 'manual' }, async ($, e, next) => {
    if (!isIdleCompaction(e)) return next(e)
    // Raised by someone other than this module's timer, which measured nothing: measure now.
    const conversationTokens =
      state.pending?.conversationTokens ?? conversationTokensOf((await $.session.usage({ breakdown: 'full' })).context)
    return conversationTokens === undefined ? next(e) : maskOrSummarize($, { e, next, conversationTokens, state, settings, rows })
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
      await arm($, state, settings).catch(() => {})
    }
    return result
  })

  // A /clear starts a new conversation with no session.start, so its rows start over here.
  on('session.end', async ($, e, next) => {
    rows.clear()
    disarm(state)
    clearStatus($, state)
    await forget($)
    return next(e)
  })

  // Also fires when the module is reloaded (/reload-plugins, an update, an options change), which
  // cancels the timer: pick up where the last turn left off.
  on('session.start', async ($, e, next) => {
    rows.clear()
    const result = await next(e)
    await rearm($, state, settings).catch(() => {})
    return result
  })
}
