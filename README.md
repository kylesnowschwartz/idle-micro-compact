# idle-micro-compact

`idle-micro-compact` compacts an idle Claude Code conversation before its 1-hour prompt cache
expires. It masks old tool output, drops thinking, or asks Claude Code to write a summary. This can
lower the cache-write cost when you return.

## What it saves

One idle 150k-token conversation on Claude Opus 5.5, from the idle pause to your first message back:

| What happens | Tokens re-cached on return | Total cost | Saved with the plugin |
|---|---:|---:|---:|
| Without the plugin: nothing | 150k | $1.20 | — |
| Without the plugin: `/compact` after the cache expired | 10k | $1.48 | −$0.28 |
| With the plugin: summary before the cache expires | 10k | $0.31 | $0.89 (74%) |
| With the plugin: old tool results masked | 50k | $0.40 | $0.80 (67%) |

"Saved with the plugin" is the difference from the first row. The total cost is the compaction
request plus the first request when you return:

- Without the plugin, `/compact` on a cold cache writes all 150k tokens ($1.20) and 10k of summary
  output ($0.20).
- With the plugin, the summary request reads the 150k tokens from cache ($0.03) and writes 10k of
  output ($0.20). Masking makes no model call ($0).
- The first request back writes the remaining conversation to a new cache at $8 per million tokens.

Assumptions:

- Claude Opus 5.5 first-party API prices per million tokens: $4 base input, $8 for a 1-hour cache
  write, $0.20 for a cache read, and $20 output.
- The plugin fires after 50 minutes idle. You return after the 1-hour cache expires.
- A summary is 10k tokens. Masking leaves 50k tokens.
- A request on a cold cache is billed as a 1-hour cache write.
- System prompts, tools, and thinking tokens are left out.

Compacting cold pays to send the whole conversation once just to shrink it. Compacting while warm
reads it from cache at 5% of the base input price. These figures are an example. Actual savings
depend on the conversation size.

## Install

```sh
claude plugin marketplace add kylesnowschwartz/idle-micro-compact
claude plugin install idle-micro-compact@idle-micro-compact
```

Run `/reload-plugins` in each open Claude Code session after installation.

The mod registers hooks for session and turn events. It reads conversation usage and messages,
stores the last turn time in Claude Code's plugin state, runs the built-in `/compact` command, and
writes a transcript log line and status line. It does not add a command of its own.

## Configure

The defaults work with a 1-hour prompt cache. Configure the options inside Claude Code:

```text
/plugin configure idle-micro-compact
```

Or configure them from a shell:

```sh
claude plugin configure idle-micro-compact
```

To edit the options by hand, add them to your user settings at `~/.claude/settings.json`. Claude
Code reads plugin options from user settings, not from a project's `.claude/settings.json`.

```json
{
  "pluginConfigs": {
    "idle-micro-compact@idle-micro-compact": {
      "options": {
        "idleMinutes": 50,
        "minTokens": 40000,
        "microTargetTokens": 150000
      }
    }
  }
}
```

| Option | Default | Meaning |
|---|---:|---|
| `idleMinutes` | `50` | Minutes idle before compacting. `0` also uses the 50-minute default. |
| `minTokens` | `40000` | Leave smaller conversations alone. This counts the Messages row, not the system prompt or tools. |
| `microTargetTokens` | `150000` | Use masking with no model call when the estimated result is at or below this size. |

Set `idleMinutes` below `60`. A value of `60` or more leaves no warm-cache window, so the mod skips
compaction when the timer fires.

## How it works

After each main-session turn, the mod starts an idle timer. A new turn, `/clear`, or session exit
cancels it. Reloading the plugin restarts the timer with the time left since the last turn.

When the timer fires, the mod follows these steps:

1. It reads the conversation size from the Messages row of `/context`. If that row is unavailable,
   it uses the whole context. If the size is unknown, it leaves the session alone.
2. It skips conversations below `minTokens`.
3. It skips compaction if the timer fired after the 1-hour cache deadline, such as after the machine
   slept.
4. It runs `/compact`. Its compaction hook masks old tool results and drops thinking, then estimates
   the remaining conversation size.
5. If masking changed the transcript and the estimate is at or below `microTargetTokens`, it installs
   the masked transcript with no model call. Otherwise, Claude Code writes a summary.

The automatic request appears in the transcript as a manual `/compact` line.

## What micro-compaction keeps and drops

| Result | What stays |
|---|---|
| `Read` text | A shorter one-line placeholder with the file and line range. |
| Images and PDFs | A placeholder with the file name. |
| `Bash`, `Grep`, `Glob`, `WebFetch` output | The first and last 15 lines when shorter. Otherwise, a placeholder. Each end has a 1,500-character cap. |
| Other tool results | A placeholder naming the file, search, URL, command, or MCP call. File changes say to read the file. This includes `WebSearch`, `Edit`, `Write`, `MultiEdit`, and MCP tools. |
| Errors | The first 400 characters when shorter. Other errors stay whole. |
| Thinking blocks | Nothing. They are dropped. |

The 5 newest calls to these tools stay whole. Todo and subagent calls do not count toward the 5.
Text results of 200 characters or less stay whole. Masked output must be read or rerun to recover it.
Placeholders and markers list up to 50 paths from removed text. A later pass leaves them unchanged.

## How much micro-compaction removes

Across 50 idle points from 44 of the author's real Claude Code sessions, this method removed a median 54% of the conversation, against 39% for the upstream method of masking only `Read` results and dropping thinking.
It lost none of the file paths used in the next three turns.
This was an offline benchmark on one person's sessions. It checked paths by string match.

## Log lines

After a successful compaction, the mod writes a line to the transcript and pins a shorter one as the
status. The next turn clears the status. Examples:

```text
● idle-micro-compact: trimmed at 23:00 after 50 min idle: 175k → ~73k tokens (21 old tool results removed, 8 shortened, 66 thinking blocks dropped)
● idle-micro-compact: summarized at 18:41 after 50 min idle: 285k → 19k summary
```

The status for the same two compactions:

```text
trimmed at 23:00: 175k → ~73k tokens
summarized at 18:41: 285k → 19k summary
```

- On a trimmed line, the second size is the estimate used to choose trimming over a summary.
- On a summarized line, the first size is the whole context. The second is the summary alone.
- `shortened` counts tool results cut to their head and tail. Errors cut to their start are listed
  only when there are some.
- A summarized compaction also writes one debug-log line, `summary chosen: ...`, for tuning the
  mod. It holds why trimming wasn't enough (`nothing to trim`, or `trim estimate 200k, target 150k`)
  and the share of the summary request input read from cache (`summary request 99% cached`). Each
  part is left out when unknown, and the line is omitted when both are.
- `not compacted:` appears for a known-small or late conversation, or a failed compaction. It does
  not set a status.

No line appears if the size is unknown, a turn overtakes the timer, or Claude Code skips compaction.

## Caveats

- **The estimate tends to be high.** It subtracts removed tool output, dropped thinking, and masked
  images and PDFs at fixed token rates for Opus 5.5. An image counts by its size, up to 1,600
  tokens. A PDF counts 1,000. It does not count attachments Claude Code drops with a rewritten
  message, or images inside MCP tool results. A conversation near `microTargetTokens` may get a
  summary when trimming would have been enough.
- **Micro-compaction rewrites the transcript from the first changed message.** The next request
  re-caches from that point. This is cheaper than re-caching the whole conversation cold, but it is
  not free.
- **Masked output is removed from context.** The replacement names what Claude can read or rerun,
  but the removed content itself is unavailable.
- **The timing assumes a 1-hour cache.** With a 5-minute cache, the default timer fires after the
  cache is cold.

## Upstream projects

This mod combines work from two projects:

- [davidar/claude-idle-compact](https://github.com/davidar/claude-idle-compact) (MIT) provides the
  idle timer, size floor, late-timer check, summary instructions, and log wording.
  `hooks/register.ts` and `tests/register.test.ts` are adapted from it.
- [ruihe774/cc-micro-compaction](https://github.com/ruihe774/cc-micro-compaction) (Unlicense)
  provides the original `microCompact` behavior for replacing `Read` results and dropping thinking.
  `hooks/mask.ts` and `tests/mask.test.ts` are derived from it.

This mod extends `microCompact`. It masks every common tool, not only `Read`. It keeps the 5 newest
covered tool uses whole. It keeps the head and tail of command output and the start of errors. Its
placeholders list file paths from removed text.

## Develop

```sh
claude plugin validate .        # show what the mod hooks and calls
claude plugin test .            # run the mocked clock, usage, compaction, and summary tests
npx -p typescript tsc -p .      # type-check after Claude Code writes the generated types
```

Claude Code writes `.claude-plugin/types/` the first time it loads the mod from this folder. The
directory is ignored by Git. The root `tsconfig.json` extends the generated `tsconfig.json` there.

Use `scripts/try-in-tmux` to open a throwaway Claude Code session in a new tmux window:

```sh
scripts/try-in-tmux micro      # expect `trimmed at`
scripts/try-in-tmux summary    # expect `summarized at`
```

Inside tmux, the script opens the window in the current session. Outside tmux, it uses a detached
session named `idle-micro`. It writes three large files and five one-line notes to
`${TMPDIR:-/tmp}/idle-micro-compact-try/`, then starts Claude Code there on Haiku with the mod loaded,
a one-minute idle delay, and a 100-token floor. It prints the prompt to paste and the expected line.

Pass `--drive` to accept the fixture folder's trust prompt, send the test prompt, wait for the idle
compaction line, and exit successfully only when the expected branch appears. The tmux window stays
open.

## License

MIT. See [LICENSE](LICENSE) for this mod's notice and both upstream notices.
