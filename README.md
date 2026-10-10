# idle-micro-compact

A [Claude Code](https://code.claude.com) mod that compacts an idle session shortly before its 1-hour
prompt cache expires, and tries the cheap compaction first. When masking old tool results and dropping
thinking would make the conversation small enough, it does only that, with no model call. Otherwise it
writes the usual summary.

It combines two mods:

- [davidar/claude-idle-compact](https://github.com/davidar/claude-idle-compact) (MIT): the idle timer,
  the size floor, the late-timer check, the summary instructions and the log wording. `hooks/register.ts`
  and `tests/register.test.ts` are adapted from it.
- [ruihe774/cc-micro-compaction](https://github.com/ruihe774/cc-micro-compaction) (Unlicense):
  `microCompact`, which replaces each `Read` result with a one-line placeholder naming the file and
  line range, and drops thinking blocks. `hooks/mask.ts` and `tests/mask.test.ts` are derived from it.

## What it does

After every main-loop turn it arms a timer (`idleMinutes`, default 50). The next turn, `/clear` or
exit cancels it; a reload re-arms it for the time left. When the timer fires:

1. If the conversation (the Messages row of `/context`) is under `minTokens` (default 40000), it does
   nothing and says so: `not compacted: the conversation is 12k tokens, under the 40k floor`.
2. If the timer fired more than an hour after the last turn (the machine slept), the 1-hour cache has
   already lapsed. It does nothing and says so. An `idleMinutes` of 60 or more leaves no warm window.
3. Otherwise it runs `/compact` with idle-compact's summary instructions. Its own `session.compact`
   hook picks that compaction out by the instructions' opening words and masks the transcript
   (below). It estimates the size afterwards as the Messages row before, less the removed text and
   the dropped thinking at about 4 characters a token.
   - At or under `microTargetTokens` (default 150000), it installs the masked transcript itself. No
     summary request is made.
   - Over the target, or when there was nothing to mask, it hands the compaction to Claude Code's
     own summary.

Masking covers the results of `Read`, `Bash`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, `Edit`,
`Write`, `MultiEdit` and MCP tools. The 5 newest of those calls keep their results whole; calls to
other tools, such as the todo list or a subagent, don't count toward the 5. Older results change:

- A `Read` result becomes a one-line placeholder naming the file and the lines read; an image or
  PDF becomes one naming the file.
- `Bash`, `Grep`, `Glob` and `WebFetch` output keeps its first 15 and last 15 lines, with a marker
  for the lines between, when that is shorter. A head or tail over 1500 characters keeps its first
  (head) or last (tail) 1500, with a marker where it was cut. Other output becomes a placeholder
  naming what to rerun.
- An `Edit`, `Write` or `MultiEdit` result becomes a placeholder naming the file, saying the change
  is made and to read the file again if needed.
- An error keeps its first 400 characters.
- Results of 200 characters or less stay whole.

Every placeholder and marker lists the file paths the removed text named, up to 50. Thinking blocks
are dropped. A second pass leaves placeholders and markers alone.

The removed thinking is counted from the conversation's Messages API form
(`$.session.messages({ as: 'api' })`). A thinking block sent back holds only its signature, so its
size is estimated as 1.218 × the signature's length + 81.6 characters, or its text's length when it
holds text. When that form can't be read, the thinking counts as nothing and the estimate errs high.

Either way it leaves one line in the transcript and the status line. For example:

```
● idle-micro-compact: micro-compacted at 15:18 after 1 min idle (76k conversation → est. 27k, measured 7k; 9 tool results masked, 2 trimmed to head and tail, 2 thinking blocks dropped, no model call)
● idle-micro-compact: compacted at 14:40 after 1 min idle (micro est. 81k, over the 1 target; 88k tokens → 10k summary, measured 14k, 48% read from cache)
```

`est.` is the estimate the decision used. `measured` is the Messages row `/context` reports straight
after the compaction. On the summary line, the first figure is the whole context before and the second
is the summary alone, as idle-compact reports them.

If the idle compaction fails, it logs one line with the reason, `not compacted: <reason>`, and sets
no status. The next turn arms the timer again.

It goes through `/compact` rather than `$.session.compact` because Claude Code does not run a plugin's
own hooks on an event that plugin's code raised outside a hook, such as from a timer. Through the
command, the mod's `session.compact` hook sees the compaction. As a result the transcript records it
as a manual `/compact`, and the `/compact …` line shows in the transcript.

## Caveats

- **The estimate errs high.** It subtracts only the text `$.session.messages()` shows as removed
  (message text, tool inputs and tool results) and the estimated thinking. Context with no text
  there, such as loaded instruction files and reminders, stays in the figure, as it stays after
  masking. Images have no text there either, so the estimate misses what masking them saves, and
  leans toward the summary.
- **Micro-compaction rewrites the transcript from the first change on**, usually the first thinking
  block. The next request re-caches from that point. That is cheaper than re-caching the whole
  conversation cold, but it is not free.
- **Masked output is gone from context.** The placeholder or marker names the file to read again or
  the command to rerun, and the files the removed text named.
- **It assumes a 1-hour cache**, like idle-compact. On a 5-minute cache it fires long after the cache
  is cold.

## Install

The repository is private, so your `gh` or git login must have read access to it.

```sh
claude plugin marketplace add kylesnowschwartz/idle-micro-compact
claude plugin install idle-micro-compact@idle-micro-compact
```

Then run `/reload-plugins` in an open session.

## Configure

| Option | Default | Meaning |
|---|---|---|
| `idleMinutes` | `50` | Minutes idle before compacting. |
| `minTokens` | `40000` | Leave conversations smaller than this alone (the Messages row only). |
| `microTargetTokens` | `150000` | Use micro-compaction (masking, no model call) when it is estimated to leave the conversation at or under this. |

## Develop

```sh
claude plugin validate .        # what the module hooks and calls
claude plugin test .            # tests: mocked clock, usage, /compact and summary
npx -p typescript tsc -p .      # type-check, once Claude Code has written .claude-plugin/types/
```

Claude Code writes `.claude-plugin/types/` (gitignored) the first time it loads the mod from this
folder. The root `tsconfig.json` extends the `tsconfig.json` in there.

To try it by hand, open a throwaway session in a new tmux window. Inside tmux the window opens in
the current session; outside, in a detached session named `idle-micro`.

```sh
scripts/try-in-tmux micro      # masking the reads is enough: look for `micro-compacted at`
scripts/try-in-tmux summary    # the target is 1 token, so it writes the summary: `compacted at`
```

The script writes three large text files and five one-line notes to
`${TMPDIR:-/tmp}/idle-micro-compact-try/` and starts
Claude Code there on Haiku with this folder's mod loaded, a one-minute idle delay and a 100-token
floor. It prints the prompt to paste and the line to look for. With `--drive` it also accepts the
folder-trust question, sends the prompt, waits for the idle compaction's line, and exits 0 when it
is the expected branch. The window stays open either way.

## License

MIT. See [LICENSE](LICENSE) for this mod's notice and both upstream notices.
