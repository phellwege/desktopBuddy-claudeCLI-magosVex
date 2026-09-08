// The production PtyFactory over node-pty. Kept apart from pty.ts so the unit tests never
// load the native module; the prebuilt binary node-pty ships loads in Electron 44 without
// a rebuild (measured 2026-09-07).
import * as nodePty from 'node-pty'
import type { PtyFactory } from './pty'

export const nodePtyFactory: PtyFactory = (file, args, opts) =>
  nodePty.spawn(file, args, { name: opts.name, cols: opts.cols, rows: opts.rows, cwd: opts.cwd, env: opts.env })
