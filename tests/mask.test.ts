// The Read placeholder, thinking and handle cases are derived from ruihe774/cc-micro-compaction,
// tests/elide.test.ts at commit 7409c6265aa977c01cfd6b070af3c734f56fb467 (Unlicense; see LICENSE).

import { describe, expect, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'
import { maskOldToolResults, pathsIn } from '../hooks/mask.ts'

const numbered = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${String(from + i).padStart(6)}\tline ${from + i}`).join('\n')
const lines = (n: number, label = 'out') => Array.from({ length: n }, (_, i) => `${label} ${i + 1}`).join('\n')

const call = (id: string, tool: string, input: Record<string, unknown>, h: string): SessionMessage => ({
  role: 'assistant',
  text: '',
  toolUses: [{ tool_use_id: id, tool, input }],
  handle: h,
})
const result = (id: string, text: string, h: string, isError = false, record?: unknown): SessionMessage => ({
  role: 'user',
  text: '',
  toolUses: [],
  toolResults: [{ tool_use_id: id, text, isError, ...(record === undefined ? {} : { result: record }) }],
  handle: h,
})
const thinking = (h: string): SessionMessage => ({ role: 'assistant', text: '', toolUses: [], handle: h })

/** Five small calls that fill the recent window, so everything before them is old. */
const recentFive = (): SessionMessage[] =>
  [1, 2, 3, 4, 5].flatMap((i) => [call(`k${i}`, 'Bash', { command: `echo ${i}` }, `ka${i}`), result(`k${i}`, lines(100), `ku${i}`)])

const textOf = (messages: readonly SessionMessage[], handleOfCall: string) => {
  const id = messages.find((m) => m.handle === handleOfCall)?.toolUses[0]?.tool_use_id
  return messages.flatMap((m) => m.toolResults ?? []).find((r) => r.tool_use_id === id)?.text
}

describe('the window', () => {
  test('the last 5 tool uses keep their results whole; older ones are masked', () => {
    const transcript = [call('r0', 'Read', { file_path: '/src/a.ts' }, 'a0'), result('r0', numbered(1, 300), 'u0'), ...recentFive()]
    const { messages, stats } = maskOldToolResults(transcript)
    expect(textOf(messages, 'a0')).toBe('[file contents elided by compaction: /src/a.ts, 300 lines. Read it again if needed.]')
    for (const i of [1, 2, 3, 4, 5]) expect(messages.find((m) => m.handle === `ku${i}`)).toBe(transcript[2 * i + 1])
    expect(stats).toEqual({ masked: 1, mediaMasked: 0, mediaTokens: 0, trimmedToHeadAndTail: 0, errorsCutToStart: 0, thinkingDropped: 0, keptForRows: 0 })
  })

  test('the window counts only masked tools: calls to other tools do not push a result out', () => {
    const transcript = [
      call('r0', 'Read', { file_path: '/src/a.ts' }, 'a0'),
      result('r0', numbered(1, 300), 'u0'),
      ...[1, 2, 3, 4, 5, 6].map((i) => call(`t${i}`, i % 2 ? 'TodoWrite' : 'AskUserQuestion', {}, `t${i}`)),
      call('x1', 'Agent', { prompt: 'go' }, 'x1'),
    ]
    expect(maskOldToolResults(transcript).messages).toEqual(transcript)
  })

  test('results of tools it does not know stay whole', () => {
    const transcript = [call('x0', 'Agent', { prompt: 'go' }, 'a0'), result('x0', lines(300), 'u0'), ...recentFive()]
    expect(maskOldToolResults(transcript).messages).toEqual(transcript)
  })
})

describe('Read placeholders', () => {
  test('name the path and line range', () => {
    const transcript = [
      call('r1', 'Read', { file_path: '/src/a.ts' }, 'a1'),
      result('r1', numbered(1, 300), 'u1'),
      call('r2', 'Read', { file_path: '/src/b.ts', offset: 100, limit: 20 }, 'a2'),
      result('r2', numbered(100, 119), 'u2'),
      ...recentFive(),
    ]
    const { messages } = maskOldToolResults(transcript)
    expect(textOf(messages, 'a1')).toBe('[file contents elided by compaction: /src/a.ts, 300 lines. Read it again if needed.]')
    expect(textOf(messages, 'a2')).toBe('[file contents elided by compaction: /src/b.ts, lines 100-119. Read it again if needed.]')
  })

  test('images and PDFs are masked whatever their text length, and lose their record', () => {
    const transcript = [
      call('i1', 'Read', { file_path: '/w/img.png' }, 'a1'),
      result('i1', '', 'u1', false, { type: 'image', file: { base64: 'AAAA', dimensions: { originalWidth: 256, originalHeight: 256 } } }),
      call('p1', 'Read', { file_path: '/w/doc.pdf', pages: '2' }, 'a2'),
      result('p1', 'PDF pages extracted: 1 page(s)', 'u2', false, { type: 'parts', file: { count: 1 }, firstPage: 2 }),
      ...recentFive(),
    ]
    const { messages, stats } = maskOldToolResults(transcript)
    expect(textOf(messages, 'a1')).toBe('[image elided by compaction: /w/img.png, 256x256. Read it again if needed.]')
    expect(textOf(messages, 'a2')).toBe('[PDF pages elided by compaction: /w/doc.pdf, pages 2. Read it again if needed.]')
    expect(stats.masked).toBe(2)
    expect(stats.mediaMasked).toBe(2)
    expect(messages.slice(0, 4).flatMap((m) => m.toolResults ?? []).every((r) => r.result === undefined)).toBe(true)
  })
})

describe('head and tail', () => {
  test('command output keeps its first 15 and last 15 lines around a marker', () => {
    const transcript = [call('b1', 'Bash', { command: 'cd /w && make test' }, 'a1'), result('b1', lines(100), 'u1'), ...recentFive()]
    const { messages, stats } = maskOldToolResults(transcript)
    const text = textOf(messages, 'a1')!.split('\n')
    expect(text.slice(0, 15)).toEqual(lines(15).split('\n'))
    expect(text[15]).toBe('[... 70 lines elided by compaction; rerun make test if needed]')
    expect(text.slice(16)).toEqual(lines(100).split('\n').slice(85))
    expect(stats.trimmedToHeadAndTail).toBe(1)
  })

  test('output a cut would not shorten becomes a placeholder instead', () => {
    // 34 lines leave too few in the middle to cut
    const transcript = [call('g1', 'Grep', { pattern: 'TODO', path: '/w' }, 'a1'), result('g1', lines(34, 'match line'), 'u1'), ...recentFive()]
    const { messages, stats } = maskOldToolResults(transcript)
    expect(textOf(messages, 'a1')).toBe('[search results elided by compaction: TODO in /w, 34 lines. Rerun it if needed.]')
    expect(stats).toEqual({ masked: 1, mediaMasked: 0, mediaTokens: 0, trimmedToHeadAndTail: 0, errorsCutToStart: 0, thinkingDropped: 0, keptForRows: 0 })
  })

  test('a head cut inside a long line keeps its start and marks the cut', () => {
    const long = 'x'.repeat(3000)
    const output = [long, ...lines(60).split('\n')].join('\n')
    const transcript = [call('b1', 'Bash', { command: 'build' }, 'a1'), result('b1', output, 'u1'), ...recentFive()]
    const text = textOf(maskOldToolResults(transcript).messages, 'a1')!
    expect(text.startsWith(`${'x'.repeat(1500)}\n[... `)).toBe(true)
    expect(text).toContain('chars elided by compaction]')
  })

  test('a tail cut inside a long line keeps its end, where the output says how it went', () => {
    const output = [...lines(60).split('\n'), `${'y'.repeat(3000)} FAILED`].join('\n')
    const transcript = [call('b1', 'Bash', { command: 'build' }, 'a1'), result('b1', output, 'u1'), ...recentFive()]
    const once = maskOldToolResults(transcript).messages
    const text = textOf(once, 'a1')!
    expect(text.endsWith(`${'y'.repeat(1493)} FAILED`)).toBe(true)
    expect(text).toMatch(/\n\[\.\.\. \d+ chars elided by compaction\]\n/)
    expect(maskOldToolResults(once).messages).toEqual(once)
  })

  test('short output stays whole', () => {
    const transcript = [call('b1', 'Bash', { command: 'ls' }, 'a1'), result('b1', 'a\nb\nc', 'u1'), ...recentFive()]
    expect(maskOldToolResults(transcript).messages).toEqual(transcript)
  })
})

describe('what a placeholder names', () => {
  const masked = (tool: string, input: Record<string, unknown>) =>
    textOf(maskOldToolResults([call('c1', tool, input, 'a1'), result('c1', 'z'.repeat(500), 'u1'), ...recentFive()]).messages, 'a1')

  test('a web search names its query', () => {
    expect(masked('WebSearch', { query: 'bun test   timeout' })).toBe('[search results elided by compaction: bun test timeout, 500 chars. Rerun it if needed.]')
  })

  test('an MCP call names its tool and arguments, on one capped line', () => {
    expect(masked('mcp__jira__get_issue', { key: 'ABC-1' })).toBe(
      '[tool result elided by compaction: mcp__jira__get_issue {"key":"ABC-1"}, 500 chars. Rerun it if needed.]',
    )
    const text = masked('mcp__x__y', { body: 'w '.repeat(500) })!
    expect(text).toContain('…, 500 chars')
    expect(text.length).toBeLessThan(300)
  })

  test('a file change names its file and never says to rerun it', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit']) {
      const text = masked(tool, { file_path: '/src/a.ts' })!
      expect(text).toBe('[file change result elided by compaction: /src/a.ts, 500 chars. The change is made; read the file again if needed.]')
      expect(text).not.toContain('Rerun')
    }
  })
})

describe('errors', () => {
  test('keep their first 400 characters', () => {
    const error = 'E'.repeat(1000)
    const transcript = [call('b1', 'Bash', { command: 'make' }, 'a1'), result('b1', error, 'u1', true), ...recentFive()]
    const { messages, stats } = maskOldToolResults(transcript)
    expect(textOf(messages, 'a1')).toBe(`${'E'.repeat(400)}\n[... 600 chars of error output elided by compaction]`)
    expect(stats.errorsCutToStart).toBe(1)
  })

  test('short errors stay whole', () => {
    const transcript = [call('r1', 'Read', { file_path: '/nope' }, 'a1'), result('r1', 'File does not exist. '.repeat(10), 'u1', true), ...recentFive()]
    expect(maskOldToolResults(transcript).messages).toEqual(transcript)
  })
})

describe('path lists', () => {
  test('a placeholder lists the paths the removed text named, once each', () => {
    const output = ['src/a.ts:1: x', 'src/b.ts:2: y', 'src/a.ts:3: z', ...lines(30).split('\n')].join('\n')
    const transcript = [call('g1', 'Grep', { pattern: 'x' }, 'a1'), result('g1', output, 'u1'), ...recentFive()]
    expect(textOf(maskOldToolResults(transcript).messages, 'a1')).toBe(
      '[search results elided by compaction: x, 33 lines. Rerun it if needed. Paths: src/a.ts, src/b.ts]',
    )
  })

  test('a head-and-tail marker lists only the paths of the hidden middle', () => {
    const output = [...lines(15).split('\n'), 'built ./dist/mid.js', ...lines(20, 'compiling one more module').split('\n'), 'see ./README.md'].join('\n')
    const transcript = [call('b1', 'Bash', { command: 'build' }, 'a1'), result('b1', output, 'u1'), ...recentFive()]
    const text = textOf(maskOldToolResults(transcript).messages, 'a1')!
    expect(text).toContain('[... 7 lines elided by compaction; rerun build if needed Paths: ./dist/mid.js]')
  })

  test('the list stops at 50 and counts the rest', () => {
    // 100 lines: the hidden middle holds src/f15.ts to src/f84.ts
    const output = Array.from({ length: 100 }, (_, i) => `src/f${i}.ts`).join('\n')
    const transcript = [call('g1', 'Glob', { pattern: '**/*.ts' }, 'a1'), result('g1', output, 'u1'), ...recentFive()]
    const text = textOf(maskOldToolResults(transcript).messages, 'a1')!
    expect(text).toContain('Paths: src/f15.ts, src/f16.ts,')
    expect(text).toContain('src/f64.ts (+20 more)]')
    expect(text).not.toContain('src/f65.ts')
  })

  test('path-like tokens need a directory and an extension', () => {
    expect(pathsIn('see /w/a.ts, ./b.md and ~/c/d.json; not Makefile or a.ts or src/Makefile')).toEqual(['/w/a.ts', './b.md', '~/c/d.json'])
  })
})

describe('the pass', () => {
  const transcript = [
    { role: 'user', text: 'go', toolUses: [], handle: 'u0' } as SessionMessage,
    thinking('think1'),
    call('r1', 'Read', { file_path: '/src/a.ts' }, 'a1'),
    result('r1', numbered(1, 300), 'u1'),
    call('b1', 'Bash', { command: 'make' }, 'a2'),
    result('b1', lines(100), 'u2'),
    call('e1', 'Bash', { command: 'make' }, 'a3'),
    result('e1', 'E'.repeat(1000), 'u3', true),
    thinking('think2'),
    ...recentFive(),
    { role: 'assistant', text: 'done', toolUses: [], handle: 'done' } as SessionMessage,
  ]

  test('drops thinking-only messages and keeps everything else in order', () => {
    const { messages, stats } = maskOldToolResults(transcript)
    expect(stats).toEqual({ masked: 1, mediaMasked: 0, mediaTokens: 0, trimmedToHeadAndTail: 1, errorsCutToStart: 1, thinkingDropped: 2, keptForRows: 0 })
    expect(messages.length).toBe(transcript.length - 2)
    expect(messages.map((m) => m.handle).slice(0, 7)).toEqual(['u0', 'a1', undefined, 'a2', undefined, 'a3', undefined])
  })

  test('untouched messages keep their handle and identity', () => {
    const { messages } = maskOldToolResults(transcript)
    for (const m of messages) if (m.handle !== undefined) expect(m).toBe(transcript.find((t) => t.handle === m.handle)!)
    expect(messages.at(-1)).toBe(transcript.at(-1))
  })

  test('a second pass changes nothing more', () => {
    const once = maskOldToolResults(transcript).messages
    const twice = maskOldToolResults(once)
    expect(twice.messages).toEqual(once)
    expect(twice.stats).toEqual({ masked: 0, mediaMasked: 0, mediaTokens: 0, trimmedToHeadAndTail: 0, errorsCutToStart: 0, thinkingDropped: 0, keptForRows: 0 })
  })
})

describe('messages kept whole', () => {
  const transcript = [
    call('r1', 'Read', { file_path: '/src/a.ts' }, 'a1'),
    result('r1', numbered(1, 300), 'u1'),
    thinking('think1'),
    call('r2', 'Read', { file_path: '/src/b.ts' }, 'a2'),
    result('r2', numbered(1, 300), 'u2'),
    thinking('think2'),
    ...recentFive(),
  ]

  test('keep their handle and every result, while the rest is masked as before', () => {
    const { messages, stats } = maskOldToolResults(transcript, new Set(['u1']))
    expect(messages.find((m) => m.handle === 'u1')).toBe(transcript[1])
    expect(textOf(messages, 'a2')).toBe('[file contents elided by compaction: /src/b.ts, 300 lines. Read it again if needed.]')
    expect(stats).toEqual({ masked: 1, mediaMasked: 0, mediaTokens: 0, trimmedToHeadAndTail: 0, errorsCutToStart: 0, thinkingDropped: 2, keptForRows: 1 })
  })

  test('a thinking-only message kept whole is not dropped', () => {
    const { messages, stats } = maskOldToolResults(transcript, new Set(['think1']))
    expect(messages.find((m) => m.handle === 'think1')).toBe(transcript[2])
    expect(messages.map((m) => m.handle)).not.toContain('think2')
    expect(stats.thinkingDropped).toBe(1)
    expect(stats.keptForRows).toBe(1)
  })

  test('a message the pass would leave alone anyway is not counted', () => {
    const { messages, stats } = maskOldToolResults(transcript, new Set(['a1', 'ku5']))
    expect(stats.keptForRows).toBe(0)
    expect(messages).toEqual(maskOldToolResults(transcript).messages)
  })

  test('handles the transcript does not hold change nothing', () => {
    expect(maskOldToolResults(transcript, new Set(['gone']))).toEqual(maskOldToolResults(transcript))
  })
})
