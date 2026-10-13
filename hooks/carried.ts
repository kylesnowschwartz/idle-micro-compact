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

/**
 * A subagent's report (`peer`: an `isMeta` user row, or a `queued_command` attachment when it
 * arrived mid-turn) or a user message queued while a turn ran (`composer`, a `queued_command`
 * attachment delivered into the turn). A typed prompt is a message of its own. The other rows filed
 * beside a message, task notifications among them, are re-sent by the host or stale.
 */
export function isReportOrQueued({ door, origin, message }: SessionAppendInput): boolean {
  const isQueuedCommand = message.type === 'attachment' && message.name === 'queued_command'
  if (origin.kind === 'peer') return isQueuedCommand || (message.type === 'user' && message.isMeta === true)
  if (origin.kind === 'composer') return isQueuedCommand && door === 'delivery'
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
