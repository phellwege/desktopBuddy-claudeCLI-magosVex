import { renderMarkdown } from './markdown'
import { grownHeight } from './compose'
import { ProjectionCone } from './cone'
import { HoloFace } from './face'
import type { ChatDonePayload, ChatPermissionPayload, ChatReadbackPayload, ChatSystemPayload, PackLoadedPayload, ThemePayload } from '../../shared/ipc'
import type { Atlas, Expression } from '../../shared/types'
import { findImagePaths } from '../../shared/imagePaths'
import type { StageResult } from '../../shared/ipc'
import type { StagedImage } from '../../shared/images'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const log = $<HTMLDivElement>('log'), input = $<HTMLTextAreaElement>('input'), status = $<HTMLSpanElement>('status')
const perm = $<HTMLDivElement>('permission'), permLine = $<HTMLDivElement>('perm-line'), permDetail = $<HTMLDivElement>('perm-detail')
const panel = $<HTMLDivElement>('panel'), coneCanvas = $<HTMLCanvasElement>('cone')
const strip = $<HTMLDivElement>('attachments')
// Chips waiting under the log, in send order. Main holds the bytes; this is ids and thumbs.
let staged: StagedImage[] = []
const cone = new ProjectionCone(coneCanvas)
const LINE_PX = parseFloat(getComputedStyle(input).lineHeight) || 18
function growInput(): void { input.style.height = 'auto'; input.style.height = `${grownHeight(input.scrollHeight, LINE_PX)}px` }

function sizeCone(): void {
  coneCanvas.width = window.innerWidth
  coneCanvas.height = window.innerHeight
  cone.setTarget(panel.getBoundingClientRect())
}
sizeCone()
window.addEventListener('resize', sizeCone)

document.addEventListener('visibilitychange', () => { if (document.hidden) cone.stop(); else cone.start() })
if (!document.hidden) cone.start()

let hoveringPanel = false
function isOverPanel(x: number, y: number): boolean {
  const r = panel.getBoundingClientRect()
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}
window.addEventListener('mousemove', (e) => {
  const over = isOverPanel(e.clientX, e.clientY)
  if (over !== hoveringPanel) { hoveringPanel = over; window.buddy.hologramHover(over) }
})
document.addEventListener('mouseleave', () => { if (hoveringPanel) { hoveringPanel = false; window.buddy.hologramHover(false) } })
let current: HTMLDivElement | null = null
let buffer = ''
let renderQueued = false
let lastInput = ''
let pending: ChatPermissionPayload | null = null
const activities = new Map<string, HTMLDivElement>()
// Whether main will follow replies with a readback (from chat:status). Decides whether a
// new reply bubble starts in the waiting state.
let readbackOn = false
// Bubbles waiting for their readback, by message id. Cleared when it lands, fails, or after
// 60 s (the fallback settles the bubble to plain text; it must outlast the readback
// call's own 45 s timeout in src/main/brain/readback.ts, which reports failure itself).
const awaitingReadback = new Map<number, { bubble: HTMLDivElement; timer: number }>()
// Reply bubbles of the in-flight turn. A system line (an error line, the stopped line, a
// CLI status line) clears `current` so later text starts a fresh bubble under it, but every
// bubble the turn created still has to settle at done, or a waiting bubble would keep its
// dots forever over hidden text. This list survives until done.
let turnReplies: HTMLDivElement[] = []

let atlas: Atlas | null = null
let atlasImage: HTMLImageElement | null = null
let facesMap: Record<Expression, string> | null = null
let accent = '#37c4ff'
let holoFace: HoloFace | null = null
// Bubbles that recorded an expression (via renderFaceInto) before the atlas had finished
// loading, so they never got a .face-slot at all. Their text is never touched again ("old
// messages never change"), but once the atlas is ready we still owe them the face they
// recorded - stamped on once, here, rather than never.
const pendingFaces: { bubble: HTMLDivElement; expression: Expression }[] = []

function rebuildFace(): void {
  holoFace = (atlas && atlasImage && facesMap) ? new HoloFace(atlasImage, atlas, facesMap, accent) : null
  if (holoFace && pendingFaces.length) {
    const backlog = pendingFaces.splice(0, pendingFaces.length)
    for (const { bubble, expression } of backlog) renderFaceInto(bubble, expression)
  }
}

// Same blob-URL loader the overlay window uses (src/renderer/overlay/main.ts): fetching
// through the pack:// protocol and decoding via an object URL avoids CORS/canvas taint
// issues a bare <img src="pack://..."> can hit in some Electron configurations.
async function loadImage(url: string): Promise<HTMLImageElement> {
  const blob = await (await fetch(url)).blob()
  const objectUrl = URL.createObjectURL(blob)
  try {
    const im = new Image()
    await new Promise<void>((res, rej) => { im.onload = () => res(); im.onerror = () => rej(new Error(`image failed: ${url}`)); im.src = objectUrl })
    return im
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
  }
}

function add(cls: string, html: string): HTMLDivElement {
  const el = document.createElement('div'); el.className = `msg ${cls}`
  if (holoFace && (cls === 'buddy' || cls === 'system')) {
    const slot = document.createElement('div'); slot.className = 'face-slot'
    el.appendChild(slot)
  }
  const text = document.createElement('div'); text.className = 'text'; text.innerHTML = html
  el.appendChild(text)
  log.appendChild(el); log.scrollTop = log.scrollHeight; return el
}
function renderChips(): void {
  strip.replaceChildren()
  staged.forEach((s, i) => {
    const chip = document.createElement('div'); chip.className = 'chip'; chip.title = s.name
    const im = document.createElement('img'); im.src = s.thumb; im.alt = s.name
    const label = document.createElement('span'); label.className = 'label'; label.textContent = `#${i + 1}`
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove'; remove.textContent = '×'; remove.title = 'remove'
    remove.addEventListener('click', () => {
      staged = staged.filter(x => x.id !== s.id)
      window.buddy.discardImage(s.id)
      renderChips(); input.focus()
    })
    chip.append(im, label, remove)
    strip.appendChild(chip)
  })
  strip.hidden = staged.length === 0
  log.scrollTop = log.scrollHeight
}
// A refusal is a local system line; it never blocks the text (spec 10).
function accept(r: StageResult): void {
  if ('error' in r) { current = null; add('system', renderMarkdown(`image: ${r.error}`)); return }
  staged.push(r)
  renderChips()
}
// A File with a path (copied in Explorer, dropped) goes by path so main reads and names it;
// one without (a snip on the clipboard, a synthetic File in tests) goes by bytes.
async function stageFile(file: File): Promise<void> {
  const path = window.buddy.pathForFile(file)
  const r = path
    ? await window.buddy.stageImagePath(path)
    : await window.buddy.stageImageBytes(new Uint8Array(await file.arrayBuffer()), file.type || undefined, file.name || 'pasted.png')
  accept(r)
}
// The operator's bubble: thumbnails above the text, either part optional.
function addUser(text: string, thumbs: string[]): void {
  const el = add('user', text ? renderMarkdown(text) : '')
  if (!text) el.querySelector('.text')?.remove()
  if (thumbs.length) {
    const row = document.createElement('div'); row.className = 'thumbs'
    for (const t of thumbs) { const im = document.createElement('img'); im.src = t; row.appendChild(im) }
    el.insertBefore(row, el.firstChild)
  }
  log.scrollTop = log.scrollHeight
}
// A reply bubble, started in the waiting state (dots, hidden .plain) when main told us
// (chat:status) that this reply will be followed by a readback.
function newReply(): HTMLDivElement {
  const bubble = add('buddy', '')
  turnReplies.push(bubble)
  if (readbackOn) {
    const textEl = bubble.querySelector('.text') as HTMLElement
    const dots = document.createElement('div'); dots.className = 'dots'
    for (let i = 0; i < 3; i++) dots.appendChild(document.createElement('span'))
    const plain = document.createElement('div'); plain.className = 'plain'; plain.hidden = true
    textEl.append(dots, plain)
    bubble.classList.add('waiting')
  }
  return bubble
}
// Where the streamed reply text renders: a waiting bubble's hidden .plain, or .text directly.
function replyTarget(bubble: HTMLDivElement): HTMLElement | null {
  return (bubble.querySelector('.plain') as HTMLElement | null) ?? (bubble.querySelector('.text') as HTMLElement | null)
}
function flush(): void {
  renderQueued = false
  if (current) {
    const target = replyTarget(current)
    if (target) target.innerHTML = renderMarkdown(buffer)
    log.scrollTop = log.scrollHeight
  }
}
function settlePlain(bubble: HTMLDivElement): void {
  // Readback failed, timed out, or the turn errored: show the plain text, no arrow.
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 4
  bubble.querySelector('.dots')?.remove()
  const plain = bubble.querySelector('.plain') as HTMLElement | null
  if (plain) plain.hidden = false
  bubble.classList.remove('waiting')
  if (atBottom) log.scrollTop = log.scrollHeight
}
function settleReadback(bubble: HTMLDivElement, text: string): void {
  const textEl = bubble.querySelector('.text') as HTMLElement | null
  if (!textEl) return
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 4
  bubble.querySelector('.dots')?.remove()
  let plain = bubble.querySelector('.plain') as HTMLElement | null
  if (!plain) {
    // Not created in the waiting state (readback was switched on mid-session): fold the
    // rendered reply as-is so highlighted code and links-as-text stay intact.
    plain = document.createElement('div'); plain.className = 'plain'
    while (textEl.firstChild) plain.appendChild(textEl.firstChild)
    textEl.appendChild(plain)
  }
  plain.hidden = true
  const headline = document.createElement('div'); headline.className = 'readback'
  headline.innerHTML = renderMarkdown(text)
  // A bare arrow (Peter's call): no label, a tooltip carries the meaning.
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'plain-toggle'
  toggle.title = 'plain text'
  const label = (): void => {
    toggle.textContent = plain!.hidden ? '▾' : '▴'
    toggle.setAttribute('aria-label', plain!.hidden ? 'show plain text' : 'hide plain text')
  }
  label()
  toggle.addEventListener('click', () => { plain!.hidden = !plain!.hidden; label() })
  textEl.insertBefore(toggle, plain)
  textEl.insertBefore(headline, toggle)
  bubble.classList.remove('waiting')
  if (atBottom) log.scrollTop = log.scrollHeight
}
function renderFaceInto(bubble: HTMLDivElement, expression: Expression): void {
  if (!holoFace) { pendingFaces.push({ bubble, expression }); return }
  let slot = bubble.querySelector('.face-slot') as HTMLElement | null
  if (!slot) {
    // This bubble was created before the atlas finished loading, so add() never gave it a
    // face-slot at all; add one now, in the same spot add() would have (before the text).
    slot = document.createElement('div'); slot.className = 'face-slot'
    bubble.insertBefore(slot, bubble.querySelector('.text'))
  }
  slot.appendChild(holoFace.render(expression))
}

window.buddy.onTheme((t: ThemePayload) => {
  const r = document.documentElement.style
  r.setProperty('--accent', t.accent); r.setProperty('--glow', t.glow); r.setProperty('--bg', t.background)
  r.setProperty('--text', t.text); r.setProperty('--font', t.font)
  $('name').textContent = t.name
  cone.setColor(t.accent)
  accent = t.accent
  rebuildFace()
})
window.buddy.onPackLoaded(async (p: PackLoadedPayload) => {
  facesMap = p.faces
  if (!p.faces) { atlas = null; atlasImage = null; rebuildFace(); return }
  atlas = await (await fetch(p.atlasJsonUrl)).json() as Atlas
  atlasImage = await loadImage(p.atlasUrl)
  rebuildFace()
})
window.buddy.onOrigin((p) => cone.setSource(p.x, p.y))
window.buddy.onChatStatus((s) => {
  status.textContent = `${s.model ?? 'default'} · ${s.workspace} · ${s.session}${s.error ? ' · ' + s.error : ''}`
  readbackOn = s.readback === true
})
window.buddy.onChatDelta(({ text }) => {
  if (!current) { current = newReply(); buffer = '' }
  buffer += text
  if (!renderQueued) { renderQueued = true; requestAnimationFrame(flush) }
})
window.buddy.onChatActivity((a) => {
  let el = activities.get(a.id)
  if (!el) {
    // An activity row can be the very first thing a turn produces, before any text delta -
    // it must create (and keep) the reply bubble itself, or the text that follows would
    // create a second, separate bubble and leave this one permanently empty.
    if (!current) { current = newReply(); buffer = '' }
    el = document.createElement('div'); el.className = 'activity'; activities.set(a.id, el)
    current.insertAdjacentElement('afterend', el)
  }
  // The tool_result event that marks a row done carries no label of its own (stream.ts's
  // parseUser always emits label: ''); keep the running label visible instead of blanking
  // the row out right as it finishes.
  if (a.label) el.textContent = a.label
  if (a.done) el.classList.add('done')
})
window.buddy.onChatDone((p: ChatDonePayload) => {
  flush()
  // The face and the readback belong to the turn's last reply bubble, even when a system
  // line landed after it; every earlier bubble of the same turn settles to plain text.
  const last = turnReplies.at(-1) ?? null
  if (last) renderFaceInto(last, p.expression ?? 'neutral')
  for (const bubble of turnReplies) {
    if (bubble !== last || p.error || !p.readback) { settlePlain(bubble); continue }
    const timer = window.setTimeout(() => { awaitingReadback.delete(p.id); settlePlain(bubble) }, 60000)
    awaitingReadback.set(p.id, { bubble, timer })
  }
  turnReplies = []; current = null; buffer = ''; activities.clear()
})
window.buddy.onChatReadback(({ id, text, failed }: ChatReadbackPayload) => {
  const entry = awaitingReadback.get(id)
  if (!entry) return
  awaitingReadback.delete(id); clearTimeout(entry.timer)
  if (failed || !text) settlePlain(entry.bubble)
  else settleReadback(entry.bubble, text)
})
window.buddy.onChatSystem(({ text, expression }: ChatSystemPayload) => {
  current = null
  const el = add('system', renderMarkdown(text))
  renderFaceInto(el, expression ?? 'neutral')
})
window.buddy.onChatClear(() => {
  log.replaceChildren()
  current = null
  buffer = ''
  turnReplies = []
  for (const { timer } of awaitingReadback.values()) clearTimeout(timer)
  awaitingReadback.clear()
  activities.clear()
  pendingFaces.length = 0
  staged = []
  renderChips()
  // Dismiss any pending permission card without answering it: the server's own timeout will
  // deny the request on the wire in due course, same as if the user had just ignored it.
  if (pending) { pending = null; perm.hidden = true }
})
window.buddy.onChatPermission((p) => {
  // A dismiss means the server's own timeout already answered this request on the wire: hide
  // the card if it is still showing that same (now stale) request. Ignore it otherwise - the
  // user may already have answered and a new, unrelated request could be showing by now.
  if (p.dismiss) { if (pending?.id === p.id) { pending = null; perm.hidden = true }; return }
  pending = p; permLine.textContent = p.line ?? ''; permDetail.textContent = `${p.toolName ?? ''}: ${p.summary ?? ''}`; perm.hidden = false
})
const answer = (allow: boolean, remember = false) => { if (!pending) return; window.buddy.permissionAnswer(pending.id, allow, remember); pending = null; perm.hidden = true }
$('perm-allow').addEventListener('click', () => answer(true))
$('perm-session').addEventListener('click', () => answer(true, true))
$('perm-deny').addEventListener('click', () => answer(false))

input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); if (pending) answer(false); else window.buddy.closePanel(); return }
  if (e.key === 'ArrowUp' && input.value === '') { input.value = lastInput; growInput(); return }
  if (e.key === 'Backspace' && input.value === '' && staged.length) {
    e.preventDefault()
    const last = staged.pop()
    if (last) window.buddy.discardImage(last.id)
    renderChips()
    return
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    const text = input.value.trim()
    if (!text && staged.length === 0) return
    if (text.startsWith('/')) {
      // A command never consumes the chips.
      lastInput = text; input.value = ''; growInput()
      current = null
      window.buddy.prompt(text)
      return
    }
    if (text) lastInput = text
    input.value = ''; growInput()
    addUser(text, staged.map(s => s.thumb))
    current = null
    window.buddy.prompt(text, staged.map(s => s.id))
    staged = []
    renderChips()
  }
})
// Paste, in order of preference: bitmap items (a snip), files (copied in Explorer), then
// image paths inside pasted text, which the browser still inserts into the box.
input.addEventListener('paste', (e) => {
  const dt = e.clipboardData
  if (!dt) return
  const imageItems = Array.from(dt.items).filter(i => i.kind === 'file' && i.type.startsWith('image/'))
  if (imageItems.length) {
    e.preventDefault()
    for (const item of imageItems) { const f = item.getAsFile(); if (f) void stageFile(f) }
    return
  }
  if (dt.files.length) {
    e.preventDefault()
    for (const f of Array.from(dt.files)) void stageFile(f)
    return
  }
  for (const p of findImagePaths(dt.getData('text/plain'))) void window.buddy.stageImagePath(p).then(accept)
})
panel.addEventListener('dragover', (e) => e.preventDefault())
panel.addEventListener('drop', (e) => {
  e.preventDefault()
  for (const f of Array.from(e.dataTransfer?.files ?? [])) void stageFile(f)
})
input.addEventListener('input', growInput)
window.addEventListener('focus', () => input.focus())
window.buddy.hologramReady()
// One-time hint that the OS dictation shortcut types into this box. Once per machine:
// local storage is per Chromium profile, which is per userData dir.
const NORMAL_PLACEHOLDER = 'Speak, operator. /help for rites.'
function dictationHint(): string | null {
  try {
    if (localStorage.getItem('hint.dictation')) return null
    localStorage.setItem('hint.dictation', '1')
  } catch { return null }
  const mac = /Macintosh|Mac OS/.test(navigator.userAgent)
  return mac ? 'Speak, operator. Double-tap your dictation key to dictate. /help for rites.'
             : 'Speak, operator. Win+H to dictate. /help for rites.'
}
input.placeholder = dictationHint() ?? NORMAL_PLACEHOLDER
input.focus()
