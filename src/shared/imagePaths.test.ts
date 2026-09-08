import { describe, it, expect } from 'vitest'
import { findImagePaths, fromFileUrl } from './imagePaths'

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
})

describe('fromFileUrl', () => {
  it('handles drive and posix forms', () => {
    expect(fromFileUrl('file:///C:/a/b.png')).toBe('C:/a/b.png')
    expect(fromFileUrl('file:///a/b.png')).toBe('/a/b.png')
    expect(fromFileUrl('file://localhost/a/b.png')).toBe('/localhost/a/b.png')
  })
})
