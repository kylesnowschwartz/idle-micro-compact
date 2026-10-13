// Derived from ruihe774/cc-micro-compaction, hooks/elide.ts at commit
// 7409c6265aa977c01cfd6b070af3c734f56fb467 (https://github.com/ruihe774/cc-micro-compaction),
// released into the public domain under the Unlicense; see LICENSE. The Read placeholders, the
// thinking step and the handle rule are its; the window, the other tools and the path lists are
// this mod's.

import type { SessionMessage as Msg, ToolResultSummary, ToolUseSummary } from 'claude-code'

export type MaskStats = {
  /** Tool results replaced by a one-line placeholder */
  masked: number
  /** Of the masked results, the images and PDFs */
  mediaMasked: number
  /** Command-style results cut to their first and last lines */
  trimmedToHeadAndTail: number
  /** Error results cut to their start */
  errorsCutToStart: number
  thinkingDropped: number
  /** Messages the pass would have changed or dropped, kept whole for the rows they carry */
  keptForRows: number
}

// The results of the newest tool uses are what the work in hand is about: they stay whole.
const RECENT_TOOL_USES_KEPT = 5
// A result this short costs less than what replacing it would lose.
const MIN_MASKED_CHARS = 200
// An error's opening says what failed; the rest is mostly a stack or a repeat.
const ERROR_START_CHARS = 400

const MASKED_TOOLS = new Set(['Read', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Edit', 'Write', 'MultiEdit'])
const isMaskedTool = (tool: string) => MASKED_TOOLS.has(tool) || tool.startsWith('mcp__')
// A file change's result only confirms it; the file itself holds what the change made.
const FILE_CHANGE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])

// Command-style output opens with what ran and closes with how it ended; the middle is the bulk.
const HEAD_AND_TAIL_TOOLS = new Set(['Bash', 'Grep', 'Glob', 'WebFetch'])
const HEAD_LINES = 15
const TAIL_LINES = 15
// Not worth a marker for a handful of hidden lines.
const MIN_HIDDEN_LINES = 6
// A head or tail of a few huge lines (minified code, a JSON blob) is cut to this many characters.
const HEAD_OR_TAIL_MAX_CHARS = 1500

const MARKER = ' elided by compaction: '
const AGAIN = '. Read it again if needed.]'
// Any of this module's placeholders and markers, so a second pass leaves them be
const PLACEHOLDER = /^\[[^\]\n]* elided by compaction: /
const CUT_MARKER = /^\[\.\.\. \d+ (?:lines|chars|chars of error output) elided by compaction/m

// Read numbers its output as `   12\tline`; the first and last numbers give the range read
const LINE_NO = /^\s*(\d+)\t/

/**
 * Path-like tokens: an optional `/`, `./`, `../` or `~/` start, at least one directory segment,
 * and a file name with an extension of 1-8 characters, bounded by whitespace, quotes, brackets,
 * `:`, `,`, `;` or `=`. Names without an extension (Makefile) are not matched.
 */
const PATH_TOKEN = /(?:^|[\s"'`(\[=])((?:\/|\.{1,2}\/|~\/)?(?:[\w.@+-]+\/)+[\w.@+-]*[\w@+-]\.[A-Za-z0-9]{1,8})(?=$|[\s"'`)\]:,;])/gm
// Enough to say which files the text was about without the list becoming the bulk again.
const PATH_LIST_MAX = 50

const pathOf = (input: Record<string, unknown>) => (typeof input.file_path === 'string' ? input.file_path : 'unknown file')

/** The distinct path-like tokens of `text`, in order of first appearance. */
export function pathsIn(text: string): string[] {
  const seen = new Set<string>()
  for (const m of text.matchAll(PATH_TOKEN)) seen.add(m[1]!)
  return [...seen]
}

/**
 * Names, inside a placeholder's closing bracket, the files the removed text named, so the model
 * still knows which files the result was about and can read them again.
 */
function withPaths(placeholder: string, removed: string): string {
  const paths = pathsIn(removed)
  if (!paths.length) return placeholder
  const more = paths.length > PATH_LIST_MAX ? ` (+${paths.length - PATH_LIST_MAX} more)` : ''
  return `${placeholder.slice(0, -1)} Paths: ${paths.slice(0, PATH_LIST_MAX).join(', ')}${more}]`
}

function describeText(input: Record<string, unknown>, text: string): string {
  let first: number | null = null
  let last: number | null = null
  for (const line of text.split('\n')) {
    const m = LINE_NO.exec(line)
    if (!m) continue
    const n = Number(m[1])
    first ??= n
    last = n
  }
  const range = first === null ? '' : first === 1 ? `, ${last} lines` : `, lines ${first}-${last}`
  return `[file contents${MARKER}${pathOf(input)}${range}${AGAIN}`
}

/**
 * The placeholder for a Read whose bulk is an image or document block rather than text
 * (`result.type` image, pdf, or parts: PDF pages rendered as images), or null for any other.
 * Their `text` is empty or a one-line note, so length says nothing about their size.
 */
function describeMedia(input: Record<string, unknown>, result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const r = result as { type?: unknown; file?: any; firstPage?: unknown }
  const path = pathOf(input)
  switch (r.type) {
    case 'image': {
      const d = r.file?.dimensions
      const size = d?.originalWidth && d?.originalHeight ? `, ${d.originalWidth}x${d.originalHeight}` : ''
      return `[image${MARKER}${path}${size}${AGAIN}`
    }
    case 'pdf':
      return `[PDF${MARKER}${path}${AGAIN}`
    case 'parts': {
      const first = typeof r.firstPage === 'number' ? r.firstPage : null
      const count = typeof r.file?.count === 'number' ? r.file.count : null
      const pages =
        typeof input.pages === 'string' ? input.pages : first !== null && count !== null ? `${first}-${first + count - 1}` : null
      return `[PDF pages${MARKER}${path}${pages ? `, pages ${pages}` : ''}${AGAIN}`
    }
    default:
      return null
  }
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** Leading `cd x &&` steps say where a command ran, not what it was. */
function withoutCd(command: string): string {
  const CD_STEP = /^cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/
  let c = command.trim()
  for (let m = CD_STEP.exec(c); m; m = CD_STEP.exec(c)) c = c.slice(m[0].length)
  return c.replace(/\s+/g, ' ').trim()
}

// Long enough to tell one call from another, short enough to stay one line.
const COMMAND_KEY_MAX_CHARS = 120
const SEARCH_KEY_MAX_CHARS = 160
const URL_KEY_MAX_CHARS = 200
const MCP_KEY_MAX_CHARS = 200

/** What to read or rerun to get a removed result back. */
function recoveryKey(use: ToolUseSummary): string {
  const str = (k: string) => (typeof use.input[k] === 'string' ? (use.input[k] as string) : '')
  if (use.tool === 'Bash') return oneLine(withoutCd(str('command')), COMMAND_KEY_MAX_CHARS)
  if (use.tool === 'Grep' || use.tool === 'Glob') return oneLine([str('pattern'), str('path')].filter(Boolean).join(' in '), SEARCH_KEY_MAX_CHARS)
  if (use.tool === 'WebSearch') return oneLine(str('query'), SEARCH_KEY_MAX_CHARS)
  if (use.tool === 'WebFetch') return oneLine(str('url'), URL_KEY_MAX_CHARS)
  if (use.tool.startsWith('mcp__')) return oneLine(`${use.tool} ${JSON.stringify(use.input)}`, MCP_KEY_MAX_CHARS)
  return str('file_path') || use.tool
}

const KIND_OF_OUTPUT: Record<string, string> = {
  Bash: 'command output',
  Grep: 'search results',
  Glob: 'search results',
  WebSearch: 'search results',
  WebFetch: 'web page',
}

const sizeOf = (text: string) => {
  const lines = text.split('\n').length
  return lines > 1 ? `${lines} lines` : `${text.length} chars`
}

/**
 * `[<kind> elided by compaction: <what to rerun>, <size>. Rerun it if needed.]`. A file change
 * names its file instead: rerunning it would apply the change twice.
 */
function describeOutput(use: ToolUseSummary, text: string): string {
  if (FILE_CHANGE_TOOLS.has(use.tool)) {
    return `[file change result${MARKER}${pathOf(use.input)}, ${sizeOf(text)}. The change is made; read the file again if needed.]`
  }
  const kind = KIND_OF_OUTPUT[use.tool] ?? 'tool result'
  return `[${kind}${MARKER}${recoveryKey(use)}, ${sizeOf(text)}. Rerun it if needed.]`
}

/** Marks text cut from a head or tail line, listing the paths it named. */
const cutMarker = (removed: string) => withPaths(`[... ${removed.length} chars elided by compaction]`, removed)

/** The head's first HEAD_OR_TAIL_MAX_CHARS characters, marked when the cut falls inside it. */
function cappedHead(head: string): string {
  if (head.length <= HEAD_OR_TAIL_MAX_CHARS) return head
  return `${head.slice(0, HEAD_OR_TAIL_MAX_CHARS)}\n${cutMarker(head.slice(HEAD_OR_TAIL_MAX_CHARS))}`
}

/** The tail's last HEAD_OR_TAIL_MAX_CHARS characters, where output ends with how it went, marked when cut. */
function cappedTail(tail: string): string {
  if (tail.length <= HEAD_OR_TAIL_MAX_CHARS) return tail
  return `${cutMarker(tail.slice(0, -HEAD_OR_TAIL_MAX_CHARS))}\n${tail.slice(-HEAD_OR_TAIL_MAX_CHARS)}`
}

/** The first and last lines of command-style output around a marker, or null when there are too few to cut. */
function headAndTail(use: ToolUseSummary, text: string): string | null {
  const lines = text.split('\n')
  const hidden = lines.length - HEAD_LINES - TAIL_LINES
  if (hidden < MIN_HIDDEN_LINES) return null
  const head = cappedHead(lines.slice(0, HEAD_LINES).join('\n'))
  const tail = cappedTail(lines.slice(lines.length - TAIL_LINES).join('\n'))
  const middle = lines.slice(HEAD_LINES, lines.length - TAIL_LINES).join('\n')
  const marker = `[... ${hidden} lines elided by compaction; rerun ${recoveryKey(use)} if needed]`
  return `${head}\n${withPaths(marker, middle)}\n${tail}`
}

/** An error's first ERROR_START_CHARS characters and a marker, or null when it is no longer than that. */
function errorStart(text: string): string | null {
  if (text.length <= ERROR_START_CHARS) return null
  const removed = text.slice(ERROR_START_CHARS)
  const marker = `[... ${removed.length} chars of error output elided by compaction]`
  return `${text.slice(0, ERROR_START_CHARS)}\n${withPaths(marker, removed)}`
}

type Replacement = { text: string; kind: 'masked' | 'trimmedToHeadAndTail' | 'errorsCutToStart'; isMedia?: true }

/** What an old result of a masked tool becomes before the length check, or null to keep it whole. */
function shortenedText(use: ToolUseSummary, r: ToolResultSummary): Replacement | null {
  if (r.isError) {
    const text = errorStart(r.text)
    return text === null ? null : { text, kind: 'errorsCutToStart' }
  }
  if (r.text.length <= MIN_MASKED_CHARS) return null
  const trimmed = HEAD_AND_TAIL_TOOLS.has(use.tool) ? headAndTail(use, r.text) : null
  if (trimmed !== null) return { text: trimmed, kind: 'trimmedToHeadAndTail' }
  const placeholder = use.tool === 'Read' ? describeText(use.input, r.text) : describeOutput(use, r.text)
  return { text: withPaths(placeholder, r.text), kind: 'masked' }
}

/** What an old result of a masked tool becomes, or null to keep it whole. */
function replacementFor(use: ToolUseSummary, r: ToolResultSummary): Replacement | null {
  // An image or PDF's bulk is a block its text doesn't show, so its placeholder always saves.
  const media = use.tool === 'Read' && !r.isError ? describeMedia(use.input, r.result) : null
  if (media !== null) return { text: media, kind: 'masked', isMedia: true }
  const replacement = shortenedText(use, r)
  // Already short (an "unchanged since last read" stub, a tiny file, a short error)
  return replacement !== null && replacement.text.length < r.text.length ? replacement : null
}

const isAlreadyCompacted = (text: string) => PLACEHOLDER.test(text) || CUT_MARKER.test(text)

/**
 * The ids of the newest RECENT_TOOL_USES_KEPT uses of masked tools, across the whole conversation.
 * Other calls (a todo list, a question, a subagent) don't count: they would push the result in
 * hand out of the window.
 */
function recentToolUses(messages: readonly Msg[]): Set<string> {
  const ids = messages.flatMap((m) => m.toolUses.filter((u) => isMaskedTool(u.tool)).map((u) => u.tool_use_id))
  return new Set(ids.slice(-RECENT_TOOL_USES_KEPT))
}

// Thinking blocks come as assistant messages of their own (one transcript entry per block),
// which read as no text and no tool uses
function isThinkingOnly(m: Msg): boolean {
  return m.role === 'assistant' && !m.text && m.toolUses.length === 0
}

const isKeptWhole = (m: Msg, keepWhole: ReadonlySet<string>) => m.handle !== undefined && keepWhole.has(m.handle)

/** One entry per thinking-only message, in order: whether maskOldToolResults keeps it whole rather than dropping it. */
export function thinkingKept(messages: readonly Msg[], keepWhole: ReadonlySet<string>): boolean[] {
  return messages.filter(isThinkingOnly).map((m) => isKeptWhole(m, keepWhole))
}

/**
 * Masks the results of every tool use but the newest few and drops thinking. Old Read results
 * become a placeholder naming the file and line range; old command-style output keeps its first
 * and last lines; old errors keep their start; every placeholder and marker lists the files the
 * removed text named. Every other message keeps its handle, so the engine keeps it whole; a user
 * message holding a changed result is rebuilt without it.
 *
 * The messages whose handles are in `keepWhole` carry rows a rebuild would lose (a subagent's
 * report, a queued user message): they stay as they are, handle and all, and are never dropped.
 */
export function maskOldToolResults(messages: readonly Msg[], keepWhole: ReadonlySet<string> = new Set()): { messages: Msg[]; stats: MaskStats } {
  const uses = new Map<string, ToolUseSummary>()
  for (const m of messages) for (const u of m.toolUses) uses.set(u.tool_use_id, u)
  const recent = recentToolUses(messages)

  const stats: MaskStats = { masked: 0, mediaMasked: 0, trimmedToHeadAndTail: 0, errorsCutToStart: 0, thinkingDropped: 0, keptForRows: 0 }
  const out: Msg[] = []
  for (const m of messages) {
    const isKept = isKeptWhole(m, keepWhole)
    if (isThinkingOnly(m)) {
      if (isKept) {
        stats.keptForRows++
        out.push(m)
      } else {
        stats.thinkingDropped++
      }
      continue
    }
    const replacements: Replacement[] = []
    const toolResults = m.toolResults?.map((r) => {
      const use = uses.get(r.tool_use_id)
      if (!use || !isMaskedTool(use.tool) || recent.has(r.tool_use_id) || isAlreadyCompacted(r.text)) return r
      const replacement = replacementFor(use, r)
      if (replacement === null) return r
      replacements.push(replacement)
      // Rebuilt without the record, so no image or document block comes back
      return { tool_use_id: r.tool_use_id, isError: r.isError, text: replacement.text }
    })
    if (!replacements.length) {
      out.push(m)
      continue
    }
    if (isKept) {
      stats.keptForRows++
      out.push(m)
      continue
    }
    for (const replacement of replacements) {
      stats[replacement.kind]++
      if (replacement.isMedia) stats.mediaMasked++
    }
    const { handle: _, ...rest } = m
    out.push({ ...rest, toolResults })
  }
  return { messages: out, stats }
}
