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
    const withoutThinking = estimateAfter({ conversationTokens: 100_000, original: transcript, compacted: expected, droppedThinkingChars: 0 })
    expect(result.tokensAfter).toBe(withoutThinking - SIGNED_THINKING_CHARS / 4)
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
  test('takes the removed text off the measured size, at 4 characters a token', () => {
    const original: SessionMessage[] = [{ role: 'user', text: 'x'.repeat(1000), toolUses: [] }]
    const trimmed: SessionMessage[] = [{ role: 'user', text: 'x'.repeat(200), toolUses: [] }]
    expect(estimateAfter({ conversationTokens: 80_000, original, compacted: trimmed, droppedThinkingChars: 0 })).toBe(79_800)
  })

  test('never goes below zero', () => {
    const original: SessionMessage[] = [{ role: 'user', text: 'x'.repeat(1000), toolUses: [] }]
    expect(estimateAfter({ conversationTokens: 100, original, compacted: [], droppedThinkingChars: 0 })).toBe(0)
  })

  test("counts a Read's text once, though both its tool use and its result carry it", () => {
    const body = 'y'.repeat(900)
    const original: SessionMessage[] = [
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r', tool: 'Read', input: {}, text: body }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r', text: body, isError: false }] },
    ]
    const trimmed: SessionMessage[] = [original[0]!, { ...original[1]!, toolResults: [{ tool_use_id: 'r', text: '', isError: false }] }]
    // 900 characters removed, 225 tokens; counted twice it would be 450
    expect(estimateAfter({ conversationTokens: 90_200, original, compacted: trimmed, droppedThinkingChars: 0 })).toBe(89_975)
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

  test('an empty transcript keeps the measured size', () => {
    expect(estimateAfter({ conversationTokens: 5_000, original: [], compacted: [], droppedThinkingChars: 0 })).toBe(5_000)
  })

  test('takes the dropped thinking off too, at 4 characters a token', () => {
    expect(estimateAfter({ conversationTokens: 5_000, original: [], compacted: [], droppedThinkingChars: 4_000 })).toBe(4_000)
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

  test('micro: sizes, what was masked, and no model call', () => {
    const outcome = { branch: { kind: 'micro' } as const, conversationTokens: 180_000, estimate: 61_400, stats: { ...none, masked: 12, trimmedToHeadAndTail: 2, thinkingDropped: 1 } }
    expect(microLine({ when, outcome, measuredAfter: 58_000 })).toBe(
      'micro-compacted at 18:50 after 50 min idle (180k conversation → est. 61k, measured 58k; 12 tool results masked, 2 trimmed to head and tail, 1 thinking block dropped, no model call)',
    )
    expect(microLine({ when, outcome, measuredAfter: undefined })).toContain('est. 61k, measured size unknown;')
  })

  test('micro: cut errors are named only when there are some', () => {
    const outcome = { branch: { kind: 'micro' } as const, conversationTokens: 80_000, estimate: 30_000, stats: { masked: 1, trimmedToHeadAndTail: 0, errorsCutToStart: 2, thinkingDropped: 0 } }
    expect(microLine({ when, outcome, measuredAfter: 29_000 })).toContain(
      '1 tool result masked, 0 trimmed to head and tail, 2 errors cut to their start, 0 thinking blocks dropped, no model call)',
    )
  })

  test('summary over the target says what micro-compaction would have left', () => {
    const outcome = { branch: { kind: 'summary', reason: 'over-target' } as const, conversationTokens: 300_000, estimate: 210_000, stats: { ...none, masked: 2 } }
    expect(summaryLine({ when, outcome, result: { messages: [SUMMARY], tokensBefore: 320_000, tokensAfter: 12_000 }, contextTokens: 320_000, measuredAfter: 14_000, targetTokens: 150_000 })).toBe(
      'compacted at 18:50 after 50 min idle (micro est. 210k, over the 150k target; 320k tokens → 12k summary, measured 14k)',
    )
  })

  test('summary with nothing to mask says so', () => {
    const outcome = { branch: { kind: 'summary', reason: 'nothing-to-mask' } as const, conversationTokens: 60_000, estimate: 60_000, stats: none }
    expect(summaryLine({ when, outcome, result: { messages: [SUMMARY], tokensAfter: 5_000 }, contextTokens: 80_000, measuredAfter: undefined, targetTokens: 150_000 })).toBe(
      'compacted at 18:50 after 50 min idle (nothing to mask; 80k tokens → 5k summary, measured size unknown)',
    )
  })
})
