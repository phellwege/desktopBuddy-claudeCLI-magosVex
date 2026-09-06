// Height for the composer textarea: its rendered scroll height, capped at maxRows lines
// plus the vertical padding. Dictation arrives as one long line, so this follows the
// rendered height rather than counting newlines.
export function grownHeight(scrollHeight: number, lineHeight: number, maxRows = 6, padding = 12): number {
  return Math.min(scrollHeight, lineHeight * maxRows + padding)
}
