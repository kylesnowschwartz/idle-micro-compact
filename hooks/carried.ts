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
 * so the rows only stand for the conversation since the last compaction, and are cleared then.
 */

/** A main-conversation row: its uuid, and whether it is a report or queued message the host files beside a message. */
type Row = { uuid: string; isReportOrQueued: boolean }

// A subagent's report (`peer`), another session's SendMessage (`peer-send-message`), and the
// person's own message through Remote Control (`bridge`). Any of them is kept when it is an
// `isMeta` user row or a queued_command attachment delivered into a running turn.
const MESSAGE_ORIGINS = new Set(['peer', 'peer-send-message', 'bridge'])

/**
 * A message from another session, a subagent or Remote Control (MESSAGE_ORIGINS), or a user message
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

/** The main conversation's rows in append order, since the last compaction. */
export function appendedRows() {
  let rows: Row[] = []
  return {
    /** Keeps a main-conversation row; a subagent's rows belong to its own transcript. */
    record(e: SessionAppendInput) {
      if (e.agentId === undefined) rows.push({ uuid: e.uuid, isReportOrQueued: isReportOrQueued(e) })
    },
    clear() {
      rows = []
    },
    /**
     * The handles of the messages in `messages` that carry a report or queued message: for each,
     * the nearest earlier row whose uuid is a handle. One message can carry several. A report or
     * queued message with no such row before it is carried by nothing this table knows.
     */
    carriers(messages: readonly SessionMessage[]): Set<string> {
      const handles = new Set(messages.flatMap((m) => (m.handle === undefined ? [] : [m.handle])))
      const carriers = new Set<string>()
      let lastMessage: string | undefined
      for (const row of rows) {
        if (handles.has(row.uuid)) lastMessage = row.uuid
        else if (row.isReportOrQueued && lastMessage !== undefined) carriers.add(lastMessage)
      }
      return carriers
    },
  }
}

export type AppendedRows = ReturnType<typeof appendedRows>
