import type { ContextCategory, ContextCategoryKind, ModelUsage, On, SessionContextBreakdown, SessionMessage, TurnCompleteInput } from 'claude-code'
import { type Engine, describe, expect, mock, test, tier } from 'claude-code/testing'
import { readSettings } from '../hooks/register.ts'

// Adapted from davidar/claude-idle-compact, tests/register.test.ts at commit
// 35ec925345acfce26bc0ba260c1f611dceab1148 (MIT; see LICENSE). The test's command.run hook stands
// for the built-in /compact: it raises session.compact over a transcript, through the mod's hook,
// and the test's session.compact hook beneath stands for core's summary.

tier('user')

const MIN = 60_000
const SUMMARY: SessionMessage = { role: 'user', text: 'summary', toolUses: [] }

const numbered = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${String(from + i).padStart(6)}\tline ${from + i}`).join('\n')

/** Nothing to elide, so every compaction is the summary, as idle-compact's always is. */
const CHAT: SessionMessage[] = [
  { role: 'user', text: 'hello', toolUses: [], handle: 'u0' },
  { role: 'assistant', text: 'hi', toolUses: [], handle: 'a0' },
]

/** One long Read and five short calls since: masking the Read takes out nearly all the text. */
const READ: SessionMessage[] = [
  { role: 'user', text: 'read a.ts', toolUses: [], handle: 'u0' },
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: '/src/a.ts' } }], handle: 'a1' },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: numbered(1, 2000), isError: false }], handle: 'u1' },
  ...[1, 2, 3, 4, 5].flatMap((i): SessionMessage[] => [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: `b${i}`, tool: 'Bash', input: { command: `echo ${i}` } }], handle: `ba${i}` },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `b${i}`, text: `${i}`, isError: false }], handle: `bu${i}` },
  ]),
  { role: 'assistant', text: 'done', toolUses: [], handle: 'a2' },
]

type Setup = {
  /** The whole context; null for unknown, as after a compaction. */
  tokens?: number | null
  /** The conversation (the breakdown's Messages row); null for no breakdown. 20k of system prompt and tools by default. */
  messages?: number | null
  compact?: 'ok' | 'skip' | 'throw'
  usage?: ModelUsage
  /** What `$.state` holds at the start, as a reloaded module finds it. */
  stored?: Stored
  /** The Messages row once a compaction stands; the whole context is unknown until the next response. */
  after?: number
  /** What /compact compacts. */
  transcript?: SessionMessage[]
}

type Stored = { sessionId: string; at: number } | null

const row = (name: string, tokens: number, kind: ContextCategoryKind = 'used'): ContextCategory =>
  ({ name, tokens, kind, color: 'inactive', isDeferred: false })

/** What /context would list: the system prompt and tools, the conversation, the rest of the window. */
function breakdown(tokens: number | null, messages: number): SessionContextBreakdown {
  const total = tokens ?? messages
  return {
    categories: [row('System prompt', total - messages), row('Messages', messages), row('Free space', 1_000_000 - total, 'free')],
    totalTokens: total, maxTokens: 1_000_000, rawMaxTokens: 1_000_000, autocompactSource: 'model-default', percentage: Math.round(total / 10_000),
    gridRows: [], model: 'test', memoryFiles: [], mcpTools: [], agents: [], isAutoCompactEnabled: true, apiUsage: null,
  }
}

/** Answers everything the module reads beneath it, and records what it does. */
function setup(engine: Engine, on: On, { tokens = 200_000, messages = tokens === null ? null : tokens - 20_000, compact = 'ok', usage, stored = null, after = 15_000, transcript = CHAT }: Setup = {}) {
  const clock = mock.clock(on, { now: T0 })
  // lateMs: how late the timer fires, as after the machine slept. The module reads the usage
  // before the time, so the usage hook is where the clock runs on.
  // duringUsage: run once while the module reads the usage, to overtake the timer.
  // duringRead: run once while the module reads `$.state`, to overtake a re-arm.
  // duringWrite: run once before a write to `$.state` lands, to overtake an arm.
  const seen = {
    compacts: [] as string[], commands: [] as string[], registered: [] as { name: string; description: string }[], logs: [] as string[], debug: [] as string[], status: [] as (string | undefined)[], lateMs: 0, isCompacted: false,
    stored, duringRead: undefined as (() => Promise<unknown>) | undefined,
    duringUsage: undefined as (() => Promise<unknown>) | undefined,
    duringWrite: undefined as (() => Promise<unknown>) | undefined,
  }
  on('session.usage', async (_$, e) => {
    if (seen.lateMs) await clock.advance(seen.lateMs)
    const during = seen.duringUsage
    seen.duringUsage = undefined
    if (during) await during()
    if (seen.isCompacted) {
      const context = { tokens: undefined, window: 1_000_000 }
      return { value: { startedAt: 0, context: e.breakdown ? { ...context, breakdown: breakdown(null, after) } : context, rateLimits: [] } }
    }
    const context = { tokens: tokens ?? undefined, window: 1_000_000 }
    const withBreakdown = e.breakdown && messages !== null ? { ...context, breakdown: breakdown(tokens, messages) } : context
    return { value: { startedAt: 0, context: withBreakdown, rateLimits: [] } }
  })
  on('command.run', { command: 'compact' }, async (_$, e) => {
    if (compact === 'throw') throw new Error('refused')
    seen.commands.push(e.args)
    const result = await (engine as any).session.compact({ trigger: 'manual', instructions: e.args, messages: transcript })
    if (result.messages) seen.isCompacted = true
    return { text: result.skip ?? 'Compacted' }
  })
  on('session.compact', (_$, e) => {
    seen.compacts.push(e.instructions ?? '')
    if (compact === 'skip') return { skip: 'nothing to compact' }
    return { messages: [SUMMARY], tokensBefore: tokens ?? undefined, tokensAfter: 12_000, usage }
  })
  on('command.register', (_$, e) => (seen.registered.push({ name: e.name, description: e.description }), { value: { command: e.name } }))
  on('ui.log', (_$, e) => ((e.to === 'debug' ? seen.debug : seen.logs).push(e.text), { value: undefined }))
  on('ui.status', (_$, e) => (seen.status.push(e.text), { value: undefined }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('state.get', async () => {
    const value = seen.stored
    const during = seen.duringRead
    seen.duringRead = undefined
    if (during) await during()
    return { value: { value, version: 0 } }
  })
  on('state.set', async (_$, e) => {
    const during = seen.duringWrite
    seen.duringWrite = undefined
    if (during) await during()
    seen.stored = e.value as Stored
    return { value: { isSet: true as const, version: 1 } }
  })
  return { clock, seen }
}

const turnDone = ($: Engine, extra: Partial<TurnCompleteInput> = {}) =>
  $.turn.complete({ answer: 'hi', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', ...extra } as TurnCompleteInput)

const turnStart = ($: Engine) => $.turn.start({ text: 'back', turnId: 't2' })

/** What a reload of the module raises: session.start, in this test on the same activation. */
const reload = ($: Engine) => $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

const T0 = Date.parse('2026-09-29T18:00:00')

/** The person typing /micro-compact at the prompt. */
async function microCompact($: Engine, clock: { settle: () => Promise<void> }) {
  await $.command.run({ command: 'micro-compact', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  await clock.settle()
}

describe('timing', () => {
  test('compacts 50 minutes after the last turn', async ($, on) => {
    const { clock, seen } = setup($, on)
    await turnDone($)
    await clock.advance(50 * MIN - 1)
    expect(seen.compacts).toEqual([])
    await clock.advance(2)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
    expect(seen.compacts[0]).toContain('at 18:50, after 50 minutes idle')
  })

  test('idleMinutes 0 means the default 50 minutes', { options: { idleMinutes: 0 } }, async ($, on) => {
    const { clock, seen } = setup($, on)
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
  })

  test('the idleMinutes option overrides the delay', { options: { idleMinutes: 5 } }, async ($, on) => {
    const { clock, seen } = setup($, on)
    await turnDone($)
    await clock.advance(5 * MIN - 1)
    expect(seen.compacts).toEqual([])
    await clock.advance(2)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
  })

  test('an aborted turn arms the timer too', async ($, on) => {
    const { clock, seen } = setup($, on)
    await turnDone($, { reason: 'aborted', isAborted: true })
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
  })

  test('a subagent turn does not arm the timer', async ($, on) => {
    const { clock, seen } = setup($, on)
    await turnDone($, { agentId: 'a1' })
    await clock.advance(2 * 60 * MIN)
    await clock.settle()
    expect(seen.compacts).toEqual([])
  })
})

describe('cancelling', () => {
  test('a new turn cancels the timer', async ($, on) => {
    const { clock, seen } = setup($, on)
    await turnDone($)
    await clock.advance(30 * MIN)
    await turnStart($)
    await clock.advance(2 * 60 * MIN)
    await clock.settle()
    expect(seen.compacts).toEqual([])
  })

  test('/clear cancels the timer', async ($, on) => {
    const { clock, seen } = setup($, on)
    await turnDone($)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    await clock.advance(2 * 60 * MIN)
    await clock.settle()
    expect(seen.compacts).toEqual([])
  })

  test('/clear forgets the last turn, so a reload does not re-arm', async ($, on) => {
    const { clock, seen } = setup($, on)
    await turnDone($)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    expect(seen.stored).toBe(null)
    await reload($)
    await clock.advance(2 * 60 * MIN)
    await clock.settle()
    expect(seen.compacts).toEqual([])
  })
})

describe('reloading', () => {
  test('a turn keeps its end time for a reload', async ($, on) => {
    const { seen } = setup($, on)
    await turnDone($)
    expect(seen.stored).toEqual({ sessionId: 's1', at: T0 })
  })

  test('a reload mid-idle compacts at the original deadline', async ($, on) => {
    const { clock, seen } = setup($, on)
    await turnDone($)
    await clock.advance(30 * MIN)
    await reload($)
    await clock.advance(20 * MIN - 1)
    expect(seen.compacts).toEqual([])
    await clock.advance(2)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
    expect(seen.compacts[0]).toContain('at 18:50, after 50 minutes idle')
    expect(seen.logs).toEqual(['summarized at 18:50 after 50 min idle: 200k → 12k summary'])
    expect(seen.debug).toEqual(['summary chosen: trim estimate 180k, target 150k'])
  })

  test('a freshly loaded module re-arms from the stored turn', async ($, on) => {
    const { clock, seen } = setup($, on, { stored: { sessionId: 's1', at: T0 - 30 * MIN } })
    await reload($)
    await clock.advance(20 * MIN - 1)
    expect(seen.compacts).toEqual([])
    await clock.advance(2)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
    expect(seen.logs).toEqual(['summarized at 18:20 after 50 min idle: 200k → 12k summary'])
    expect(seen.debug).toEqual(['summary chosen: trim estimate 180k, target 150k'])
  })

  test('a reload past the deadline does nothing and says nothing', async ($, on) => {
    const { clock, seen } = setup($, on, { stored: { sessionId: 's1', at: T0 - 3 * 24 * 60 * MIN } })
    await reload($)
    await clock.advance(2 * 60 * MIN)
    await clock.settle()
    expect(seen.compacts).toEqual([])
    expect(seen.logs).toEqual([])
  })

  test("another session's turn does not arm this one", async ($, on) => {
    const { clock, seen } = setup($, on, { stored: { sessionId: 's0', at: T0 - 30 * MIN } })
    await reload($)
    await clock.advance(2 * 60 * MIN)
    await clock.settle()
    expect(seen.compacts).toEqual([])
  })

  test('a reload while a turn runs arms nothing', async ($, on) => {
    const { clock, seen } = setup($, on)
    await turnDone($)
    await clock.advance(10 * MIN)
    await turnStart($)
    expect(seen.stored).toBe(null)
    await reload($)
    await clock.advance(2 * 60 * MIN)
    await clock.settle()
    expect(seen.compacts).toEqual([])
  })

  test('a turn that starts while a reload reads the stored turn wins', async ($, on) => {
    const { clock, seen } = setup($, on, { stored: { sessionId: 's1', at: T0 - 30 * MIN } })
    seen.duringRead = () => turnStart($)
    await reload($)
    await clock.advance(2 * 60 * MIN)
    await clock.settle()
    expect(seen.compacts).toEqual([])
  })

  test('a turn that starts while the end time is being stored leaves nothing for a reload', async ($, on) => {
    const { clock, seen } = setup($, on)
    seen.duringWrite = () => turnStart($)
    await turnDone($)
    expect(seen.stored).toBe(null)
    await reload($)
    await clock.advance(2 * 60 * MIN)
    await clock.settle()
    expect(seen.compacts).toEqual([])
  })

  test("a reloaded module clears the status line its predecessor pinned", async ($, on) => {
    const { seen } = setup($, on)
    await turnStart($)
    expect(seen.status).toEqual([undefined])
  })

  test('a reload after the compaction does not compact again', async ($, on) => {
    const { clock, seen } = setup($, on)
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
    await reload($)
    await clock.advance(2 * 60 * MIN)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
  })

  test('a reload after a manual /compact re-arms, and the unknown size leaves it alone', async ($, on) => {
    const { clock, seen } = setup($, on, { tokens: null, stored: { sessionId: 's1', at: T0 - 30 * MIN } })
    await reload($)
    await clock.advance(2 * 60 * MIN)
    await clock.settle()
    expect(seen.compacts).toEqual([])
    expect(seen.logs).toEqual([])
  })
})

describe('when it fires', () => {
  test('small conversations are left alone, however big the system prompt and tools', async ($, on) => {
    const { clock, seen } = setup($, on, { tokens: 120_000, messages: 39_000 })
    await turnDone($)
    await clock.advance(2 * 60 * MIN)
    await clock.settle()
    expect(seen.compacts).toEqual([])
  })

  test('a conversation under the floor says why it was left alone', async ($, on) => {
    const { clock, seen } = setup($, on, { tokens: 32_000, messages: 12_000 })
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.logs).toEqual(['not compacted: the conversation is 12k tokens, under the 40k floor'])
    expect(seen.status).toEqual([])
  })

  test('a small floor reads as it is', { options: { minTokens: 100 } }, async ($, on) => {
    const { clock, seen } = setup($, on, { tokens: 20_050, messages: 50 })
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.logs).toEqual(['not compacted: the conversation is 50 tokens, under the 100 floor'])
  })

  test('the floor is on the conversation', async ($, on) => {
    const { clock, seen } = setup($, on, { tokens: 61_000, messages: 41_000 })
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.commands.length).toBe(1)
  })

  test('the minTokens option sets the floor', { options: { minTokens: 10_000 } }, async ($, on) => {
    const { clock, seen } = setup($, on, { tokens: 30_000, messages: 11_000 })
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.commands.length).toBe(1)
  })

  test('without a breakdown, the whole context counts', async ($, on) => {
    const { clock, seen } = setup($, on, { tokens: 200_000, messages: null })
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
  })

  test('leaves a transcript line and a status line, cleared by the next turn', async ($, on) => {
    const { clock, seen } = setup($, on)
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    const status = 'summarized at 18:50: 200k → 12k summary'
    expect(seen.logs).toEqual(['summarized at 18:50 after 50 min idle: 200k → 12k summary'])
    expect(seen.debug).toEqual(['summary chosen: trim estimate 180k, target 150k'])
    expect(seen.status).toEqual([status])
    await turnStart($)
    expect(seen.status).toEqual([status, undefined])
  })

  test('the line says how much of the summary request came from the cache', async ($, on) => {
    const usage = { input_tokens: 1_500, output_tokens: 800, cache_read_input_tokens: 198_000, cache_creation_input_tokens: 500 }
    const { clock, seen } = setup($, on, { usage })
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.logs).toEqual(['summarized at 18:50 after 50 min idle: 200k → 12k summary'])
    expect(seen.debug).toEqual(['summary chosen: trim estimate 180k, target 150k; summary request 99% cached'])
  })

  test('a timer that fires late, after the machine slept, does not compact and says why', async ($, on) => {
    const { clock, seen } = setup($, on)
    await turnDone($)
    seen.lateMs = 8 * 60 * MIN
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.compacts).toEqual([])
    expect(seen.logs).toEqual(['not compacted: the timer fired 530 min after the last turn, too late for a warm cache'])
    expect(seen.status).toEqual([])
  })

  test('an idle delay that reaches the cache lifetime does not compact', { options: { idleMinutes: 60 } }, async ($, on) => {
    const { clock, seen } = setup($, on)
    await turnDone($)
    seen.lateMs = 1
    await clock.advance(60 * MIN)
    await clock.settle()
    expect(seen.compacts).toEqual([])
    expect(seen.logs).toEqual(['not compacted: the timer fired 60 min after the last turn, too late for a warm cache'])
  })

  test('a turn that starts while the timer measures stops the compaction, without a word', async ($, on) => {
    const { clock, seen } = setup($, on)
    await turnDone($)
    seen.duringUsage = () => turnStart($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.commands).toEqual([])
    expect(seen.compacts).toEqual([])
    expect(seen.logs).toEqual([])
  })

  test('a timer a few minutes late still compacts', async ($, on) => {
    const { clock, seen } = setup($, on)
    await turnDone($)
    seen.lateMs = 9 * MIN
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
  })

  test('an unknown context size, as after a manual /compact, is left alone without a word', async ($, on) => {
    const { clock, seen } = setup($, on, { tokens: null })
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.compacts).toEqual([])
    expect(seen.logs).toEqual([])
  })

  test('an unknown context size is left alone even with no floor', { options: { minTokens: 0 } }, async ($, on) => {
    const { clock, seen } = setup($, on, { tokens: null })
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.compacts).toEqual([])
  })

  test('compacts only once if nobody comes back', async ($, on) => {
    const { clock, seen } = setup($, on)
    await turnDone($)
    await clock.advance(10 * 60 * MIN)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
  })

  test('a skipped compaction says nothing', async ($, on) => {
    const { clock, seen } = setup($, on, { compact: 'skip' })
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
    expect(seen.logs).toEqual([])
    expect(seen.status).toEqual([])
  })

  test('a rejected compaction says why, and the next turn re-arms', async ($, on) => {
    const { clock, seen } = setup($, on, { compact: 'throw' })
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    // The kit treats a throwing hook as absent: the rejection that reaches the mod is the bottom hook's.
    const line = 'not compacted: no implementation for command.run'
    expect(seen.logs).toEqual([line])
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.logs).toEqual([line, line])
    expect(seen.status).toEqual([])
  })
})

describe('choosing the branch', () => {
  test('masks old tool results with no model call when that lands under the target', async ($, on) => {
    const { clock, seen } = setup($, on, { tokens: 140_000, transcript: READ })
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.commands.length).toBe(1)
    expect(seen.compacts).toEqual([])
    expect(seen.logs).toEqual([
      'trimmed at 18:50 after 50 min idle: 120k → ~106k tokens (1 old tool result removed, 0 shortened, 0 thinking blocks dropped)',
    ])
    expect(seen.status).toEqual(['trimmed at 18:50: 120k → ~106k tokens'])
  })

  test('writes the summary when the masked transcript would still be over the target', { options: { microTargetTokens: 100 } }, async ($, on) => {
    const { clock, seen } = setup($, on, { transcript: READ })
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
    expect(seen.compacts[0]).toContain('at 18:50, after 50 minutes idle')
    expect(seen.logs).toEqual(['summarized at 18:50 after 50 min idle: 200k → 12k summary'])
    expect(seen.debug).toEqual(['summary chosen: trim estimate 166k, target 100'])
  })

  test('leaves the conversation alone when a trim would save under 10% of it', { options: { microTargetTokens: 1_000_000 } }, async ($, on) => {
    const { clock, seen } = setup($, on, { tokens: 320_000, transcript: READ })
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.commands.length).toBe(1)
    expect(seen.compacts).toEqual([])
    expect(seen.isCompacted).toBe(false)
    expect(seen.logs).toEqual(['not trimmed at 18:50 after 50 min idle: a trim would save ~14k of 300k tokens, under the 10% minimum'])
    expect(seen.debug).toEqual([])
    expect(seen.status).toEqual([])
  })

  test('a conversation left alone is not compacted again until the next turn', { options: { microTargetTokens: 1_000_000 } }, async ($, on) => {
    const { clock, seen } = setup($, on, { tokens: 320_000, transcript: READ })
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    await clock.advance(10 * 60 * MIN)
    await clock.settle()
    expect(seen.commands.length).toBe(1)
    await turnStart($)
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.commands.length).toBe(2)
  })

  test('leaves a conversation under the target alone when there is nothing to trim', async ($, on) => {
    const { clock, seen } = setup($, on, { tokens: 61_000, messages: 41_000 })
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.compacts).toEqual([])
    expect(seen.logs).toEqual(['not trimmed at 18:50 after 50 min idle: a trim would save ~0 of 41k tokens, under the 10% minimum'])
    expect(seen.status).toEqual([])
  })

  test('writes the summary when there is nothing to trim and the conversation is over the target', async ($, on) => {
    const { clock, seen } = setup($, on)
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.compacts.length).toBe(1)
    expect(seen.logs).toEqual(['summarized at 18:50 after 50 min idle: 200k → 12k summary'])
  })
})

describe('the minSavedShare option', () => {
  // A trim of READ saves about 14k of a 300k conversation: 4.7%.
  const run = async ($: Engine, on: On) => {
    const { clock, seen } = setup($, on, { tokens: 320_000, transcript: READ })
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.logs.length).toBe(1)
    return seen.logs[0]!
  }

  test('sets the minimum saving', { options: { microTargetTokens: 1_000_000, minSavedShare: 0.04 } }, async ($, on) => {
    expect(await run($, on)).toStartWith('trimmed at 18:50 after 50 min idle: 300k → ~286k tokens')
  })

  test('0 trims whatever the saving', { options: { microTargetTokens: 1_000_000, minSavedShare: 0 } }, async ($, on) => {
    expect(await run($, on)).toStartWith('trimmed at 18:50')
  })

  test('an empty value is the 10% default', { options: { microTargetTokens: 1_000_000, minSavedShare: '' } }, async ($, on) => {
    expect(await run($, on)).toEndWith('under the 10% minimum')
  })

  test('a value over 1, under 0 or not a number is the 10% default', () => {
    for (const minSavedShare of [1.5, -0.2, 'lots', true, ['0.5']]) expect(readSettings({ minSavedShare }).minSavedShare).toBe(0.1)
    expect(readSettings({ minSavedShare: 1 }).minSavedShare).toBe(1)
    expect(readSettings({ minSavedShare: '0.25' }).minSavedShare).toBe(0.25)
  })
})

describe('/micro-compact', () => {
  test('is registered for the command menu', async ($, on) => {
    const { seen } = setup($, on)
    await reload($)
    expect(seen.registered).toEqual([{ name: 'micro-compact', description: "Trim old tool results now, or summarize if trimming isn't enough" }])
  })

  test('trims at once and says it ran by the command', async ($, on) => {
    const { clock, seen } = setup($, on, { tokens: 140_000, transcript: READ })
    await microCompact($, clock)
    expect(seen.commands.length).toBe(1)
    expect(seen.commands[0]).toStartWith('This idle compaction ran on request at 18:00, by /micro-compact. ')
    expect(seen.compacts).toEqual([])
    expect(seen.logs).toEqual([
      'trimmed at 18:00 by /micro-compact: 120k → ~106k tokens (1 old tool result removed, 0 shortened, 0 thinking blocks dropped)',
    ])
    expect(seen.status).toEqual(['trimmed at 18:00: 120k → ~106k tokens'])
  })

  test('ignores the minTokens floor', async ($, on) => {
    const { clock, seen } = setup($, on, { tokens: 50_000, messages: 30_000, transcript: READ })
    await microCompact($, clock)
    expect(seen.logs).toEqual([
      'trimmed at 18:00 by /micro-compact: 30k → ~16k tokens (1 old tool result removed, 0 shortened, 0 thinking blocks dropped)',
    ])
  })

  test('leaves the conversation alone when a trim would save under 10% of it', { options: { microTargetTokens: 1_000_000 } }, async ($, on) => {
    const { clock, seen } = setup($, on, { tokens: 320_000, transcript: READ })
    await microCompact($, clock)
    expect(seen.isCompacted).toBe(false)
    expect(seen.logs).toEqual(['not trimmed at 18:00 by /micro-compact: a trim would save ~14k of 300k tokens, under the 10% minimum'])
    expect(seen.status).toEqual([])
  })

  test('writes the summary when the trim would land over the target', async ($, on) => {
    const { clock, seen } = setup($, on)
    await microCompact($, clock)
    expect(seen.compacts.length).toBe(1)
    expect(seen.compacts[0]).toStartWith('This idle compaction ran on request at 18:00, by /micro-compact. Open the summary by saying so.')
    expect(seen.logs).toEqual(['summarized at 18:00 by /micro-compact: 200k → 12k summary'])
    expect(seen.debug).toEqual(['summary chosen: trim estimate 180k, target 150k'])
    expect(seen.status).toEqual(['summarized at 18:00: 200k → 12k summary'])
  })

  test('an unknown size, as after a compaction, says so and runs nothing', async ($, on) => {
    const { clock, seen } = setup($, on, { tokens: null })
    await microCompact($, clock)
    expect(seen.commands).toEqual([])
    expect(seen.logs).toEqual(["not compacted: the conversation's size is unknown until the next response, as after a compaction"])
  })

  test('takes the place of the pending idle timer until the next turn', { options: { microTargetTokens: 1_000_000 } }, async ($, on) => {
    const { clock, seen } = setup($, on, { tokens: 320_000, transcript: READ })
    await turnDone($)
    await clock.advance(10 * MIN)
    await microCompact($, clock)
    expect(seen.stored).toBe(null)
    await reload($)
    await clock.advance(2 * 60 * MIN)
    await clock.settle()
    expect(seen.commands.length).toBe(1)
    await turnStart($)
    await turnDone($)
    await clock.advance(50 * MIN + 1)
    await clock.settle()
    expect(seen.commands.length).toBe(2)
    expect(seen.logs[1]).toStartWith('not trimmed at 21:00 after 50 min idle: ')
  })
})
