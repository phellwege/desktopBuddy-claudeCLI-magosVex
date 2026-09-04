import { Animator } from './animator'
import { Motion } from './motion'
import { HitTester } from './hittest'
import type { Atlas, AtlasFrame } from '../../shared/types'
import type { BuddyStatePayload, PackLoadedPayload } from '../../shared/ipc'

const canvas = document.getElementById('buddy') as HTMLCanvasElement
const ctx = canvas.getContext('2d')!
const motion = new Motion(0.5)
const hit = new HitTester()
let atlas: Atlas | null = null
let image: HTMLImageElement | null = null
let animator: Animator | null = null
let scale = 1
let hovering = false
let lastState: BuddyStatePayload | null = null
let hitFrame = ''
let drawn: { f: AtlasFrame; mirror: boolean } | null = null

const loadImage = (url: string) => new Promise<HTMLImageElement>((res, rej) => {
  const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url
})
const walkable = () => Math.max(1, window.innerWidth - canvas.width)
const place = () => { canvas.style.transform = `translateX(${Math.round(motion.x * walkable())}px)` }

function layout(): void {
  if (!atlas) return
  canvas.width = Math.ceil(atlas.maxFrameSize[0] * scale)
  canvas.height = Math.ceil(atlas.maxFrameSize[1] * scale)
  place()
}

function apply(s: BuddyStatePayload): void {
  if (!animator) return
  animator.setFacing(s.state.facing)
  animator.set(s.animation)
  if (s.state.targetX !== undefined) motion.setTarget(s.state.targetX, s.speed)
  else { motion.setTarget(undefined, 0); motion.x = s.state.x }
  place()
}

window.buddy.onPackLoaded(async (p: PackLoadedPayload) => {
  atlas = await (await fetch(p.atlasJsonUrl)).json() as Atlas
  image = await loadImage(p.atlasUrl)
  scale = p.scale
  animator = new Animator(p.animations)
  layout()
  if (lastState) apply(lastState)
})
window.buddy.onBuddyState((s) => { lastState = s; apply(s) })
window.addEventListener('resize', layout)

function draw(): void {
  if (!animator || !atlas || !image) return
  const { frame: name, mirror } = animator.current()
  const f = atlas.frames[name]
  if (!f) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const baselineY = canvas.height - 4
  const dx = canvas.width / 2 - f.ax * scale
  const dy = baselineY - f.ay * scale
  ctx.save()
  if (mirror) { ctx.translate(canvas.width, 0); ctx.scale(-1, 1) }
  ctx.drawImage(image, f.x, f.y, f.w, f.h, dx, dy, f.w * scale, f.h * scale)
  ctx.restore()
  if (name !== hitFrame) { hit.update(image, f); hitFrame = name }
  drawn = { f, mirror }
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

window.addEventListener('mousemove', (e) => {
  const over = isOver(e.clientX, e.clientY)
  if (over !== hovering) { hovering = over; window.buddy.hover(over) }
})
document.addEventListener('mouseleave', () => { if (hovering) { hovering = false; window.buddy.hover(false) } })
canvas.addEventListener('mousedown', (e) => { if (e.button === 0 && isOver(e.clientX, e.clientY)) window.buddy.click() })
window.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  if (isOver(e.clientX, e.clientY)) window.buddy.contextMenu(e.screenX, e.screenY)
})

window.buddy.overlayReady()
