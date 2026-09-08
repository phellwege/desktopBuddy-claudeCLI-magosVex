import { describe, it, expect } from 'vitest'
import { findImagePaths, fromFileUrl, stageablePaths } from './imagePaths'

describe('findImagePaths', () => {
  it('finds a quoted Windows path with spaces, as Explorer copies it', () => {
    expect(findImagePaths('see "C:\\My Shots\\err 1.png" please')).toEqual(['C:\\My Shots\\err 1.png'])
  })
  it('finds bare Windows paths with either slash, any extension case', () => {
    expect(findImagePaths('C:\\shots\\a.png and D:/x/b.JPG')).toEqual(['C:\\shots\\a.png', 'D:/x/b.JPG'])
  })
  it('finds a UNC path', () => {
    expect(findImagePaths('\\\\nas\\share\\c.webp')).toEqual(['\\\\nas\\share\\c.webp'])
  })
  it('finds a POSIX path inside a sentence', () => {
    expect(findImagePaths('look at /Users/p/d.gif now')).toEqual(['/Users/p/d.gif'])
  })
  it('decodes a file URL and restores the drive form', () => {
    expect(findImagePaths('file:///C:/dir/my%20shot.png')).toEqual(['C:/dir/my shot.png'])
    expect(findImagePaths('file:///home/u/e.jpeg')).toEqual(['/home/u/e.jpeg'])
  })
  it('ignores other extensions and web urls', () => {
    expect(findImagePaths('C:\\a\\notes.txt https://x.y/z.png')).toEqual([])
  })
  it('dedupes and keeps first-seen order', () => {
    expect(findImagePaths('C:\\a.png "C:\\b.png" C:\\a.png')).toEqual(['C:\\a.png', 'C:\\b.png'])
  })
  it('finds nothing in plain prose', () => {
    expect(findImagePaths('the png format is fine, C: drive is full')).toEqual([])
  })
  it('finds a bare Windows path right after a colon with no space', () => {
    expect(findImagePaths('see:C:\\a.png')).toEqual(['C:\\a.png'])
  })
  it('finds a bare Windows path in a colon-joined log line', () => {
    expect(findImagePaths('error:C:\\Users\\x\\shot.png')).toEqual(['C:\\Users\\x\\shot.png'])
  })
  it('finds a bare Windows path immediately inside parentheses', () => {
    expect(findImagePaths('(C:\\a.png)')).toEqual(['C:\\a.png'])
  })
  it('finds a bare Windows path at the very start of the text', () => {
    expect(findImagePaths('C:\\a.png')).toEqual(['C:\\a.png'])
  })
  it('stops a bare Windows path at a non-extension suffix', () => {
    expect(findImagePaths('C:\\a.png.bak')).toEqual([])
  })
  it('rejects a quoted web url', () => {
    expect(findImagePaths('"https://x/y.png"')).toEqual([])
  })
})

describe('fromFileUrl', () => {
  it('handles drive and posix forms', () => {
    expect(fromFileUrl('file:///C:/a/b.png')).toBe('C:/a/b.png')
    expect(fromFileUrl('file:///a/b.png')).toBe('/a/b.png')
    expect(fromFileUrl('file://localhost/a/b.png')).toBe('/localhost/a/b.png')
  })
  it('keeps the raw form on a malformed percent escape', () => {
    expect(fromFileUrl('file:///C:/dir/bad%2.png')).toBe('C:/dir/bad%2.png')
  })
})

describe('stageablePaths', () => {
  it('stages a bare UNC path that is the whole paste', () => {
    expect(stageablePaths('\\\\nas\\share\\c.webp')).toEqual(['\\\\nas\\share\\c.webp'])
  })
  it('stages a quoted UNC path that is the whole paste', () => {
    expect(stageablePaths('"\\\\nas\\share\\c.webp"')).toEqual(['\\\\nas\\share\\c.webp'])
  })
  it('drops a UNC path that appears inside other text', () => {
    expect(stageablePaths('see \\\\nas\\share\\c.webp now')).toEqual([])
  })
  it('keeps a local path but drops a UNC path in the same paste', () => {
    expect(stageablePaths('C:\\a.png and \\\\nas\\b.png')).toEqual(['C:\\a.png'])
  })
  it('still stages a plain local path in prose', () => {
    expect(stageablePaths('see C:\\a.png please')).toEqual(['C:\\a.png'])
  })
})
