import type { ApiMessage, ContextCategory, On, SessionCompactInput, SessionCompactResult, SessionMessage } from 'claude-code'
import { type Engine, describe, expect, test, tier } from 'claude-code/testing'
import { chooseBranch, droppedThinkingTokensIn, estimateAfter, thinkingTokensIn } from '../hooks/decide.ts'
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

/** The API view of a conversation with one thinking block of a 4000-character signature. */
const SIGNED_THINKING: ApiMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'read a.ts' }] },
  { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's'.repeat(4000) }, { type: 'text', text: 'ok' }] },
]
// 0.2745 × 4000 − 274
const SIGNED_THINKING_TOKENS = 824

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
    expect(result.tokensAfter).toBe(estimateAfter({ conversationTokens: 100_000, original: transcript, compacted: expected, droppedThinkingTokens: 0, maskedMedia: 0 }))
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
    const withThinking = estimateAfter({ conversationTokens: 100_000, original: transcript, compacted: expected, droppedThinkingTokens: SIGNED_THINKING_TOKENS, maskedMedia: 0 })
    const withoutThinking = estimateAfter({ conversationTokens: 100_000, original: transcript, compacted: expected, droppedThinkingTokens: 0, maskedMedia: 0 })
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
    expect(result.tokensAfter).toBe(estimateAfter({ conversationTokens: 100_000, original: transcript, compacted: expected, droppedThinkingTokens: 0, maskedMedia: 0 }))
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

  const none = { droppedThinkingTokens: 0, maskedMedia: 0 }

  test('takes removed tool-result text off at 0.44 tokens a character, whatever the size', () => {
    // 800 removed are 352 tokens
    expect(estimateAfter({ conversationTokens: 1000, original: text(1000), compacted: text(200), ...none })).toBe(648)
    expect(estimateAfter({ conversationTokens: 100_000, original: text(1000), compacted: text(200), ...none })).toBe(99_648)
  })

  test('takes the dropped thinking off as counted', () => {
    expect(estimateAfter({ conversationTokens: 10_000, original: text(100), compacted: text(100), ...none, droppedThinkingTokens: 824 })).toBe(9_176)
  })

  test('takes 1000 tokens off for each masked image or PDF', () => {
    expect(estimateAfter({ conversationTokens: 10_000, original: [], compacted: [], ...none, maskedMedia: 3 })).toBe(7_000)
  })

  test('adds the three together', () => {
    // 352 + 824 + 1000
    expect(estimateAfter({ conversationTokens: 10_000, original: text(1000), compacted: text(200), droppedThinkingTokens: 824, maskedMedia: 1 })).toBe(7_824)
  })

  test('with nothing removed the size stays', () => {
    expect(estimateAfter({ conversationTokens: 5_000, original: text(1000), compacted: text(1000), ...none })).toBe(5_000)
    expect(estimateAfter({ conversationTokens: 5_000, original: [], compacted: [], ...none })).toBe(5_000)
  })

  test('never goes below 0', () => {
    expect(estimateAfter({ conversationTokens: 100, original: text(1000), compacted: [], ...none, maskedMedia: 1 })).toBe(0)
  })

  test("counts a Read's text once, though both its tool use and its result carry it", () => {
    const body = 'y'.repeat(900)
    const original: SessionMessage[] = [
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r', tool: 'Read', input: {}, text: body }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r', text: body, isError: false }] },
    ]
    const trimmed: SessionMessage[] = [original[0]!, { ...original[1]!, toolResults: [{ tool_use_id: 'r', text: '', isError: false }] }]
    // 900 removed are 396 tokens; counted twice they would be 792
    expect(estimateAfter({ conversationTokens: 1000, original, compacted: trimmed, ...none })).toBe(604)
  })

  test('masked images and PDFs come off at the media rate; their placeholder text takes nothing off', () => {
    const image = { type: 'image', file: { dimensions: { originalWidth: 256, originalHeight: 256 } } }
    const original: SessionMessage[] = [
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'i', tool: 'Read', input: { file_path: '/w/img.png' } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'i', text: '', isError: false, result: image }] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'p', tool: 'Read', input: { file_path: '/w/doc.pdf' } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'p', text: '', isError: false, result: { type: 'pdf' } }] },
      ...fiveShortCalls,
    ]
    const { messages: trimmed, stats } = maskOldToolResults(original)
    expect(stats.masked).toBe(2)
    expect(stats.mediaMasked).toBe(2)
    expect(estimateAfter({ conversationTokens: 50_000, original, compacted: trimmed, ...none, maskedMedia: stats.mediaMasked })).toBe(48_000)
  })

  test('a message kept whole for the rows it carries takes nothing off', () => {
    const image = { type: 'image', file: { dimensions: { originalWidth: 256, originalHeight: 256 } } }
    const original: SessionMessage[] = [
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'i', tool: 'Read', input: { file_path: '/w/img.png' } }], handle: 'a1' },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'i', text: '', isError: false, result: image }], handle: 'u1' },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r', tool: 'Read', input: { file_path: '/w/a.ts' } }], handle: 'a2' },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r', text: numbered(1, 300), isError: false }], handle: 'u2' },
      ...fiveShortCalls,
    ]
    const { messages: trimmed, stats } = maskOldToolResults(original, new Set(['u1', 'u2']))
    expect(stats).toEqual({ masked: 0, mediaMasked: 0, trimmedToHeadAndTail: 0, errorsCutToStart: 0, thinkingDropped: 0, keptForRows: 2 })
    expect(estimateAfter({ conversationTokens: 50_000, original, compacted: trimmed, ...none, maskedMedia: stats.mediaMasked })).toBe(50_000)
  })
})

describe('the thinking size', () => {
  test('is estimated from the signature: 0.2745 tokens a character, less 274 a block', () => {
    expect(thinkingTokensIn(SIGNED_THINKING)).toBe(SIGNED_THINKING_TOKENS)
  })

  test('is 0 for a block whose signature is too short to outweigh the fixed part', () => {
    const short = (n: number): ApiMessage[] => [{ role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's'.repeat(n) }] }]
    expect(thinkingTokensIn(short(500))).toBe(0)
    expect(thinkingTokensIn(short(998))).toBe(0)
    // Clamped per block: the short block does not cancel part of the long one
    expect(thinkingTokensIn([...short(500), ...SIGNED_THINKING])).toBe(SIGNED_THINKING_TOKENS)
  })

  test('counts a redacted block by its data at the signature rate', () => {
    const messages: ApiMessage[] = [
      { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'd'.repeat(2000) }, { type: 'text', text: 'not thinking' }] },
    ]
    // 0.2745 × 2000 − 274
    expect(thinkingTokensIn(messages)).toBe(275)
  })

  test('is 0 with no thinking blocks', () => {
    expect(thinkingTokensIn([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])).toBe(0)
  })
})

describe('the branch', () => {
  const none = { masked: 0, mediaMasked: 0, trimmedToHeadAndTail: 0, errorsCutToStart: 0, thinkingDropped: 0, keptForRows: 0 }
  const stats = { ...none, masked: 3, thinkingDropped: 1, keptForRows: 0 }

  test('at the target is micro, over it the summary', () => {
    expect(chooseBranch(150_000, 150_000, stats)).toEqual({ kind: 'micro' })
    expect(chooseBranch(150_001, 150_000, stats)).toEqual({ kind: 'summary', reason: 'over-target' })
  })

  test('any one change is enough: thinking, a trim or a cut error alone', () => {
    expect(chooseBranch(10, 150_000, { ...none, thinkingDropped: 2, keptForRows: 0 })).toEqual({ kind: 'micro' })
    expect(chooseBranch(10, 150_000, { ...none, trimmedToHeadAndTail: 1 })).toEqual({ kind: 'micro' })
    expect(chooseBranch(10, 150_000, { ...none, errorsCutToStart: 1 })).toEqual({ kind: 'micro' })
  })

  test('nothing removed is the summary, however small', () => {
    expect(chooseBranch(10, 150_000, none)).toEqual({ kind: 'summary', reason: 'nothing-to-mask' })
  })
})

describe('the line', () => {
  const when = { at: '18:50', idleMin: 50 }

  const none = { masked: 0, mediaMasked: 0, trimmedToHeadAndTail: 0, errorsCutToStart: 0, thinkingDropped: 0, keptForRows: 0 }

  test('micro: sizes and what was taken out', () => {
    const outcome = { branch: { kind: 'micro' } as const, conversationTokens: 175_000, estimate: 73_400, stats: { masked: 21, mediaMasked: 0, trimmedToHeadAndTail: 8, errorsCutToStart: 0, thinkingDropped: 66, keptForRows: 0 } }
    expect(microLine({ when: { at: '23:00', idleMin: 50 }, outcome })).toEqual({
      status: 'trimmed at 23:00: 175k → ~73k tokens',
      log: 'trimmed at 23:00 after 50 min idle: 175k → ~73k tokens (21 old tool results removed, 8 shortened, 66 thinking blocks dropped)',
    })
  })

  test('micro: cut errors are named only when there are some', () => {
    const base = { branch: { kind: 'micro' } as const, conversationTokens: 80_000, estimate: 30_000 }
    const stats = { masked: 3, mediaMasked: 0, trimmedToHeadAndTail: 4, errorsCutToStart: 2, thinkingDropped: 5, keptForRows: 0 }
    expect(microLine({ when, outcome: { ...base, stats } }).log).toBe(
      'trimmed at 18:50 after 50 min idle: 80k → ~30k tokens (3 old tool results removed, 4 shortened, 2 errors cut to their start, 5 thinking blocks dropped)',
    )
    expect(microLine({ when, outcome: { ...base, stats: { ...stats, errorsCutToStart: 1 } } }).log).toContain('4 shortened, 1 error cut to its start, 5 thinking')
    expect(microLine({ when, outcome: { ...base, stats: { ...stats, errorsCutToStart: 0 } } }).log).not.toContain('error')
  })

  test('micro: singular counts', () => {
    const outcome = { branch: { kind: 'micro' } as const, conversationTokens: 80_000, estimate: 30_000, stats: { masked: 1, mediaMasked: 0, trimmedToHeadAndTail: 1, errorsCutToStart: 0, thinkingDropped: 1, keptForRows: 0 } }
    expect(microLine({ when, outcome }).log).toBe(
      'trimmed at 18:50 after 50 min idle: 80k → ~30k tokens (1 old tool result removed, 1 shortened, 1 thinking block dropped)',
    )
  })

  test('micro: messages kept whole go to the debug line alone, and only when there are some', () => {
    const base = { branch: { kind: 'micro' } as const, conversationTokens: 80_000, estimate: 30_000 }
    const stats = { ...none, masked: 1 }
    expect(microLine({ when, outcome: { ...base, stats } }).debug).toBeUndefined()
    const one = microLine({ when, outcome: { ...base, stats: { ...stats, keptForRows: 1 } } })
    expect(one.debug).toBe('trim kept 1 message whole for the report or queued message it carries')
    expect(one.log).toBe(microLine({ when, outcome: { ...base, stats } }).log)
    expect(one.status).toBe(microLine({ when, outcome: { ...base, stats } }).status)
    expect(microLine({ when, outcome: { ...base, stats: { ...stats, keptForRows: 2 } } }).debug).toBe(
      'trim kept 2 messages whole for the reports or queued messages they carry',
    )
  })

  test('micro: small figures are shown as they are', () => {
    const outcome = { branch: { kind: 'micro' } as const, conversationTokens: 120_000, estimate: 900, stats: { ...none, masked: 1 } }
    expect(microLine({ when, outcome }).status).toBe('trimmed at 18:50: 120k → ~900 tokens')
  })

  const usage = { input_tokens: 1_500, output_tokens: 800, cache_read_input_tokens: 198_000, cache_creation_input_tokens: 500 }
  const overTarget = { branch: { kind: 'summary', reason: 'over-target' } as const, conversationTokens: 280_000, estimate: 200_000, stats: { ...none, masked: 2 } }
  const at1841 = { at: '18:41', idleMin: 50 }

  test('summary over the target: sizes in the log, reason and cache share in the debug line', () => {
    const result = { messages: [SUMMARY], tokensBefore: 285_000, tokensAfter: 19_000, usage }
    expect(summaryLine({ when: at1841, outcome: overTarget, result, contextTokens: 285_000, targetTokens: 150_000 })).toEqual({
      status: 'summarized at 18:41: 285k → 19k summary',
      log: 'summarized at 18:41 after 50 min idle: 285k → 19k summary',
      debug: 'summary chosen: trim estimate 200k, target 150k; summary request 99% cached',
    })
  })

  test('summary over the target without usage leaves out the cache share', () => {
    const result = { messages: [SUMMARY], tokensBefore: 285_000, tokensAfter: 19_000 }
    expect(summaryLine({ when: at1841, outcome: overTarget, result, contextTokens: 285_000, targetTokens: 150_000 }).debug).toBe(
      'summary chosen: trim estimate 200k, target 150k',
    )
  })

  test('summary with nothing to mask says there is nothing to trim', () => {
    const outcome = { branch: { kind: 'summary', reason: 'nothing-to-mask' } as const, conversationTokens: 60_000, estimate: 60_000, stats: none }
    const result = { messages: [SUMMARY], tokensAfter: 5_000, usage }
    const withUsage = summaryLine({ when, outcome, result, contextTokens: 80_000, targetTokens: 150_000 })
    expect(withUsage.log).toBe('summarized at 18:50 after 50 min idle: 80k → 5k summary')
    expect(withUsage.debug).toBe('summary chosen: nothing to trim; summary request 99% cached')
    expect(summaryLine({ when, outcome, result: { messages: [SUMMARY], tokensAfter: 5_000 }, contextTokens: 80_000, targetTokens: 150_000 }).debug).toBe(
      'summary chosen: nothing to trim',
    )
  })

  test('summary with no outcome gives no reason, and no debug line without usage either', () => {
    const result = { messages: [SUMMARY], tokensBefore: 285_000, tokensAfter: 19_000, usage }
    const withUsage = summaryLine({ when: at1841, outcome: undefined, result, contextTokens: 285_000, targetTokens: 150_000 })
    expect(withUsage.log).toBe('summarized at 18:41 after 50 min idle: 285k → 19k summary')
    expect(withUsage.debug).toBe('summary chosen: summary request 99% cached')
    const bare = summaryLine({ when: at1841, outcome: undefined, result: { messages: [SUMMARY], tokensBefore: 285_000, tokensAfter: 19_000 }, contextTokens: 1, targetTokens: 150_000 })
    expect(bare).toEqual({ status: 'summarized at 18:41: 285k → 19k summary', log: 'summarized at 18:41 after 50 min idle: 285k → 19k summary' })
    expect('debug' in bare).toBe(false)
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

describe('the dropped thinking', () => {
  // 0.2745 × n − 274 tokens a block: 10706, 824 and 2471
  const block = (n: number): ApiMessage => ({ role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's'.repeat(n) }] })
  const api = [block(40_000), block(4_000), block(10_000)]

  test('is all the thinking when no thinking-only message is kept', () => {
    expect(droppedThinkingTokensIn(api, [false, false, false])).toBe(thinkingTokensIn(api))
  })

  test("leaves out a kept message's block, lined up by order", () => {
    expect(droppedThinkingTokensIn(api, [false, true, false])).toBe(10_706 + 2_471)
    expect(droppedThinkingTokensIn(api, [true, false, false])).toBe(824 + 2_471)
  })

  test('when the blocks do not line up, leaves out the largest ones, one per kept message', () => {
    expect(droppedThinkingTokensIn(api, [false, true])).toBe(824 + 2_471)
    expect(droppedThinkingTokensIn(api, [true, true, false, false])).toBe(824)
  })
})
