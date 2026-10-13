import type { EngineInterface, Next, PluginOptions, Register, SessionCompactInput, SessionContextUsage, SessionMessage, Timer } from 'claude-code'
import { chooseBranch, estimateAfter, removedAnything, thinkingTokensIn } from './decide.ts'
import { type MaskStats, maskOldToolResults } from './mask.ts'
import { type Outcome, type Trim, type When, approx, leftAloneLine, microLine, nothingLeftLine, summaryLine } from './lines.ts'

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
// A trim that saves less than this share of the conversation is not worth rewriting the
// transcript: the next request writes all of it to the cache again.
const DEFAULT_MIN_SAVED_SHARE = 0.1

// How the instructions of the timer's /compact open. Its session.compact hook looks for this opening
// to tell the timer's call apart from a person's /compact or another plugin's. The rest of the
// instructions guide the summary, so a summary written without the hook's help (the hook was
// skipped, or chose the summary) gets the same guidance.
const OWN_OPENING = 'This idle compaction ran '

// The whole of the arguments of /micro-compact's /compact, shown on the `/compact` row it leaves.
// The session.compact hook trims on seeing them and never hands the call to the summary, so they
// carry no summary guidance.
const ON_REQUEST = 'idle-micro-compact: trim on request'

// The slash command that trims at once. Spelled out where it is registered and
// hooked: `claude plugin validate` recognizes a hook answering its own command by a literal name only.
const COMMAND = 'micro-compact'

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
  // the share of the conversation a trim must save, from 0 to 1
  minSavedShare: number
}

/** When the idle time began, and the last moment the cache is still warm enough to compact. */
type IdleWindow = { since: number; latest: number }

/** The sizes just before compacting: the whole context, and the conversation within it. */
type SizesBefore = { contextTokens: number; conversationTokens: number }

/** The conversation's size as measured just before asking for this module's compaction; absent when unknown. */
type Pending = { conversationTokens: number | undefined }

/**
 * What the session.compact hook decided on this module's own compaction, for the line written after
 * it: the timer's outcome, or on /micro-compact's run a trim, nothing to take out, or a failure.
 */
type Decision =
  | { kind: 'timer'; outcome: Outcome }
  | { kind: 'trimmed'; trim: Trim }
  | { kind: 'nothing-left' }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' }

/** Per-activation state: the armed timer and what the module has put on screen. */
type State = {
  timer?: Timer
  // Bumped on every disarm, so an arm still awaiting its reads can tell it was overtaken.
  generation: number
  hasStatus: boolean
  // What was measured just before this module's compaction, for the session.compact hook.
  pending?: Pending
  // Set by the session.compact hook during this module's own compaction, read after it for the report.
  decision?: Decision
}

function nonNegative(raw: unknown): number | undefined {
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

function shareOf(raw: unknown): number | undefined {
  if (typeof raw !== 'number' && typeof raw !== 'string') return undefined
  const n = nonNegative(raw)
  return n !== undefined && n <= 1 ? n : undefined
}

/**
 * The idle time assumes the 1-hour cache: the mod is no use on a 5-minute one. A value out of its
 * range, or not a number, is its default: the host checks options against plugin.json, but a value
 * that reaches the module unchecked must not set a share over 1 or a negative size.
 */
export function readSettings(options: PluginOptions): Settings {
  const idleMinutes = nonNegative(options.idleMinutes)
  return {
    idleMs: idleMinutes ? idleMinutes * MINUTE_MS : HOUR_MS - MARGIN_MS,
    minTokens: nonNegative(options.minTokens) ?? DEFAULT_MIN_TOKENS,
    microTargetTokens: nonNegative(options.microTargetTokens) ?? DEFAULT_MICRO_TARGET_TOKENS,
    minSavedShare: shareOf(options.minSavedShare) ?? DEFAULT_MIN_SAVED_SHARE,
  }
}

const isTimerRun = (e: SessionCompactInput) => e.agentId === undefined && e.instructions?.startsWith(OWN_OPENING) === true

const isRequestRun = (e: SessionCompactInput) => e.agentId === undefined && e.instructions?.trim() === ON_REQUEST

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

/** When the timer's compaction ran. */
type IdleWhen = Extract<When, { idleMin: number }>

const instructions = (when: IdleWhen) =>
  OWN_OPENING +
  `automatically at ${when.at}, after ${when.idleMin} minutes idle, before the prompt cache expired. ` +
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
function takeDecision(state: State) {
  const { decision } = state
  state.decision = undefined
  return decision
}

/** Pins the status line, unless a turn started meanwhile and cleared it already. */
function pinStatus($: EngineInterface, state: State, status: string, isOvertaken: () => boolean) {
  if (isOvertaken()) return
  $.ui.status(status)
  state.hasStatus = true
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

type EstimateFor = { conversationTokens: number; original: readonly SessionMessage[]; compacted: readonly SessionMessage[]; stats: MaskStats }

/** The conversation's estimated size once masked, thinking and masked media included. */
async function estimateFor($: EngineInterface, { conversationTokens, original, compacted, stats }: EstimateFor) {
  // Dropping the thinking-only messages drops all the thinking the API view holds; with none dropped, none counts.
  const droppedThinkingTokens = stats.thinkingDropped ? await sentBackThinkingTokens($) : 0
  return estimateAfter({ conversationTokens, original, compacted, droppedThinkingTokens, maskedMediaTokens: stats.mediaTokens })
}

type Compaction = { e: SessionCompactInput; next: Next<'session.compact'>; conversationTokens: number; state: State; settings: Settings }

/**
 * Masks when that is estimated to land under the target and save enough, answering with no model
 * call; skips the compaction, leaving the conversation as it is, when the trim would save too
 * little; hands the call down to core's summary when the trim would land over the target.
 * `conversationTokens` is the Messages row just before the call: the event carries the transcript
 * but not its size.
 */
async function maskOrSummarize($: EngineInterface, { e, next, conversationTokens, state, settings }: Compaction) {
  const { messages, stats } = maskOldToolResults(e.messages)
  const estimate = await estimateFor($, { conversationTokens, original: e.messages, compacted: messages, stats })
  const branch = chooseBranch({ conversationTokens, estimate, stats }, settings)
  if (branch.kind === 'micro') {
    state.decision = { kind: 'timer', outcome: { branch, conversationTokens, estimate, stats } }
    return { messages, tokensBefore: conversationTokens, tokensAfter: estimate }
  }
  if (branch.kind === 'leave-alone') {
    state.decision = { kind: 'timer', outcome: { branch, conversationTokens, estimate, stats } }
    return { skip: 'a trim would save too little' }
  }
  const summary = await next(e).catch((err: unknown) => {
    // Esc during the summary abandons the call, and core's summary rejects.
    if (next.signal.aborted) state.decision = { kind: 'cancelled' }
    throw err
  })
  state.decision = { kind: 'timer', outcome: { branch, conversationTokens, estimate, stats, summary } }
  return summary
}

type RequestTrim = { e: SessionCompactInput; next: Next<'session.compact'>; conversationTokens: number | undefined; state: State }

/**
 * /micro-compact's compaction: masks old tool results and installs the result with no model call,
 * whatever the conversation's size and however little it saves. A transcript with nothing to take
 * out is left as it is. The size before, when known, is for the line alone.
 */
async function trimOnRequest($: EngineInterface, { e, next, conversationTokens, state }: RequestTrim) {
  const { messages, stats } = maskOldToolResults(e.messages)
  if (!removedAnything(stats)) {
    state.decision = { kind: 'nothing-left' }
    return { skip: 'nothing left to remove' }
  }
  if (conversationTokens === undefined) {
    state.decision = { kind: 'trimmed', trim: { stats } }
    return { messages }
  }
  const estimate = await estimateFor($, { conversationTokens, original: e.messages, compacted: messages, stats })
  // Esc while the thinking was read abandons the call: the transcript stays as it is.
  if (next.signal.aborted) {
    state.decision = { kind: 'cancelled' }
    return { skip: 'cancelled' }
  }
  state.decision = { kind: 'trimmed', trim: { stats, conversationTokens, estimate } }
  return { messages, tokensBefore: conversationTokens, tokensAfter: estimate }
}

/** Runs /compact with the measured size held for the session.compact hook, and returns what the hook decided. */
async function runOwnCompaction($: EngineInterface, state: State, conversationTokens: number | undefined, args: string) {
  state.pending = { conversationTokens }
  state.decision = undefined
  // Through the /compact command rather than $.session.compact: the engine doesn't run a plugin's
  // own hooks on an event that plugin's code raises outside a hook, so this module's session.compact
  // hook would miss its own call. Raised by the command, the event reaches it.
  // A /compact cancelled with Esc resolves as one that compacted: only the hook's decision tells them apart.
  await $.command.run({ command: 'compact', args }).finally(() => {
    state.pending = undefined
  })
  return takeDecision(state)
}

/**
 * The line for a /compact that ended without the hook's decision standing: the person pressed Esc
 * while the hook was deciding, or the /compact ended without raising it.
 */
const stoppedLine = (decision: Decision | undefined, when: When) =>
  decision?.kind === 'cancelled'
    ? 'not compacted: the compaction was cancelled'
    : `not compacted at ${when.at}: the compaction stopped before the mod decided (cancelled?)`

type Report = { outcome: Outcome; when: When; contextTokens: number; settings: Settings; isOvertaken: () => boolean }

/**
 * Writes the line for a compaction that stands to the transcript, and pins it as the status. A
 * conversation left alone gets the transcript line alone, as one under the floor does.
 */
async function report($: EngineInterface, state: State, { outcome, when, contextTokens, settings, isOvertaken }: Report) {
  if (outcome.branch.kind === 'leave-alone') {
    $.ui.log(leftAloneLine({ when, outcome, minSavedShare: settings.minSavedShare }))
    return
  }
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
  pinStatus($, state, status, isOvertaken)
}

type Run = { sizes: SizesBefore; when: IdleWhen; settings: Settings; isOvertaken: () => boolean }

/** The timer's compaction once the size is known: compact, then report what the hook decided. */
async function compactAndReport($: EngineInterface, state: State, { sizes, when, settings, isOvertaken }: Run) {
  // A turn that started while the size was measured means the person is back: leave the conversation be.
  if (isOvertaken()) return
  const decision = await runOwnCompaction($, state, sizes.conversationTokens, instructions(when))
  if (decision?.kind !== 'timer') {
    $.ui.log(stoppedLine(decision, when))
    return
  }
  await report($, state, { outcome: decision.outcome, when, contextTokens: sizes.contextTokens, settings, isOvertaken })
}

type RequestReport = { decision: Decision | undefined; when: When; isOvertaken: () => boolean }

/** Writes the line for /micro-compact's run; a trim also pins the status. */
function reportOnRequest($: EngineInterface, state: State, { decision, when, isOvertaken }: RequestReport) {
  switch (decision?.kind) {
    case 'trimmed': {
      const { status, log } = microLine({ when, outcome: decision.trim })
      $.ui.log(log)
      pinStatus($, state, status, isOvertaken)
      return
    }
    case 'nothing-left':
      $.ui.log(nothingLeftLine(when))
      return
    case 'failed':
      $.ui.log(`not compacted by /${COMMAND}: ${decision.message}`)
      return
    default:
      $.ui.log(stoppedLine(decision, when))
  }
}

const failedLine = (err: unknown) => `not compacted: ${err instanceof Error ? err.message : String(err)}`

async function compactIfWorthIt($: EngineInterface, state: State, { idle, settings }: { idle: IdleWindow; settings: Settings }) {
  const isOvertaken = overtakenSince(state)
  try {
    const sizes = await measureBefore($)
    if (sizes === undefined) return
    if (sizes.conversationTokens < settings.minTokens) {
      $.ui.log(`not compacted: the conversation is ${approx(sizes.conversationTokens)} tokens, under the ${approx(settings.minTokens)} floor`)
      return
    }
    const now = await $.clock.now()
    const when: IdleWhen = { at: hhmm(now), idleMin: Math.round((now - idle.since) / MINUTE_MS) }
    // A timer that fires late (the machine slept) finds the cache cold: compacting now would cost
    // what the cold return costs, and lose detail on top.
    if (now > idle.latest) {
      $.ui.log(`not compacted: the timer fired ${when.idleMin} min after the last turn, too late for a warm cache`)
      return
    }
    await compactAndReport($, state, { sizes, when, settings, isOvertaken })
  } catch (err) {
    // The next turn.complete re-arms the timer.
    $.ui.log(failedLine(err))
  }
}

/**
 * /micro-compact: masks old tool results now and installs the result, whatever the conversation's
 * size, with no summary. The size, when known, is measured for the line alone. It takes the place
 * of the pending timer, which the next turn arms again.
 */
async function compactOnRequest($: EngineInterface, state: State) {
  disarm(state)
  const isOvertaken = overtakenSince(state)
  try {
    await forget($)
    // Unknown right after a compaction, until the next response; a failed read is unknown too.
    const sizes = await measureBefore($).catch(() => undefined)
    const when: When = { at: hhmm(await $.clock.now()), command: COMMAND }
    const decision = await runOwnCompaction($, state, sizes?.conversationTokens, ON_REQUEST)
    reportOnRequest($, state, { decision, when, isOvertaken })
  } catch (err) {
    $.ui.log(failedLine(err))
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
 * the target, with no model call, and by the model's summary when it would not. A trim that would
 * save too little of the conversation is not made, and nothing else is either: the conversation is
 * left as it is. Each outcome leaves a note in the transcript; a compaction also pins the status
 * line. The time of the last turn is kept in `$.state`, so a reload of the module, which cancels
 * the timer, re-arms it for the time left. `/micro-compact` masks at once, whatever the
 * conversation's size and however little it saves, and never summarizes.
 */
export const register: Register = (on, options) => {
  const settings = readSettings(options)
  // A reloaded module can't tell whether the one before it pinned a status: assume it did.
  const state: State = { generation: 0, hasStatus: true }

  // Only this module's own compaction, which arrives as a /compact with its arguments: the person's
  // own /compact, auto-compaction, a subagent's and other plugins' calls go on untouched.
  on('session.compact', { trigger: 'manual' }, async ($, e, next) => {
    if (isRequestRun(e)) return trimOnRequest($, { e, next, conversationTokens: state.pending?.conversationTokens, state })
    if (!isTimerRun(e)) return next(e)
    // Raised by someone other than this module, which measured nothing: measure now.
    const conversationTokens =
      state.pending?.conversationTokens ?? conversationTokensOf((await $.session.usage({ breakdown: 'full' })).context)
    return conversationTokens === undefined ? next(e) : maskOrSummarize($, { e, next, conversationTokens, state, settings })
  }).catch(($, e, next) => {
    // /micro-compact never summarizes: a throw leaves the conversation as it is, and its line says why.
    if (isRequestRun(e)) {
      const message = next.error.message ?? next.error.kind
      state.decision = { kind: 'failed', message }
      return { skip: `idle-micro-compact could not trim: ${message}` }
    }
    // The timer's throw before deciding still leaves a compaction: core's summary, with the same instructions.
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
    await $.command.register({
      name: 'micro-compact',
      description: 'Trim old tool results now, with no summary',
    }).catch(() => {})
    await rearm($, state, settings).catch(() => {})
    return result
  })

  // Registered without `immediate`, so a /micro-compact typed during a turn waits for the turn to end.
  // The compaction is not awaited: the /compact it runs waits for this command to finish, and the
  // host refuses a $.command.run that a command.run hook would wait on.
  on('command.run', { command: 'micro-compact' }, async ($) => {
    void compactOnRequest($, state)
    return {}
  })
}
