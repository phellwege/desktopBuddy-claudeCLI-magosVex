import { Animator } from './animator'
import { Motion } from './motion'
import { HitTester } from './hittest'
import { originScreenPosition } from './origin'
import { headPoint, trailDots, trailStart, type Rect, type Side } from './thought'
import type { Atlas, AtlasFrame } from '../../shared/types'
import type { BuddyStatePayload, OverlayMutterPayload, PackLoadedPayload, StagePayload } from '../../shared/ipc'

const canvas = document.getElementById('buddy') as HTMLCanvasElement
const ctx = canvas.getContext('2d')!
const mutterEl = document.getElementById('mutter') as HTMLDivElement
const mutterWrap = document.getElementById('mutter-wrap') as HTMLDivElement
const dotEls = [document.getElementById('mutter-dot-big'), document.getElementById('mutter-dot-small')] as HTMLDivElement[]
const motion = new Motion(0, 0)
const hit = new HitTester()
let atlas: Atlas | null = null
let image: HTMLImageElement | null = null
let animator: Animator | null = null
let scale = 1
let hovering = false
let lastState: BuddyStatePayload | null = null
let hitFrame = ''
let drawn: { f: AtlasFrame; mirror: boolean } | null = null
// The canvas keeps its pixels between frames, so the paint only needs to happen when the
// animation frame or facing changes (a few times a second at idle, not every vsync). Set
// whenever the canvas is resized, which clears it.
let redrawNeeded = true
let lastOrigin: { x: number; y: number } | null = null
// The frame's actual drawn rect within the canvas (the canvas is the full character cell,
// but the trimmed sprite inside it is usually smaller and off-centre), so the mutter bubble
// can anchor on his real pixels instead of floating off the canvas box. Zero width means
// nothing has drawn yet; placeMutter falls back to the canvas box in that case.
let drawnRect = { x: 0, y: 0, w: 0, h: 0 }

async function loadImage(url: string): Promise<HTMLImageElement> {
  const blob = await (await fetch(url)).blob()
  const objectUrl = URL.createObjectURL(blob)
  try {
    const im = new Image()
    await new Promise<void>((res, rej) => { im.onload = () => res(); im.onerror = () => rej(new Error(`image failed: ${url}`)); im.src = objectUrl })
    return im
  } finally {
    // the decoded image keeps its pixels; the URL can go
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
  }
}
// Where this window sits on the virtual desktop and which display's floor he rests on.
// Until the first stage arrives, fall back to treating the window as its own display so a
// state message that beats it still draws something sane.
let stage: StagePayload | null = null
const stageOrigin = () => stage?.origin ?? { x: window.screenX, y: window.screenY }
const restWa = () => stage?.wa ?? { x: window.screenX, y: window.screenY, width: window.innerWidth, height: window.innerHeight }
const charW = () => stage?.charW ?? canvas.width

// The floor-center point for a 0..1 fraction of the resting display, matching the walk
// band in src/main/displays.ts: half a character in from each edge.
function restingPoint(fraction: number): { x: number; y: number } {
  const wa = restWa(), half = charW() / 2
  const min = wa.x + half, max = Math.max(min, wa.x + wa.width - half)
  return { x: min + fraction * (max - min), y: wa.y + wa.height }
}

// His live x as a fraction of the resting display, for the hologram to track mid-walk.
// Buddy.x only updates on arrival, so main needs this to follow him rather than waiting.
function liveFraction(): number {
  const wa = restWa(), half = charW() / 2
  const min = wa.x + half, max = wa.x + wa.width - half
  return max <= min ? 0 : Math.min(1, Math.max(0, (motion.vx - min) / (max - min)))
}

// Positions are absolute virtual pixels; CSS transforms are window-relative. The canvas
// bottom sits on the floor point (the 4 px baseline inset lives inside the canvas, so this
// draws identically to the old bottom-anchored strip), centred on his x.
const place = (): void => {
  const o = stageOrigin()
  const left = motion.vx - o.x - canvas.width / 2
  const top = motion.vy - o.y - canvas.height
  canvas.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
  placeMutter(left, top)
}

let mutterVisible = false
let mutterTtlTimer: ReturnType<typeof setTimeout> | undefined
let mutterFadeTimer: ReturnType<typeof setTimeout> | undefined

// Beside his head: above the canvas if the window (the bottom strip, usually) has room for
// the bubble there, otherwise to whichever side of the canvas has more room. Re-run from
// place() on every frame he might be walking through, so the bubble tracks him. The two
// lead-in dots are then laid on the line from the bubble's near edge to his head
// (thought.ts), so they stay on him even when the bubble is clamped away by a window edge.
function placeMutter(canvasLeft: number, canvasTop: number): void {
  if (!mutterVisible) return
  const bw = mutterEl.offsetWidth
  const bh = mutterEl.offsetHeight
  const winW = window.innerWidth
  const winH = window.innerHeight
  // Anchor on his actual drawn pixels, not the full character cell, so the bubble sits
  // close to him instead of floating off toward the cell's empty margin. Before the first
  // draw (drawnRect.w is 0) fall back to the canvas box.
  const haveDrawn = drawnRect.w > 0
  const drawn: Rect = haveDrawn
    ? { x: canvasLeft + drawnRect.x, y: canvasTop + drawnRect.y, w: drawnRect.w, h: drawnRect.h }
    : { x: canvasLeft, y: canvasTop, w: canvas.width, h: canvas.height }
  let bubble: Rect
  let side: Side
  const aboveTop = drawn.y - bh - 4
  if (aboveTop >= 0) {
    const left = Math.min(Math.max(0, drawn.x + drawn.w / 2 - bw / 2), Math.max(0, winW - bw))
    bubble = { x: left, y: aboveTop, w: bw, h: bh }
    side = 'above'
  } else {
    const top = Math.min(Math.max(0, drawn.y + 6), Math.max(0, winH - bh))
    const roomLeft = canvasLeft
    const roomRight = winW - (canvasLeft + canvas.width)
    if (roomRight >= roomLeft) {
      bubble = { x: Math.min(drawn.x + drawn.w + 4, Math.max(0, winW - bw)), y: top, w: bw, h: bh }
      side = 'right'
    } else {
      bubble = { x: Math.max(0, drawn.x - bw - 4), y: top, w: bw, h: bh }
      side = 'left'
    }
  }
  mutterEl.style.transform = `translate(${Math.round(bubble.x)}px, ${Math.round(bubble.y)}px)`
  const head = headPoint(drawn)
  const dots = trailDots(trailStart(bubble, side, head), head)
  dots.forEach((d, i) => {
    const el = dotEls[i]
    if (!el) return
    const r = d.size / 2
    const cx = Math.min(Math.max(r, d.x), Math.max(r, winW - r))
    const cy = Math.min(Math.max(r, d.y), Math.max(r, winH - r))
    el.style.transform = `translate(${Math.round(cx - r)}px, ${Math.round(cy - r)}px)`
  })
}

// Hidden immediately, no fade: used when a buddy state says he is no longer somewhere a
// thought bubble makes sense (asleep, panel open, dragging, mid-journey), and on click.
function hideMutterAtOnce(): void {
  if (mutterTtlTimer !== undefined) { clearTimeout(mutterTtlTimer); mutterTtlTimer = undefined }
  if (mutterFadeTimer !== undefined) { clearTimeout(mutterFadeTimer); mutterFadeTimer = undefined }
  mutterVisible = false
  mutterWrap.classList.remove('visible')
  mutterWrap.hidden = true
}

// Its ttl ran out on its own: fade out over the same 300ms as the entrance, then hide for
// real (display: none, via the hidden attribute) once the transition has had time to run.
function fadeOutMutter(): void {
  mutterVisible = false
  mutterWrap.classList.remove('visible')
  mutterFadeTimer = setTimeout(() => { mutterWrap.hidden = true; mutterFadeTimer = undefined }, 300)
}

function showMutter(text: string, ttlMs: number): void {
  if (mutterTtlTimer !== undefined) clearTimeout(mutterTtlTimer)
  if (mutterFadeTimer !== undefined) { clearTimeout(mutterFadeTimer); mutterFadeTimer = undefined }
  mutterEl.textContent = text
  mutterWrap.hidden = false
  mutterVisible = true
  place()
  void mutterEl.offsetWidth // force a reflow so the opacity transition below actually runs
  mutterWrap.classList.add('visible')
  mutterTtlTimer = setTimeout(fadeOutMutter, ttlMs)
}

function layout(): void {
  if (!atlas) return
  canvas.width = Math.ceil(atlas.maxFrameSize[0] * scale)
  canvas.height = Math.ceil(atlas.maxFrameSize[1] * scale)
  redrawNeeded = true
  place()
}

function apply(s: BuddyStatePayload): void {
  if (!animator) return
  // A thought bubble makes no sense once he is asleep, mid-journey, held, or behind the
  // panel: drop it at once rather than let it linger over whatever he does next.
  if (mutterVisible && (s.state.panelOpen || s.state.asleep || s.state.dragging || s.state.leg)) hideMutterAtOnce()
  animator.setFacing(s.state.facing)
  animator.set(s.animation)
  // Held: the pointer owns his position, so drop any target and leave motion where the
  // mousemove handler put it. Without this the state message that announces the drag would
  // snap him back to his last resting spot.
  // Landing mid-journey: he is already at the flight's endpoint; re-targeting it would
  // report a second arrival and skip the next leg.
  if (s.state.dragging || s.state.landing) { motion.setTarget(undefined, 0); place(); return }
  // A journey leg carries its own endpoint in virtual pixels and may end on another
  // display; a plain move or a wander is still a fraction of the display he is on.
  if (s.state.leg) motion.setTarget(s.state.leg.to, s.speed)
  else if (s.state.targetX !== undefined) motion.setTarget(restingPoint(s.state.targetX), s.speed)
  else { const p = restingPoint(s.state.x); motion.place(p.x, p.y) }
  place()
}

window.buddy.onOverlayStage((p: StagePayload) => {
  stage = p
  // Re-anchor a resting character onto the new stage; one mid-flight keeps its virtual
  // position untouched, which is the whole point of absolute coordinates.
  // A body being carried is not resting either: re-anchoring it would snap him to the
  // floor the instant the stage grows for the drag.
  if (lastState && !lastState.state.leg && lastState.state.targetX === undefined && !lastState.state.dragging) {
    const at = restingPoint(lastState.state.x)
    motion.place(at.x, at.y)
  }
  place()
})

window.buddy.onPackLoaded(async (p: PackLoadedPayload) => {
  atlas = await (await fetch(p.atlasJsonUrl)).json() as Atlas
  image = await loadImage(p.atlasUrl)
  scale = p.scale
  animator = new Animator(p.animations)
  layout()
  if (lastState) apply(lastState)
})
window.buddy.onBuddyState((s) => { lastState = s; apply(s) })
window.buddy.onOverlayMutter((p: OverlayMutterPayload) => { showMutter(p.text, p.ttlMs) })
window.addEventListener('resize', layout)

const missingFrames = new Set<string>()

function draw(): void {
  if (!animator || !atlas || !image) return
  const { frame: name, mirror } = animator.current()
  const f = atlas.frames[name]
  if (!f) {
    // A missing frame used to leave the overlay silently blank; say so once per name so
    // the renderer log explains an invisible character.
    if (!missingFrames.has(name)) { missingFrames.add(name); console.warn(`overlay: atlas has no frame "${name}"`) }
    return
  }
  // Paint only when something visible changed. Position changes move the canvas element
  // (place()), not its pixels, so an unchanged frame and facing means the pixels are
  // already right. The origin report below still runs every frame: the skull's screen
  // position moves with the canvas even when the picture does not.
  if (redrawNeeded || !drawn || drawn.f !== f || drawn.mirror !== mirror) {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const baselineY = canvas.height - 4
    const dx = canvas.width / 2 - f.ax * scale
    const dy = baselineY - f.ay * scale
    drawnRect = { x: mirror ? canvas.width - dx - f.w * scale : dx, y: dy, w: f.w * scale, h: f.h * scale }
    ctx.save()
    if (mirror) { ctx.translate(canvas.width, 0); ctx.scale(-1, 1) }
    ctx.drawImage(image, f.x, f.y, f.w, f.h, dx, dy, f.w * scale, f.h * scale)
    ctx.restore()
    if (name !== hitFrame) { hit.update(image, f); hitFrame = name }
    drawn = { f, mirror }
    redrawNeeded = false
  }
  if (lastState?.state.panelOpen) {
    const p = originScreenPosition(f, mirror, scale, canvas, canvas.getBoundingClientRect(), { x: window.screenX, y: window.screenY })
    if (p && (!lastOrigin || Math.abs(p.x - lastOrigin.x) >= 1 || Math.abs(p.y - lastOrigin.y) >= 1)) {
      lastOrigin = p
      window.buddy.origin(p.x, p.y, liveFraction())
    }
  } else {
    // Reset so the first frame after reopening the panel reports again.
    lastOrigin = null
  }
}

let last = performance.now()
function tick(now: number): void {
  const dt = Math.min(100, now - last); last = now
  if (animator) {
    const m = motion.advance(dt)
    if (m.arrived || motion.target !== undefined) place()
    if (m.arrived) window.buddy.arrived()
    if (animator.advance(dt).justFinished) window.buddy.oneShotDone()
    draw()
  }
  requestAnimationFrame(tick)
}
requestAnimationFrame(tick)

function isOver(clientX: number, clientY: number): boolean {
  if (!drawn) return false
  const r = canvas.getBoundingClientRect()
  const lx = clientX - r.left, ly = clientY - r.top
  const { f, mirror } = drawn
  const baselineY = canvas.height - 4
  const left = mirror ? canvas.width / 2 - (f.w - f.ax) * scale : canvas.width / 2 - f.ax * scale
  const top = baselineY - f.ay * scale
  let fx = (lx - left) / scale
  const fy = (ly - top) / scale
  if (mirror) fx = f.w - fx
  return hit.hit(fx, fy)
}

// The window only receives the pointer while it is over his opaque pixels (click-through
// everywhere else), so a hand cursor here reads as "he is clickable" and never leaks onto
// the desktop around him.
function setCursor(over: boolean): void { document.body.style.cursor = over ? 'pointer' : 'default' }

// A press on his pixels is ambiguous until the pointer moves: hold still and release and it
// is a click that opens the panel, move past the threshold and it becomes a drag. Held in
// virtual pixels, with the grab offset kept so he does not jump to centre on the cursor.
const DRAG_THRESHOLD = 4
let press: { screenX: number; screenY: number; offsetX: number; offsetY: number } | null = null
let dragging = false

const beginDrag = (): void => {
  dragging = true
  document.body.style.cursor = 'grabbing'
  window.buddy.dragStart()
}
const endDrag = (): void => {
  dragging = false
  press = null
  document.body.style.cursor = 'default'
  hovering = false
  window.buddy.dragEnd(motion.vx, motion.vy)
}

window.addEventListener('mousemove', (e) => {
  if (press) {
    const moved = Math.hypot(e.screenX - press.screenX, e.screenY - press.screenY)
    if (!dragging && moved > DRAG_THRESHOLD) beginDrag()
    if (dragging) {
      // He follows the pointer directly. Main is not in this loop: it hears about the drag
      // once at the start and once at the drop.
      motion.place(e.screenX + press.offsetX, e.screenY + press.offsetY)
      place()
      return
    }
  }
  if (dragging) return
  const over = isOver(e.clientX, e.clientY)
  if (over !== hovering) { hovering = over; window.buddy.hover(over); setCursor(over) }
})
document.addEventListener('mouseleave', () => {
  if (dragging || press) return
  if (hovering) { hovering = false; window.buddy.hover(false); setCursor(false) }
})
canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !isOver(e.clientX, e.clientY)) return
  press = { screenX: e.screenX, screenY: e.screenY, offsetX: motion.vx - e.screenX, offsetY: motion.vy - e.screenY }
})
// On window, not the canvas: once he is being carried the pointer is nowhere near his
// pixels, so the release lands anywhere in the (now desktop-sized) overlay.
window.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return
  if (dragging) { endDrag(); return }
  if (press) { press = null; if (mutterVisible) hideMutterAtOnce(); window.buddy.click() }
})
window.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  // menu.popup({ window, x, y }) expects coordinates relative to the window's own content
  // area, not the screen, so this must send clientX/clientY, not screenX/screenY.
  if (isOver(e.clientX, e.clientY)) window.buddy.contextMenu(e.clientX, e.clientY)
})

window.buddy.overlayReady()
