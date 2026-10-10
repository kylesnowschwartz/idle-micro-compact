# idle-micro-compact

A [Claude Code](https://code.claude.com) mod that compacts an idle session shortly before its 1-hour
prompt cache expires, and tries the cheap compaction first. When eliding file reads and thinking would
make the conversation small enough, it does only that, with no model call. Otherwise it writes the
usual summary.

It combines two mods:

- [davidar/claude-idle-compact](https://github.com/davidar/claude-idle-compact) (MIT): the idle timer,
  the size floor, the late-timer check, the summary instructions and the log wording. `hooks/register.ts`
  and `tests/register.test.ts` are adapted from it.
- [ruihe774/cc-micro-compaction](https://github.com/ruihe774/cc-micro-compaction) (Unlicense):
  `microCompact`, which replaces each `Read` result with a one-line placeholder naming the file and
  line range, and drops thinking blocks. `hooks/elide.ts` and `tests/elide.test.ts` are copied from it.

## What it does

After every main-loop turn it arms a timer (`idleMinutes`, default 50). The next turn, `/clear` or
exit cancels it; a reload re-arms it for the time left. When the timer fires:

1. If the conversation (the Messages row of `/context`) is under `minTokens` (default 40000), it does
   nothing and says so: `not compacted: the conversation is 12k tokens, under the 40k floor`.
2. If the timer fired more than an hour after the last turn (the machine slept), the 1-hour cache has
   already lapsed. It does nothing and says so. An `idleMinutes` of 60 or more leaves no warm window.
3. Otherwise it runs `/compact` with idle-compact's summary instructions. Its own `session.compact`
   hook picks that compaction out by the instructions' opening words, runs `microCompact` over the
   transcript, and estimates the size afterwards as the Messages row before, less the removed text
   at about 4 characters a token.
   - At or under `microTargetTokens` (default 150000), it installs the elided transcript itself. No
     summary request is made.
   - Over the target, or when there was nothing to elide, it hands the compaction to Claude Code's
     own summary.

Either way it leaves one line in the transcript and the status line. For example:

```
● idle-micro-compact: micro-compacted at 14:38 after 1 min idle (73k conversation → est. 66k, measured 64k; 3 reads and 3 thinking blocks elided, no model call)
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

- **The estimate errs high.** It subtracts only the text `$.session.messages()` shows as removed:
  message text, tool inputs and tool results. Context with no text there, such as loaded instruction
  files and reminders, stays in the figure, as it stays after eliding. Images and thinking have no
  text there either, so the estimate misses what dropping them saves, and leans toward the summary.
- **Micro-compaction rewrites the transcript from the first elided read on.** The next request
  re-caches from that point. That is cheaper than re-caching the whole conversation cold, but it is
  not free.
- **Elided files are gone from context.** The placeholder tells the model to read the file again if
  it needs it.
- **It assumes a 1-hour cache**, like idle-compact. On a 5-minute cache it fires long after the cache
  is cold.

## Configure

| Option | Default | Meaning |
|---|---|---|
| `idleMinutes` | `50` | Minutes idle before compacting. |
| `minTokens` | `40000` | Leave conversations smaller than this alone (the Messages row only). |
| `microTargetTokens` | `150000` | Use micro-compaction when it is estimated to leave the conversation at or under this. |

## Develop

```sh
claude plugin validate .        # what the module hooks and calls
claude plugin test .            # tests: mocked clock, usage, /compact and summary
npx -p typescript tsc -p .      # type-check, once Claude Code has written .claude-plugin/types/
```

Claude Code writes `.claude-plugin/types/` (gitignored) the first time it loads the mod from this
folder. The root `tsconfig.json` extends the `tsconfig.json` in there.

To try it by hand in a throwaway session with a one-minute delay (a `--plugin-dir` copy takes its
options from `idle-micro-compact@inline`):

```sh
claude --plugin-dir . --model haiku --settings \
  '{"pluginConfigs":{"idle-micro-compact@inline":{"options":{"idleMinutes":1,"minTokens":100,"microTargetTokens":1000000}}}}'
```

From inside another Claude Code session, put `env -u CLAUDECODE` in front of `claude`.

Have it read a few large files, wait a minute after the turn ends, and look for the
`micro-compacted at` line. Set `microTargetTokens` to `1` to see the summary branch instead.

## License

MIT. See [LICENSE](LICENSE) for this mod's notice and both upstream notices.
