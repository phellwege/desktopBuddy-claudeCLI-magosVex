import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { resolvePackPath } from './protocol'

const dir = resolve('C:/p/packs/x')
describe('resolvePackPath', () => {
  it('maps pack://app/<file> into the pack directory', () => {
    expect(resolvePackPath(dir, 'pack://app/atlas.png')).toBe(resolve(dir, 'atlas.png'))
    expect(resolvePackPath(dir, 'pack://app/sub/a.json')).toBe(resolve(dir, 'sub', 'a.json'))
  })
  it('rejects traversal and empty paths', () => {
    expect(resolvePackPath(dir, 'pack://app/../manifest.json')).toBeNull()
    expect(resolvePackPath(dir, 'pack://app/')).toBeNull()
  })
  it('decodes percent-encoding', () => {
    expect(resolvePackPath(dir, 'pack://app/my%20file.png')).toBe(resolve(dir, 'my file.png'))
  })
})
