# Dictation design

Date: 2026-09-05. Status: direction approved by Peter after a live test (Win+H typed into
the panel and the panel stayed open).

## 1. Decision

Speech recognition belongs to the operating system, not the app. Windows voice typing
(Win+H) and macOS dictation (double-tap the dictation key) type into whichever text box has
focus, and the panel's text box is a plain Chromium textarea, so they work today. The
Windows flyout carries its own microphone button and stays up until closed; that is the
"click a microphone and dictate" Peter asked for. Voice commands ("new line", "delete
that") and auto-punctuation are the OS's features and settings.

Rejected, and why, so nobody re-proposes them:

- Whisper on WebGPU inside the panel window (transformers.js). Half a gigabyte to a
  gigabyte and a half of model in a desktop pet, VRAM held while he is open, and browser
  inference inside Electron is newer ground than the feature justifies. (Verified as
  feasible before rejection: Electron 44 exposes `navigator.gpu` and `mediaDevices` from a
  file URL, NVIDIA adapter found; the ONNX models exist on the Hub.)
- Python sidecar with faster-whisper on CUDA. Never runs on the Macs.
- sherpa-onnx native addon. Uncased, unpunctuated streaming output; poor for prose.

Everything must stay generic across Peter's Windows and macOS machines. Nothing here is
platform code.

Privacy note: Windows voice typing sends audio to Microsoft unless the build has on-device
recognition for the language; macOS dictation is on-device. Peter's call, made with that
known.

## 2. What the app changes

### 2.1 The text box grows with a take

`#input` is a one-row textarea. A dictated paragraph scrolls inside a single line. It now
grows with its content up to six rows, then scrolls; it snaps back to one row after a send
and after `/clear`. Growth follows the `input` event (OS dictation inserts text through
the normal input path, so it fires). Shift+Enter newlines are unchanged.

Implementation: a pure helper `rowsFor(lineCount, max = 6)` in a new
`src/renderer/hologram/compose.ts` (unit-tested in jsdom, no layout needed), applied by
setting `rows` from the current line count on every input event, and reset to 1 on send.
CSS: `max-height` for six rows and `overflow-y: auto` on `#input`.

### 2.2 A one-time dictation hint

The first time the panel opens on a machine, the textarea placeholder reads
`Speak, operator. Win+H to dictate. /help for rites.` on Windows and
`Speak, operator. Double-tap your dictation key to dictate. /help for rites.` on macOS,
then reverts to the usual line on the next open. Platform from `navigator.userAgent`
("Macintosh"). Once-ness via `localStorage` key `hint.dictation` in the hologram renderer
(per Chromium profile, so per machine, which is the intent). `/help` gains one permanent
line: `Dictation: Win+H (Windows) or your dictation key (Mac) types into this box.`

### 2.3 Nothing else

No mic button (it could only focus the box the flyout already sits on), no dependency, no
model, no permission code, no auto-send.

## 3. The novel workspace (no app code)

A folder outside the app, `C:\repo\novel` (Peter may rename it), holding a `CLAUDE.md`
that turns him into a story editor whenever Peter runs `/cd C:\repo\novel`:

- Every message is appended verbatim, as a numbered entry, to `dictation/YYYY-MM-DD.md`
  before he answers. Earlier entries are never edited.
- `outline.md`, `characters.md`, `world.md`, `open-questions.md` are kept current with
  small edits.
- Replies reflect the thought back, name what it changes or contradicts, and ask one
  sharp question. Prose only when asked in so many words, into `drafts/`.

Edits inside the workspace already pass without prompts (`permissionMode: acceptEdits`),
and the CLI reads the folder's `CLAUDE.md` in print mode with the flags the brain already
passes (verified 2026-09-05 with a marker file and `--setting-sources project`). Putting
the folder in git gives the Macs the same editor.

The file is delivered with this round and Peter tunes the voice.

## 4. Tests

- Unit: `rowsFor` (1 line gives 1, six gives 6, twenty gives 6, blank gives 1).
- E2E, echo brain: type three Shift+Enter lines into the box and assert `rows` is 3; press
  Enter and assert it is back to 1. Launch with a fresh profile and assert the placeholder
  carries the hint, reload the page and assert it does not. E2E count 20 today; two new.
- Test hook: `BUDDY_USER_DATA=<dir>` makes main call `app.setPath('userData', dir)` before
  anything reads the path (the log dir is computed at module load in `src/main/index.ts`,
  so the override goes at the very top). The hint spec launches with a temp dir. Today the
  e2e suite runs against the real profile (config, state, local storage); this hook is the
  first step away from that and the other specs may adopt it later.

## 5. Out of scope

In-app recognition of any kind, voice output (the voice slice), a mic button, auto-send,
wake words.
