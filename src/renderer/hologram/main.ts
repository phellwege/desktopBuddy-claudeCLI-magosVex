import { renderMarkdown } from './markdown'
import type { ChatPermissionPayload, ThemePayload } from '../../shared/ipc'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const log = $<HTMLDivElement>('log'), input = $<HTMLTextAreaElement>('input'), status = $<HTMLSpanElement>('status')
const perm = $<HTMLDivElement>('permission'), permLine = $<HTMLDivElement>('perm-line'), permDetail = $<HTMLDivElement>('perm-detail')
let current: HTMLDivElement | null = null
let buffer = ''
let renderQueued = false
let lastInput = ''
let pending: ChatPermissionPayload | null = null
const activities = new Map<string, HTMLDivElement>()

function add(cls: string, html: string): HTMLDivElement {
  const el = document.createElement('div'); el.className = `msg ${cls}`; el.innerHTML = html
  log.appendChild(el); log.scrollTop = log.scrollHeight; return el
}
function flush(): void {
  renderQueued = false
  if (current) { current.innerHTML = renderMarkdown(buffer); log.scrollTop = log.scrollHeight }
}

window.buddy.onTheme((t: ThemePayload) => {
  const r = document.documentElement.style
  r.setProperty('--accent', t.accent); r.setProperty('--glow', t.glow); r.setProperty('--bg', t.background)
  r.setProperty('--text', t.text); r.setProperty('--font', t.font)
  $('name').textContent = t.name
})
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
  if (!el) { el = document.createElement('div'); el.className = 'activity'; activities.set(a.id, el); (current ?? add('buddy', '')).insertAdjacentElement('afterend', el) }
  el.textContent = a.label
  if (a.done) el.classList.add('done')
})
window.buddy.onChatDone(() => { flush(); current = null; buffer = ''; activities.clear() })
window.buddy.onChatSystem(({ text }) => { current = null; add('system', renderMarkdown(text)) })
window.buddy.onChatPermission((p) => {
  pending = p; permLine.textContent = p.line; permDetail.textContent = `${p.toolName}: ${p.summary}`; perm.hidden = false
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
