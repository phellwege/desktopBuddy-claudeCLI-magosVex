// The production PtyFactory over node-pty. Kept apart from pty.ts so the unit tests never
// load the native module; the prebuilt binary node-pty ships loads in Electron 44 without
// a rebuild (measured 2026-09-07). The require is inside the factory, not at module load, so
// a missing or broken native module only fails the tab's first start (PtySession.start wraps
// this call in try/catch) instead of the whole buddy at launch; the module cache makes every
// call after the first free.
import type * as NodePty from 'node-pty'
import type { PtyFactory } from './pty'

export const nodePtyFactory: PtyFactory = (file, args, opts) => {
  const nodePty = require('node-pty') as typeof NodePty
  return nodePty.spawn(file, args, { name: opts.name, cols: opts.cols, rows: opts.rows, cwd: opts.cwd, env: opts.env })
}
