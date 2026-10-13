import type { ApiMessage, ContextCategory, On, SessionCompactInput, SessionCompactResult, SessionMessage } from 'claude-code'
import { type Engine, describe, expect, test, tier } from 'claude-code/testing'
import { chooseBranch, estimateAfter, thinkingCharsIn } from '../hooks/decide.ts'
import { maskOldToolResults } from '../hooks/mask.ts'
import { microLine, summaryLine } from '../hooks/lines.ts'

tier('user')

const SUMMARY: SessionMessage = { role: 'user', text: 'summary', toolUses: [] }
// What the timer's call carries; the hook knows it by its opening.
const IDLE = 'This idle compaction ran automatically at 18:50, after 50 minutes idle, before the prompt cache expired.'

const numbered = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${String(from + i).padStart(6)}\tline ${from + i}`).join('\n')

/** Five short calls since, so the Read is outside the recent window. */
const fiveShortCalls: SessionMessage[] = [1, 2, 3, 4, 5].flatMap((i): SessionMessage[] => [
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: `b${i}`, tool: 'Bash', input: { command: `echo ${i}` } }], handle: `ba${i}` },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `b${i}`, text: `${i}`, isError: false }], handle: `bu${i}` },
])

/** A short exchange around one long, old Read and one thinking block. */
const transcript: SessionMessage[] = [
  { role: 'user', text: 'read a.ts', toolUses: [], handle: 'u0' },
  { role: 'assistant', text: '', toolUses: [], handle: 'think' },
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: '/src/a.ts' } }], handle: 'a1' },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: numbered(1, 2000), isError: false }], handle: 'u1' },
  ...fiveShortCalls,
  { role: 'assistant', text: 'a.ts defines the parser.', toolUses: [], handle: 'a2' },
]

/** The API view of a conversation with one thinking block of a 1000-character signature. */
const SIGNED_THINKING: ApiMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'read a.ts' }] },
  { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's'.repeat(1000) }, { type: 'text', text: 'ok' }] },
]
// 1.218 × 1000 + 81.6, rounded
const SIGNED_THINKING_CHARS = 1300

const noReads: SessionMessage[] = [
  { role: 'user', text: 'hello', toolUses: [], handle: 'u0' },
  { role: 'assistant', text: 'hi', toolUses: [], handle: 'a0' },
]

const messagesRow = (tokens: number): ContextCategory => ({ name: 'Messages', tokens, kind: 'used', color: 'inactive', isDeferred: false })

/** Stands for core beneath the mod: the Messages row, and a summary when asked for one. */
function setup(on: On, conversation = 100_000) {
  const summaries: (string | undefined)[] = []
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      rateLimits: [],
      context: {
        tokens: conversation + 20_000,
        window: 1_000_000,
        breakdown: {
          categories: [messagesRow(conversation)],
          totalTokens: conversation + 20_000, maxTokens: 1_000_000, rawMaxTokens: 1_000_000, autocompactSource: 'model-default', percentage: 12,
          gridRows: [], model: 'test', memoryFiles: [], mcpTools: [], agents: [], isAutoCompactEnabled: true, apiUsage: null,
        },
      },
    },
  }))
  on('session.compact', (_$, e) => {
    summaries.push(e.instructions)
    return { messages: [SUMMARY], tokensBefore: conversation + 20_000, tokensAfter: 12_000 }
  })
  return { summaries }
}

/** Raises the event as the built-in /compact raises it for the timer's `$.command.run`, transcript and all. */
const compact = ($: Engine, input: Partial<SessionCompactInput>) =>
  ($ as any).session.compact({ trigger: 'manual', instructions: IDLE, messages: transcript, ...input }) as Promise<SessionCompactResult>

describe('the session.compact hook', () => {
  test('masks old tool results with no model call when the estimate is under the target', async ($, on) => {
    const { summaries } = setup(on)
    const result = await compact($, {})
    if (result.skip !== undefined) throw new Error(result.skip)
    const expected = maskOldToolResults(transcript).messages
    expect(summaries).toEqual([])
    expect(result.messages).toEqual(expected)
    expect(result.tokensBefore).toBe(100_000)
    // No session.messages answer beneath: the thinking counts as nothing
    expect(result.tokensAfter).toBe(estimateAfter({ conversationTokens: 100_000, original: transcript, compacted: expected, droppedThinkingChars: 0 }))
    expect(result.messages?.find((m) => m.toolResults)?.toolResults?.[0]?.text).toBe(
      '[file contents elided by compaction: /src/a.ts, 2000 lines. Read it again if needed.]',
    )
  })

  test("counts the dropped thinking from the conversation's API view", async ($, on) => {
    setup(on)
    on('session.messages', () => ({ value: SIGNED_THINKING }))
    const result = await compact($, {})
    if (result.skip !== undefined) throw new Error(result.skip)
    const expected = maskOldToolResults(transcript).messages
    const withThinking = estimateAfter({ conversationTokens: 100_000, original: transcript, compacted: expected, droppedThinkingChars: SIGNED_THINKING_CHARS })
    const withoutThinking = estimateAfter({ conversationTokens: 100_000, original: transcript, compacted: expected, droppedThinkingChars: 0 })
    expect(result.tokensAfter).toBe(withThinking)
    expect(withThinking).not.toBe(withoutThinking)
  })

  test('counts the thinking as nothing when the API view throws', async ($, on) => {
    setup(on)
    on('session.messages', () => {
      throw new Error('unavailable')
    })
    const result = await compact($, {})
    if (result.skip !== undefined) throw new Error(result.skip)
    const expected = maskOldToolResults(transcript).messages
    expect(result.messages).toEqual(expected)
    expect(result.tokensAfter).toBe(estimateAfter({ conversationTokens: 100_000, original: transcript, compacted: expected, droppedThinkingChars: 0 }))
  })

  test('asks for the summary when the estimate is over the target', { options: { microTargetTokens: 100 } }, async ($, on) => {
    const { summaries } = setup(on)
    const result = await compact($, {})
    expect(summaries).toEqual([IDLE])
    expect(result.messages).toEqual([SUMMARY])
  })

  test('asks for the summary when there is nothing to mask', async ($, on) => {
    const { summaries } = setup(on)
    const result = await compact($, { messages: noReads })
    expect(summaries).toEqual([IDLE])
    expect(result.messages).toEqual([SUMMARY])
  })

  test("leaves the person's own /compact alone", async ($, on) => {
    const { summaries } = setup(on)
    await compact($, { instructions: 'the plan' })
    expect(summaries).toEqual(['the plan'])
  })

  test("leaves another plugin's $.session.compact alone, whatever it says", async ($, on) => {
    const { summaries } = setup(on)
    await compact($, { trigger: 'plugin' })
    expect(summaries).toEqual([IDLE])
  })

  test("leaves a subagent's compaction alone", async ($, on) => {
    const { summaries } = setup(on)
    await compact($, { agentId: 'a1' })
    expect(summaries).toEqual([IDLE])
  })
})

describe('the estimate', () => {
  const text = (n: number): SessionMessage[] => [{ role: 'user', text: 'x'.repeat(n), toolUses: [] }]

  test("takes the removed share of the visible characters off, at the conversation's own rate", () => {
    // 1000 characters in 400 tokens: 2.5 a token, so 800 removed are 320 tokens
    expect(estimateAfter({ conversationTokens: 400, original: text(1000), compacted: text(200), droppedThinkingChars: 0 })).toBe(80)
  })

  test('the same removed characters take off more tokens in a denser conversation', () => {
    const sparse = estimateAfter({ conversationTokens: 250, original: text(1000), compacted: text(200), droppedThinkingChars: 0 })
    const dense = estimateAfter({ conversationTokens: 500, original: text(1000), compacted: text(200), droppedThinkingChars: 0 })
    // 4 and 2 characters a token: 200 and 400 tokens off
    expect(250 - sparse).toBe(200)
    expect(500 - dense).toBe(400)
  })

  test('content the list cannot see stays in the figure', () => {
    // 1000 visible characters, the rest of the 1000 tokens hidden: removing all visible text leaves
    // the tokens it does not account for
    expect(estimateAfter({ conversationTokens: 1000, original: text(1000), compacted: [], droppedThinkingChars: 0 })).toBe(0)
    expect(estimateAfter({ conversationTokens: 1000, original: text(1000), compacted: text(500), droppedThinkingChars: 0 })).toBe(500)
  })

  test('the dropped thinking counts toward the rate and comes off with the text', () => {
    // 600 text + 400 thinking characters in 500 tokens: 2 a token; 200 text and all thinking removed
    expect(estimateAfter({ conversationTokens: 500, original: text(600), compacted: text(400), droppedThinkingChars: 400 })).toBe(200)
  })

  test("counts a Read's text once, though both its tool use and its result carry it", () => {
    const body = 'y'.repeat(900)
    const original: SessionMessage[] = [
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r', tool: 'Read', input: {}, text: body }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r', text: body, isError: false }] },
    ]
    const trimmed: SessionMessage[] = [original[0]!, { ...original[1]!, toolResults: [{ tool_use_id: 'r', text: '', isError: false }] }]
    // 902 visible characters (900 and the `{}` input) in 451 tokens: 2 a token, 900 removed are 450.
    // Counted twice, the rate would be 4 and the result 226
    expect(estimateAfter({ conversationTokens: 451, original, compacted: trimmed, droppedThinkingChars: 0 })).toBe(1)
  })

  test('a masked image, empty text swapped for a placeholder, keeps the measured size', () => {
    const original: SessionMessage[] = [
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'i', tool: 'Read', input: { file_path: '/w/img.png' } }] },
      {
        role: 'user', text: '', toolUses: [],
        toolResults: [{ tool_use_id: 'i', text: '', isError: false, result: { type: 'image', file: { dimensions: { originalWidth: 256, originalHeight: 256 } } } }],
      },
      ...fiveShortCalls,
    ]
    const { messages: trimmed, stats } = maskOldToolResults(original)
    expect(stats.masked).toBe(1)
    expect(estimateAfter({ conversationTokens: 50_000, original, compacted: trimmed, droppedThinkingChars: 0 })).toBe(50_000)
  })

  test('with no visible characters or no tokens there is nothing to scale, and the size stays', () => {
    expect(estimateAfter({ conversationTokens: 5_000, original: [], compacted: [], droppedThinkingChars: 0 })).toBe(5_000)
    expect(estimateAfter({ conversationTokens: 0, original: text(1000), compacted: [], droppedThinkingChars: 0 })).toBe(0)
  })
})

describe('the thinking size', () => {
  test('is estimated from the signature when a block holds no text', () => {
    expect(thinkingCharsIn(SIGNED_THINKING)).toBe(SIGNED_THINKING_CHARS)
  })

  test('is the text length when a block holds its text, and a redacted block counts by its data', () => {
    const messages: ApiMessage[] = [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x'.repeat(500), signature: 's'.repeat(1000) }] },
      { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'd'.repeat(100) }, { type: 'text', text: 'not thinking' }] },
    ]
    // 500 + round(1.218 × 100 + 81.6)
    expect(thinkingCharsIn(messages)).toBe(500 + 203)
  })

  test('is 0 with no thinking blocks', () => {
    expect(thinkingCharsIn([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])).toBe(0)
  })
})

describe('the branch', () => {
  const none = { masked: 0, trimmedToHeadAndTail: 0, errorsCutToStart: 0, thinkingDropped: 0 }
  const stats = { ...none, masked: 3, thinkingDropped: 1 }

  test('at the target is micro, over it the summary', () => {
    expect(chooseBranch(150_000, 150_000, stats)).toEqual({ kind: 'micro' })
    expect(chooseBranch(150_001, 150_000, stats)).toEqual({ kind: 'summary', reason: 'over-target' })
  })

  test('any one change is enough: thinking, a trim or a cut error alone', () => {
    expect(chooseBranch(10, 150_000, { ...none, thinkingDropped: 2 })).toEqual({ kind: 'micro' })
    expect(chooseBranch(10, 150_000, { ...none, trimmedToHeadAndTail: 1 })).toEqual({ kind: 'micro' })
    expect(chooseBranch(10, 150_000, { ...none, errorsCutToStart: 1 })).toEqual({ kind: 'micro' })
  })

  test('nothing removed is the summary, however small', () => {
    expect(chooseBranch(10, 150_000, none)).toEqual({ kind: 'summary', reason: 'nothing-to-mask' })
  })
})

describe('the line', () => {
  const when = { at: '18:50', idleMin: 50 }

  const none = { masked: 0, trimmedToHeadAndTail: 0, errorsCutToStart: 0, thinkingDropped: 0 }

  test('micro: sizes and what was taken out', () => {
    const outcome = { branch: { kind: 'micro' } as const, conversationTokens: 175_000, estimate: 73_400, stats: { masked: 21, trimmedToHeadAndTail: 8, errorsCutToStart: 0, thinkingDropped: 66 } }
    expect(microLine({ when: { at: '23:00', idleMin: 50 }, outcome })).toEqual({
      status: 'trimmed at 23:00: 175k → about 73k tokens',
      log: 'trimmed at 23:00 after 50 min idle: 175k → about 73k tokens (21 old tool results removed, 8 shortened, 66 thinking blocks dropped)',
    })
  })

  test('micro: cut errors are named only when there are some', () => {
    const base = { branch: { kind: 'micro' } as const, conversationTokens: 80_000, estimate: 30_000 }
    const stats = { masked: 3, trimmedToHeadAndTail: 4, errorsCutToStart: 2, thinkingDropped: 5 }
    expect(microLine({ when, outcome: { ...base, stats } }).log).toBe(
      'trimmed at 18:50 after 50 min idle: 80k → about 30k tokens (3 old tool results removed, 4 shortened, 2 errors cut to their start, 5 thinking blocks dropped)',
    )
    expect(microLine({ when, outcome: { ...base, stats: { ...stats, errorsCutToStart: 1 } } }).log).toContain('4 shortened, 1 error cut to its start, 5 thinking')
    expect(microLine({ when, outcome: { ...base, stats: { ...stats, errorsCutToStart: 0 } } }).log).not.toContain('error')
  })

  test('micro: singular counts', () => {
    const outcome = { branch: { kind: 'micro' } as const, conversationTokens: 80_000, estimate: 30_000, stats: { masked: 1, trimmedToHeadAndTail: 1, errorsCutToStart: 0, thinkingDropped: 1 } }
    expect(microLine({ when, outcome }).log).toBe(
      'trimmed at 18:50 after 50 min idle: 80k → about 30k tokens (1 old tool result removed, 1 shortened, 1 thinking block dropped)',
    )
  })

  test('micro: small figures are shown as they are', () => {
    const outcome = { branch: { kind: 'micro' } as const, conversationTokens: 120_000, estimate: 900, stats: { ...none, masked: 1 } }
    expect(microLine({ when, outcome }).status).toBe('trimmed at 18:50: 120k → about 900 tokens')
  })

  const usage = { input_tokens: 1_500, output_tokens: 800, cache_read_input_tokens: 198_000, cache_creation_input_tokens: 500 }
  const overTarget = { branch: { kind: 'summary', reason: 'over-target' } as const, conversationTokens: 280_000, estimate: 200_000, stats: { ...none, masked: 2 } }
  const at1841 = { at: '18:41', idleMin: 50 }

  test('summary over the target says what trimming would have left, and the cache share', () => {
    const result = { messages: [SUMMARY], tokensBefore: 285_000, tokensAfter: 19_000, usage }
    expect(summaryLine({ when: at1841, outcome: overTarget, result, contextTokens: 285_000, targetTokens: 150_000 })).toEqual({
      status: 'summarized at 18:41: 285k → 19k summary',
      log: 'summarized at 18:41 after 50 min idle: 285k → 19k summary (trimming would leave about 200k, over the 150k target; 99% read from cache)',
    })
  })

  test('summary over the target without usage leaves out the cache share', () => {
    const result = { messages: [SUMMARY], tokensBefore: 285_000, tokensAfter: 19_000 }
    expect(summaryLine({ when: at1841, outcome: overTarget, result, contextTokens: 285_000, targetTokens: 150_000 }).log).toBe(
      'summarized at 18:41 after 50 min idle: 285k → 19k summary (trimming would leave about 200k, over the 150k target)',
    )
  })

  test('summary with nothing to mask says there is nothing to trim', () => {
    const outcome = { branch: { kind: 'summary', reason: 'nothing-to-mask' } as const, conversationTokens: 60_000, estimate: 60_000, stats: none }
    const result = { messages: [SUMMARY], tokensAfter: 5_000, usage }
    expect(summaryLine({ when, outcome, result, contextTokens: 80_000, targetTokens: 150_000 }).log).toBe(
      'summarized at 18:50 after 50 min idle: 80k → 5k summary (nothing to trim; 99% read from cache)',
    )
    expect(summaryLine({ when, outcome, result: { messages: [SUMMARY], tokensAfter: 5_000 }, contextTokens: 80_000, targetTokens: 150_000 }).log).toBe(
      'summarized at 18:50 after 50 min idle: 80k → 5k summary (nothing to trim)',
    )
  })

  test('summary with no outcome gives no reason', () => {
    const result = { messages: [SUMMARY], tokensBefore: 285_000, tokensAfter: 19_000, usage }
    expect(summaryLine({ when: at1841, outcome: undefined, result, contextTokens: 285_000, targetTokens: 150_000 }).log).toBe(
      'summarized at 18:41 after 50 min idle: 285k → 19k summary (99% read from cache)',
    )
    expect(summaryLine({ when: at1841, outcome: undefined, result: { messages: [SUMMARY], tokensBefore: 285_000, tokensAfter: 19_000 }, contextTokens: 1, targetTokens: 150_000 }).log).toBe(
      'summarized at 18:41 after 50 min idle: 285k → 19k summary',
    )
  })

  test('summary without tokensAfter gives only the size before', () => {
    const result = { messages: [SUMMARY], tokensBefore: 285_000 }
    expect(summaryLine({ when: at1841, outcome: undefined, result, contextTokens: 1, targetTokens: 150_000 })).toEqual({
      status: 'summarized at 18:41: 285k tokens',
      log: 'summarized at 18:41 after 50 min idle: 285k tokens',
    })
  })

  test('summary falls back to the context size when core gives no tokensBefore', () => {
    const result = { messages: [SUMMARY], tokensAfter: 19_000 }
    expect(summaryLine({ when: at1841, outcome: undefined, result, contextTokens: 290_000, targetTokens: 150_000 }).status).toBe('summarized at 18:41: 290k → 19k summary')
  })
})
