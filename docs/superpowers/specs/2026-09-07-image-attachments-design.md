# Image attachments design

Date: 2026-09-07. Status: approach A approved by Peter (main-side normalizer, staged
chips, `[Image #N]` captions, drag-and-drop included). Path images are read and attached
by the app itself (Peter's call, same day).

## 1. Problem

The panel takes text only. The interactive CLI lets the operator paste a clipboard image
or an image path and refer to it as `[Image #1]`; the buddy should do the same. Paste a
screenshot from a snip, a file copied in Explorer, or a pasted path; see it staged next to
the text box; and have the magos see it, whether the paste starts a turn or lands
mid-rite. A pasted path is read by the app for any folder, rather than left to the CLI's
Read tool, which raises a Sanction card for every path outside the workspace and its
extra dirs.

## 2. Measured CLI behaviour

The docs (checked 2026-09-07) document the image content block for the Messages API
(base64 with a media type, or a URL, or a Files API id) but not the stream-json stdin
schema, and nothing says whether stdin takes content arrays. Measured against the
installed claude.exe (2.1.261) launched as
`-p --input-format stream-json --output-format stream-json --verbose --model haiku --tools ''`,
with a 300x120 PNG of three coloured squares over the text MAGOS 42:

1. A user line whose `message.content` is the array
   `[{type:'text',text},{type:'image',source:{type:'base64',media_type:'image/png',data}}]`
   is accepted; the model named the colours and read the text.
2. The same array written as a second user line after a text prompt (the steer path) is
   accepted and answered as its own turn with the same description.
3. The output stream now carries `system` lines with subtype `thinking_tokens` (two per
   turn) alongside `rate_limit_event` and `post_turn_summary`; all must keep parsing to
   `ignore`.

Limits from the vision docs: png, jpeg, gif and webp; 10 MB per image after base64 on the
API (5 MB on Bedrock and Vertex); images over 1568 px on the long edge are downscaled
server-side on standard models (2576 on high-resolution ones); up to 100 images per
request; animated images contribute their first frame only.

## 3. Decision: main normalizes, the panel stages chips (approach A)

The panel catches a paste or a drop and hands main either the bytes or a path. One module
in main decodes, caps the long edge, encodes, and keeps the result staged under an id. The
panel shows a chip per image until Enter, then sends the text with the ids, and main builds
one user line: each image block followed by its caption, then the operator's text. Mid-rite
the same content goes down the steer path. One normalizer serves the clipboard, paths and
drops, and the bytes cross IPC once.

Rejected, and why:

- B, renderer-side canvas normalization with the base64 travelling with the prompt. A
  pasted path still needs main to read the file, so there would be two normalizers and the
  payload would cross IPC twice.
- C, write pasted bitmaps to a temp folder and put the path in the text for the CLI to
  Read. Zero protocol work, but the temp dir needs an `--add-dir` or every paste raises a
  Sanction card, and the model has to choose to Read; it also contradicts the call on
  paths above.

## 4. Wire shape (`src/main/brain/content.ts`, `claude-cli.ts`, `echo.ts`, `types.ts`, `prompt.ts`)

- `UserContent = string | UserBlock[]`, where a `UserBlock` is
  `{ type: 'text', text }` or
  `{ type: 'image', source: { type: 'base64', media_type, data } }`.
- `buildUserContent(text, images)`: for each image, 1-based, the image block then a text
  block `[Image #N: name]`; then a text block with the operator's text when it is not
  empty. Images first follows the API's own guidance; the caption mirrors the CLI's labels
  and reads as a caption. Numbering is per message. With no images the result is the plain
  string, so every existing test keeps its wire shape.
- `Brain.respond(prompt: UserContent, ctx)` and `Brain.steer?(content: UserContent)`.
  `userLine(content)` serializes whichever it gets. Nothing else in the CLI brain changes.
- `EchoBrain` takes the text from the blocks; when images are present its reply carries
  `I see N image(s): a.png, b.png.` before the tail, so the e2e suite can assert on it.
- `toolsNote` gains one sentence: images the operator attaches arrive inline in the
  message, each followed by a caption `[Image #N: name]`; do not read them from disk again.

## 5. Image module (`src/main/images.ts`)

Types:

- `ImageAttachment { id, name, mediaType, data, width, height, bytes }`, `data` base64,
  `bytes` the encoded size before base64.
- `StagedImage { id, name, width, height, thumb }`, `thumb` a data URL for the chip.

`ImageCodec` is injectable, since unit tests run under Node without Electron:
`decode(bytes) => DecodedImage | null`, where `DecodedImage` has `width`, `height`,
`resize(maxEdge)`, `png()`, `jpeg(quality)` and `thumbnail(height)` (a data URL).
`electronCodec` wraps `nativeImage` (`createFromBuffer`, `getSize`, `resize` with quality
`best`, `toPNG`, `toJPEG`, `toDataURL`). `nativeImage` decodes PNG and JPEG only, so
`decode` returns null for gif and webp as well as for corrupt data.

`normalizeImage({ bytes, mediaType?, name }, codec)` returns
`{ ok: true, attachment, staged }` or `{ ok: false, reason }`:

1. Media type: the sniffed type when the magic bytes are recognised, else the caller's when
   it is one of the four, else `not an image`. The sniff wins over the caller's claim so a
   misnamed file (a PNG saved with a `.jpg` extension) never reaches the API labelled with
   the wrong type and fails the turn.
2. Decode. Null for png or jpeg: `cannot decode`. Null for gif or webp: pass-through, the
   bytes unchanged when at most `MAX_BYTES`, else `too large`; width and height 0, thumb
   the raw bytes as a data URL.
3. Long edge over `MAX_EDGE` (2576): resize to it, encode PNG, fall back to JPEG at
   quality 85 when the PNG is over `MAX_BYTES`, `too large` when the JPEG still is.
4. No resize needed: bytes at most `MAX_BYTES` pass through unchanged (media type and
   bytes exactly as given); otherwise encode as in step 3.
5. `MAX_EDGE` is 2576, the long edge above which the API downscales on the current
   high-resolution models, so no legible detail the API would have kept is thrown away
   (standard models downscale to 1568 on their own). Screenshots of errors are the main
   use, and a full-screen 4K capture of small text still loses detail after the API's
   own downscale, so the README recommends snipping the region. `MAX_BYTES` is 3 MB of
   encoded data (4 MB after base64, under every documented cap). Thumb is
   `thumbnail(40)`. The id is a `randomUUID`. `MAX_RAW_BYTES` (64 MB) is checked before the
   sniff or the decode even run, so a hostile or oversized paste never reaches the codec.

`loadImagePath(path, workspace, fs, codec)`: a relative path resolves against the
workspace; the extension must be `.png`, `.jpg`, `.jpeg`, `.gif` or `.webp`, case
insensitive, else `not an image file`; a missing or unreadable file is `no such file`;
then `normalizeImage` with the extension's media type and the basename as the name.

`AttachmentStore`: `stage(attachment, staged)` returns the id, or refuses beyond
`MAX_STAGED` (20) with `too many images`; `take(ids)` returns the attachments in the order
given and removes them; `discard(id)`; `clear()`. One instance, created in
`src/main/index.ts` next to the chat controller.

No config field: the caps are constants.

## 6. Path detection (`src/shared/imagePaths.ts`)

`findImagePaths(text)` returns the unique image paths in order of appearance. Forms:
quoted or bare Windows drive paths (`"C:\shots\a.png"` is what Explorer's Copy as path
puts on the clipboard); UNC paths; POSIX absolute paths; `file://` URLs, decoded, with the
drive form restored. A bare path ends at whitespace, a quote, or one of a short list of
punctuation marks. The extension test is the same list as section 5, case insensitive. The
renderer runs it on pasted text only, never on typed text.

`stageablePaths(text)` is what the renderer actually stages: `findImagePaths(text)` with
every UNC path dropped, unless the whole paste, trimmed and with one pair of surrounding
quotes stripped, is exactly that single path. A UNC path (`\\server\share\a.png`) found
inside pasted prose would otherwise be read by main the instant it is pasted, making an
outbound SMB connection to whatever host the pasted text names and offering the user's
NTLM credential hash to it; a local drive path carries no such risk. Staging only a
deliberate paste of just the UNC path keeps the detector complete (`findImagePaths` still
finds every UNC path) while closing the drive-by read.

## 7. IPC and preload (`src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc.ts`)

Channels:

- `image:stageBytes`, invoke: `{ bytes: Uint8Array, mediaType?: string, name: string }`
  to `StagedImage | { error: string }`.
- `image:stagePath`, invoke: `{ path: string }` to the same.
- `image:discard`, send: `{ id }`.
- `chat:prompt` gains `images?: string[]` (ids).

Bridge additions: `stageImageBytes(bytes, mediaType, name)`, `stageImagePath(path)`,
`discardImage(id)`, `pathForFile(file)` (the preload's `webUtils.getPathForFile`, which
works under the sandbox and returns an empty string for a File with no path), and
`prompt(text, imageIds?)`.

Main: `ipcMain.handle` for the two invokes (the first use of invoke in the codebase). The
handlers call `normalizeImage` or `loadImagePath` with the Electron codec, the Node
filesystem and `chat.status().workspace`, then `store.stage`. The `chat:prompt` handler
does `store.take(ids)` and passes the attachments to `chat.prompt`. The `ChatOut.clear`
wrapper in `src/main/index.ts` also calls `store.clear()`, so `/clear` empties the store.

## 8. Chat controller (`src/main/chat.ts`)

`prompt(text, images: ImageAttachment[] = [])`. Commands parse exactly as today; the
renderer never sends ids with a command, so chips survive a slash command. Empty text with
images is allowed and builds content with no trailing text block. Busy path:
`brain.steer?.(buildUserContent(text, images))`, else `ask(content)`. `ask` hands the
content to `respond`; the stale-resume retry resends the same content.

## 9. Panel (`src/renderer/hologram/index.html`, `main.ts`, `styles.css`)

Markup: `<div id="attachments" hidden>` between the permission card and the text box.
A chip is `.chip` holding `img.thumb` (40 px tall), `span.label` (`#N`) and
`button.remove` (×), with the file name as its title. Renderer state: `staged: StagedImage[]`.

Paste, on the text box:

1. Clipboard items of an image type: each File to bytes, `stageImageBytes` with the item's
   type and the file's name (or `pasted.png`); the event is prevented so nothing lands in
   the box.
2. Otherwise files (a file copied in Explorer): `pathForFile`, then `stageImagePath`; a
   File with an empty path goes the bytes route instead; the event is prevented.
3. Otherwise text: `findImagePaths`, `stageImagePath` for each; the text is inserted by
   the browser as usual.

Drop, on the panel: `dragover` and `drop` prevented; each file as in step 2.

Each success appends a chip and shows the strip; each refusal posts a local system line
`image: <reason>` and never blocks the text. Enter: with neither text nor chips nothing
happens; text starting with `/` takes the command path as today and leaves the chips;
otherwise the user bubble shows a row of the chips' thumbnails above the text (the text
rendered as markdown when present), `prompt(text, ids)` goes out, the chips clear and the
strip hides. Backspace in an empty box removes the last chip; × removes its chip; both call
`discardImage` and the labels renumber. `onChatClear` empties the chips; main's store is
cleared through the hook in section 7. The CSP is unchanged: `img-src` already allows
`data:`.

Style: the strip is a wrapping flex row with the same top border as the text box; a chip
is a small bordered tile in the accent colour, the label bottom-left in the title font at
11 px, the remove button top-right.

## 10. Errors

Staging refusals (`not an image`, `not an image file`, `cannot decode`, `too large`,
`no such file`, `too many images`) surface as local system lines. If the CLI rejects an
image, the result line carries the error and the existing error path posts it; nothing
new. A file deleted after staging is irrelevant: the bytes were captured at staging.

## 11. Tests

Unit (Vitest):

- `images.test.ts`, with a fake codec: every branch of `normalizeImage` (pass-through,
  resize to PNG, JPEG fallback, too large, not an image, cannot decode, gif pass-through,
  gif too large), type sniffing, `loadImagePath` (relative resolution against the
  workspace, extension gate, missing file), and the store (stage, take in the order asked,
  discard, clear, cap).
- `imagePaths.test.ts`: each form, dedupe, a non-image extension ignored, a path inside a
  sentence, a quoted path with spaces.
- `content.test.ts`: block order and captions, empty text, no images gives a string;
  `userLine` serializes an array.
- `chat.test.ts`: a prompt with images hands the brain the built array; busy hands it to
  `steer`; the stale-resume retry resends it.
- `echo.test.ts`: the images sentence. `prompt.test.ts`: the note mentions attachments.
- `stream.test.ts`: a `system` line with subtype `thinking_tokens` parses to `ignore`.
- `claude-cli.test.ts` against `test/fake-claude.cjs`: the prompt reaches the fake as an
  array; a steer does too. The fake's `userText` returns the joined text blocks and the
  image count, and a new scenario `images` replies `images=N names=...`.

End to end (`e2e/images.spec.ts`, fake brain, scenario `images`, a fixture PNG under
`test/fixtures/`):

1. A synthetic paste (a `ClipboardEvent` whose `DataTransfer` holds a File built from the
   fixture's base64 in `page.evaluate`) shows a chip; Enter; the reply contains `images=1`
   and the user bubble holds an `img`.
2. Pasting the fixture's absolute path as text shows a chip and the text stays in the box.
3. A synthetic drop of the fixture (no path, so the bytes route) shows a chip.

Manual: this session's probe becomes `scripts/smoke-image.mjs`, run by hand like
`smoke:claude`, sending the fixture as the prompt and as a second line and printing both
result texts; it is the only thing that spends quota.

## 12. README

The panel section gains a short paragraph: paste an image (Win+Shift+S, then Ctrl+V in the
panel), a file copied in Explorer, or an image path, or drop a file on the panel; each shows
a chip and reaches him as `[Image #N]`. For small text it recommends snipping the region
rather than the whole screen.

## 13. Out of scope

Images from him back to the operator, cropping or OCR in the app, a config knob for the
caps, the Files API, keeping thumbnails across restarts, reading the clipboard from main,
and a per-session image numbering like the CLI's.

The embedded CLI tab and the `/cli` terminal hand-off are sibling sub-projects with their own
specs; the chat tab keeps this design unchanged.
