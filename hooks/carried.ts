import type { SessionAppendInput, SessionMessage } from 'claude-code'

/**
 * Which messages carry a subagent's report or a user message queued while a turn ran, so a trim
 * can keep them whole.
 *
 * This relies on host behaviour the plugin API does not document: a message's handle is the uuid
 * of its transcript row, and every row the host files beside the conversation (an attachment, an
 * `isMeta` user row) belongs to the nearest earlier row that is a message. A message rebuilt
 * without its handle is built from its fields alone, and those rows are gone.
 *
 * Every compaction gives each message a new handle and writes rows `session.append` never sees,
 * so the rows only stand for the conversation since the last compaction, and are cleared then. A
 * message this module's trim kept whole still carries its rows, so it is remembered by what a
 * compaction leaves unchanged (its tool ids, or its role and text) until the next trim, which keeps
 * it whole again. Any other compaction rewrites it, and the memory is cleared.
 */

/** A main-conversation row: its uuid, and whether it is a report or queued message the host files beside a message. */
type Row = { uuid: string; isReportOrQueued: boolean }

// A subagent's report (`peer`), another session's SendMessage (`peer-send-message`), the person's
// own message through Remote Control (`bridge`), and the person's ping from Slack (`slack-ping`).
// Any of them is kept when it is an `isMeta` user row or a queued_command attachment delivered into
// a running turn.
const MESSAGE_ORIGINS = new Set(['peer', 'peer-send-message', 'bridge', 'slack-ping'])

/**
 * A message from another session, a subagent, Remote Control or Slack (MESSAGE_ORIGINS), or a user message
 * typed while a turn ran (`composer`, a queued_command attachment delivered into the turn). A typed
 * prompt is a message of its own. Rows of other origins filed beside a message (task
 * notifications, scheduled prompts, relays, channel messages, the engine's reminders) are not kept.
 */
export function isReportOrQueued({ door, origin, message }: SessionAppendInput): boolean {
  const isDeliveredQueuedCommand = message.type === 'attachment' && message.name === 'queued_command' && door === 'delivery'
  if (MESSAGE_ORIGINS.has(origin.kind)) return isDeliveredQueuedCommand || (message.type === 'user' && message.isMeta === true)
  if (origin.kind === 'composer') return isDeliveredQueuedCommand
  return false
}

/**
 * What identifies a message across a compaction, which changes its handle: its tool ids, or its role
 * and text when it has none. None for a message with neither, such as a thinking-only one.
 */
function keysOf(m: SessionMessage): string[] {
  const ids = [...m.toolUses.map((u) => u.tool_use_id), ...(m.toolResults ?? []).map((r) => r.tool_use_id)]
  if (ids.length) return ids.map((id) => `${m.role} tool ${id}`)
  return m.text ? [`${m.role} text ${m.text}`] : []
}

/**
 * The messages that carry a report or queued message: found from the rows appended since the last
 * compaction, and from the messages this module's last trim kept whole.
 */
export function carrierTracker() {
  // The main conversation's rows in append order, since the last compaction.
  let rows: Row[] = []
  // The keys of the messages this module's last trim kept whole, while no other compaction has stood since.
  let keptByLastTrim = new Set<string>()
  // The keys of the messages a trim is about to keep whole, until its compaction ends.
  let keptByTrimUnderWay: Set<string> | undefined
  return {
    /** Keeps a main-conversation row; a subagent's rows belong to its own transcript. */
    record(e: SessionAppendInput) {
      if (e.agentId === undefined) rows.push({ uuid: e.uuid, isReportOrQueued: isReportOrQueued(e) })
    },
    /**
     * The handles of the messages in `messages` that carry a report or queued message. From the
     * rows: for each report or queued message, the nearest earlier row whose uuid is a handle; one
     * message can carry several, and one with no such row before it is carried by nothing the rows
     * show. And every message with a key the last trim kept whole.
     */
    carriers(messages: readonly SessionMessage[]): Set<string> {
      const handles = new Set(messages.flatMap((m) => (m.handle === undefined ? [] : [m.handle])))
      const carriers = new Set<string>()
      let lastMessage: string | undefined
      for (const row of rows) {
        if (handles.has(row.uuid)) lastMessage = row.uuid
        else if (row.isReportOrQueued && lastMessage !== undefined) carriers.add(lastMessage)
      }
      for (const m of messages) {
        if (m.handle !== undefined && keysOf(m).some((k) => keptByLastTrim.has(k))) carriers.add(m.handle)
      }
      return carriers
    },
    /** Notes the carriers this module's trim keeps whole, to remember once its compaction stands. */
    trimKeeps(messages: readonly SessionMessage[], carriers: ReadonlySet<string>) {
      keptByTrimUnderWay = new Set(messages.filter((m) => m.handle !== undefined && carriers.has(m.handle)).flatMap(keysOf))
    },
    /**
     * A compaction of the main conversation ended. One that stands gives every message a new
     * handle: the rows are cleared, and the carriers are remembered only when it was this module's
     * trim, by the keys of the messages it kept whole. A carrier the trim did not see is not
     * remembered.
     */
    compactionEnded(stood: boolean) {
      if (stood) {
        rows = []
        keptByLastTrim = keptByTrimUnderWay ?? new Set()
      }
      keptByTrimUnderWay = undefined
    },
    /** Starts over, as for a new conversation. */
    forget() {
      rows = []
      keptByLastTrim = new Set()
      keptByTrimUnderWay = undefined
    },
  }
}

export type CarrierTracker = ReturnType<typeof carrierTracker>
