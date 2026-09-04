import { renderMarkdown } from './markdown'
import { ProjectionCone } from './cone'
import { HoloFace } from './face'
import type { ChatDonePayload, ChatPermissionPayload, ChatSystemPayload, PackLoadedPayload, ThemePayload } from '../../shared/ipc'
import type { Atlas, Expression } from '../../shared/types'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const log = $<HTMLDivElement>('log'), input = $<HTMLTextAreaElement>('input'), status = $<HTMLSpanElement>('status')
const perm = $<HTMLDivElement>('permission'), permLine = $<HTMLDivElement>('perm-line'), permDetail = $<HTMLDivElement>('perm-detail')
const panel = $<HTMLDivElement>('panel'), coneCanvas = $<HTMLCanvasElement>('cone')
const cone = new ProjectionCone(coneCanvas)

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
function flush(): void {
  renderQueued = false
  if (current) {
    const text = current.querySelector('.text') as HTMLElement | null
    if (text) text.innerHTML = renderMarkdown(buffer)
    log.scrollTop = log.scrollHeight
  }
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
})
window.buddy.onChatDelta(({ text }) => {
  if (!current) { current = add('buddy', ''); buffer = '' }
  buffer += text
  if (!renderQueued) { renderQueued = true; requestAnimationFrame(flush) }
})
window.buddy.onChatActivity((a) => {
  let el = activities.get(a.id)
  if (!el) {
    // An activity row can be the very first thing a turn produces, before any text delta -
    // it must create (and keep) the reply bubble itself, or the text that follows would
    // create a second, separate bubble and leave this one permanently empty.
    if (!current) { current = add('buddy', ''); buffer = '' }
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
  if (current) renderFaceInto(current, p.expression ?? 'neutral')
  current = null; buffer = ''; activities.clear()
})
window.buddy.onChatSystem(({ text, expression }: ChatSystemPayload) => {
  current = null
  const el = add('system', renderMarkdown(text))
  renderFaceInto(el, expression ?? 'neutral')
})
window.buddy.onChatPermission((p) => {
  // A dismiss means the server's own timeout already answered this request on the wire: hide
  // the card if it is still showing that same (now stale) request. Ignore it otherwise - the
  // user may already have answered and a new, unrelated request could be showing by now.
  if (p.dismiss) { if (pending?.id === p.id) { pending = null; perm.hidden = true }; return }
  pending = p; permLine.textContent = p.line ?? ''; permDetail.textContent = `${p.toolName ?? ''}: ${p.summary ?? ''}`; perm.hidden = false
})
const answer = (allow: boolean) => { if (!pending) return; window.buddy.permissionAnswer(pending.id, allow); pending = null; perm.hidden = true }
$('perm-allow').addEventListener('click', () => answer(true))
$('perm-deny').addEventListener('click', () => answer(false))

input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); if (pending) answer(false); else window.buddy.closePanel(); return }
  if (e.key === 'ArrowUp' && input.value === '') { input.value = lastInput; return }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) return
    lastInput = text; input.value = ''
    if (!text.startsWith('/')) add('user', renderMarkdown(text))
    current = null
    window.buddy.prompt(text)
  }
})
window.addEventListener('focus', () => input.focus())
window.buddy.hologramReady()
input.focus()
