# Readback layer: the in-character reply text, Design

Date: 2026-09-04
Status: approved in conversation
Owner: Peter
Builds on: `2026-09-03-mechanicus-buddy-design.md` section 19 (readback) and
`2026-09-04-plan-b-brain-design.md` (the CLI brain, message bubbles, expression faces).
Supersedes: the "not displayed" clause of section 19. The readback is now the text the
bubble shows; the spoken version in the voice slice reads the same text.

## 1. Goal

Every reply in the hologram reads as the character. The bubble's headline is a short
in-character restatement of Claude Code's answer, produced by a second, cheap, tool-less
CLI call after the real turn ends. Claude Code's own reply stays available, unaltered,
under a small arrow row inside the same bubble. The main turn keeps its plain voice: the
persona never reaches it, so answers, tool use, and code stay exactly as they are today.

## 2. Non-goals

- Speech. The voice slice adds the speaker button and TTS; it will read the readback text
  this design already caches on each bubble.
- Persona in the main turn, structured output from the main turn, or any change to the
  tools note.
- A faction picker above the panel. Designed and parked in
  `docs/superpowers/notes/2026-09-04-future-faction-strip.md`.
- Readbacks for anything that is not a real reply: canned lines, permission cards, slash
  command confirmations, error lines.

## 3. Behavior

### 3.1 Flow of one reply (amended 2026-09-04 evening: waiting state)

1. The turn runs as now. Activity rows appear under the bubble as tools run, and the
   expression face lands at `done`. With readback on, the bubble itself shows a waiting
   indicator, three animated dots, from its first text delta; the plain reply accumulates
   in a hidden section of the same bubble instead of streaming into view.
2. On a clean `done` (no error) with non-empty reply text, main starts a readback call
   (section 4) with the reply text as input. The dots stay up.
3. The next prompt may be typed and sent while the readback runs; the readback and the
   next turn overlap freely.
4. When the readback arrives, the bubble settles once: the readback text becomes the
   headline beside the face, the dots go away, and the plain reply stays folded under a
   small arrow, collapsed. Clicking the arrow toggles it. Each bubble keeps its own toggle
   state; nothing is remembered across bubbles or launches.
5. If the call fails, times out, or returns empty text, main tells the renderer, the dots
   go away, and the plain reply shows with no arrow; main logs one line. No system line,
   because the answer is on screen. The same happens for a turn that ends with an error.
6. With readback off (config, echo brain, missing CLI), the bubble streams plain text as
   before, with no dots and no arrow.
7. A system line landing mid-turn (an error line, the stopped line, a CLI status line)
   does not orphan the bubble: the renderer keeps every reply bubble the turn created and
   settles all of them at `done`. The face and the readback go to the turn's last bubble;
   earlier ones settle to plain text.

Old bubbles never change after their readback lands or fails.

### 3.2 What gets a readback

- Only bubbles created by a brain reply (`chat:delta` stream ending in `chat:done`).
- Skipped when: the turn ended with an error, the reply text is empty after trimming, the
  brain is the echo brain, the CLI is missing, or `config.readback` is false.
- `/stop` kills the turn, not any readback in flight. App quit kills everything.
- Readbacks are independent: several may be in flight at once; each resolves to its own
  bubble by message id. Late arrivals still apply, unless the panel was reloaded (the
  bubble is gone) in which case they are dropped.

## 4. The readback call

One CLI process per readback, spawned by a new `Readback` class in
`src/main/brain/readback.ts` with the same injectable `spawn`, `env`, and `argsPrefix`
test hooks as `ClaudeCliBrain`.

```
claude -p --output-format json --model haiku
       --setting-sources project     (as the main turn: the user's hooks and plugins stay out)
       --no-session-persistence      (nothing written to the session list)
       --system-prompt <persona.md + READBACK_INSTRUCTION>
       --tools ""                    (no built-in tools; see 4.3)
       --strict-mcp-config           (no --mcp-config, so no MCP servers at all)
```

- The plain reply is written to stdin, then stdin is closed. Input longer than 12,000
  characters is cut there with a trailing `[truncated]` so a long code answer cannot
  turn into a long bill.
- `cwd` is `<userData>/readback`, created on first use. Two reasons: the CLI would
  otherwise read the workspace's `CLAUDE.md` into a call that must know nothing about the
  workspace, and any session file the CLI writes lands under that scratch path instead of
  polluting the `C:\repo` session list.
- The environment is `childEnv(process.env)` from `claude-cli.ts` (no `CLAUDECODE`, no
  `ANTHROPIC_API_KEY`).
- Timeout 45 seconds, then the child is killed (`taskkill /T /F` on Windows, as the brain
  does) and the call resolves to `null`.
- Output: one JSON object on stdout. `result` is the readback when `is_error` is false and
  `subtype` is `success`; anything else resolves to `null`. Stderr's last lines go to the
  log on failure.

### 4.1 The prompt

The system prompt is the pack's `persona.md` followed by a blank line and this fixed
instruction (a constant in `readback.ts`, quoted here in full):

> You are the voice layer of a desktop assistant. The user's message below is a reply the
> assistant just gave, written in plain language. Restate its substance in your own
> character in at most three short sentences. Add no facts and answer nothing new. Keep
> file names, commands, and numbers exactly as written. Use no code blocks, lists, or
> headings. If the reply is only code, say what the code does. Output the restatement
> and nothing else.

### 4.2 persona.md

The Mechanicus `persona.md` loses its last paragraph (the `set_mood`, `emote`, `go_to`
instructions). Those tools are not available in the readback call and the main turn never
sees the persona, so the paragraph no longer describes anything real. The character text
above it is unchanged.

### 4.3 Flags (pinned 2026-09-04 against the installed 2.1.220)

Checked in `claude --help` after the design session: `--system-prompt <prompt>` replaces
the built-in prompt (and `--append-system-prompt` is the fallback if replacing it ever
proves worse); `--tools <names>` restricts the built-in tools to the ones named, so the
empty list disables them all, with `--disallowedTools` as the fallback;
`--no-session-persistence` exists and is print-mode only, which is exactly this call;
`--setting-sources project` keeps the user's own hooks and plugins out of the call, as
verified for the main turn in the Plan B spec. The first implementation task still makes
one real call with these flags to confirm the empty `--tools` list behaves as read.
The scratch `cwd` stays regardless, so the CLI reads no workspace `CLAUDE.md`.

## 5. Controller and IPC

- Every brain reply gets a message id: `ChatController` increments a counter per turn
  and includes it in `ChatDonePayload.id`. The renderer uses it to find the bubble later.
  `ChatDonePayload.readback` says whether a readback was started for that reply, and
  `ChatStatusPayload.readback` tells the renderer up front whether readbacks are on, so
  the waiting dots can start with the first delta.
- New channel `chat:readback` (main to hologram), payload
  `{ id: number; text?: string; failed?: true }`: text on success, `failed` when the call
  failed, timed out, or returned nothing, so the bubble can settle to plain text at once.
- `ChatController.ask` collects the reply text as it streams (it already forwards the
  deltas). After `done` without error and with non-empty text, it calls
  `readback.run(text)` without awaiting it, and on a non-null result sends
  `out.readback({ id, text })`. On null it logs one line through a new `log` dependency
  on the controller, which main binds to `appendLog` like the action host's.
- `ChatOut` gains `readback(p)`; `BuddyBridge` gains `onChatReadback(cb)`.
- `EchoBrain` mode and the missing-CLI mode construct the controller with `readback`
  undefined, which means skip.

## 6. Renderer

Bubble structure after a readback lands (`src/renderer/hologram/main.ts`):

```
.msg.buddy
  .face-slot            (unchanged)
  .text
    .dots               three animated dots, present only while waiting (readback on)
    .readback           markdown-rendered readback text
    .plain-toggle       a bare chevron button (down when collapsed, up when expanded) with a
                        "plain text" tooltip; no label (Peter, 2026-09-04 evening)
    .plain[hidden]      the original rendered reply, moved here as-is
```

- The readback text goes through the same `renderMarkdown` (marked + DOMPurify) as every
  other model text. It is model output and gets no more trust than the reply.
- Moving the plain reply means moving the already-rendered node, not re-rendering, so
  highlighted code and links-as-text stay exactly as they were.
- Activity rows sit after the bubble today and stay there.
- With readback on, the bubble starts in the waiting state: the streamed text goes into
  the hidden `.plain` section from the first delta and `.dots` is what the user sees.
- The renderer keeps a `Map<number, HTMLDivElement>` of bubbles awaiting a readback,
  filled at `chat:done` and cleared when the readback arrives, fails, or after 30 seconds
  (the fallback reveals the plain text).
- If the log was scrolled to the bottom before the reflow, it stays at the bottom after.
- Styles: the toggle row uses the activity row's size and opacity with the accent chevron;
  the expanded plain section gets a faint top border. No new fonts or colors.

## 7. Config

`readback: boolean`, default `true`, validated as a boolean like the other fields. When
false, no readback call is made and bubbles stay plain. No slash command for it; it is a
config toggle.

## 8. Error handling

- Spawn error, non-zero exit, malformed or non-success JSON, empty result, timeout: the
  call resolves to `null`; the controller logs `readback failed: <reason>` and the bubble
  stays plain. The app never shows an error for a failed readback.
- A readback arriving for an id the renderer no longer has is dropped silently.
- Quit during a readback: `before-quit` kills the child like the brain's.

## 9. Testing

Nothing here spends quota; every test uses `test/fake-claude.cjs`.

- `readback.test.ts`: exact argument list; the JSON result path; `is_error` and
  `subtype` failures resolve to null; timeout with fake timers kills and resolves null;
  `ENOENT` resolves null; input truncation at 12,000 characters; the scratch `cwd` is
  created and used.
- `chat.test.ts`: a clean turn triggers one readback with the joined reply text and the
  right id; an error turn, an empty reply, and `readback: undefined` trigger none; a null
  result produces a log line and no `out.readback`.
- Fake CLI: new `readback` behavior, chosen when argv carries `--output-format json` (the
  main turn uses `stream-json`; the scenario env var is inherited and cannot be the key), which
  prints one JSON result whose text is `Readback: ` plus the first 40 characters of stdin.
  A `readback-fail` variant prints an `is_error` result.
- `e2e/brain.spec.ts`: after the text scenario, the bubble's headline contains
  `Readback:`, the plain section is hidden, clicking the toggle reveals the original
  `Hello`, and the face is still present. A second case with `readback: false` in the
  test config shows a plain bubble and no toggle.
- One manual real-CLI check behind the existing `npm run smoke:claude` (the script's readback
  step uses a stand-in persona line, not the pack's `persona.md`; verified 2026-09-04).

## 10. Files

```
src/main/brain/readback.ts        New: Readback class, READBACK_INSTRUCTION, arg builder
src/main/brain/readback.test.ts   New
src/main/chat.ts                  Modify: message ids, collect reply text, call readback
src/main/chat.test.ts             Modify
src/main/config.ts                Modify: readback flag + validator
src/main/index.ts                 Modify: construct Readback (or not), wire out.readback
src/shared/ipc.ts                 Modify: id on done, chat:readback channel, bridge method
src/preload/bridge.ts             Modify: onChatReadback
src/renderer/hologram/main.ts     Modify: pending map, reflow, toggle
src/renderer/hologram/styles.css  Modify: toggle row and plain section
packs/mechanicus/persona.md       Modify: drop the tools paragraph
test/fake-claude.cjs              Modify: readback and readback-fail scenarios
e2e/brain.spec.ts                 Modify
```
