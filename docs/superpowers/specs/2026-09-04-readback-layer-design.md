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

### 3.1 Flow of one reply

1. The turn runs as now. Text streams into the bubble as plain Claude text, activity rows
   appear under it, and the expression face lands at `done`.
2. On a clean `done` (no error) with non-empty reply text, main starts a readback call
   (section 4) with the reply text as input.
3. While the call runs, the bubble stays as it is. Nothing spins, nothing is greyed out.
   The next prompt may be typed and sent; the readback and the next turn overlap freely.
4. When the readback arrives, the bubble reflows once: the readback text becomes the
   headline beside the face, and the plain reply moves under an arrow row that reads
   "plain text", collapsed. Clicking the row toggles it. Each bubble keeps its own toggle
   state; nothing is remembered across bubbles or launches.
5. If the call fails, times out, or returns empty text, the bubble stays plain with no
   arrow row and main logs one line. No system line, because the answer is already on
   screen.

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
- Timeout 20 seconds, then the child is killed (`taskkill /T /F` on Windows, as the brain
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
- New channel `chat:readback` (main to hologram), payload `{ id: number; text: string }`.
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
    .readback           markdown-rendered readback text
    .plain-toggle       "▸ plain text" / "▾ plain text", a button styled as a row
    .plain[hidden]      the original rendered reply, moved here as-is
```

- The readback text goes through the same `renderMarkdown` (marked + DOMPurify) as every
  other model text. It is model output and gets no more trust than the reply.
- Moving the plain reply means moving the already-rendered node, not re-rendering, so
  highlighted code and links-as-text stay exactly as they were.
- Activity rows sit after the bubble today and stay there.
- The renderer keeps a `Map<number, HTMLDivElement>` of bubbles awaiting a readback,
  filled at `chat:done` and cleared when the readback arrives or after 30 seconds.
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
- Fake CLI: new `readback` scenario, chosen when argv carries `--model haiku`, which
  prints one JSON result whose text is `Readback: ` plus the first 40 characters of stdin.
  A `readback-fail` variant prints an `is_error` result.
- `e2e/brain.spec.ts`: after the text scenario, the bubble's headline contains
  `Readback:`, the plain section is hidden, clicking the toggle reveals the original
  `Hello`, and the face is still present. A second case with `readback: false` in the
  test config shows a plain bubble and no toggle.
- One manual real-CLI check behind the existing `npm run smoke:claude` (add a readback
  step to the script).

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
