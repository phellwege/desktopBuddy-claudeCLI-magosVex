// Environment for a launched app under test.
//
// ELECTRON_RENDERER_URL is how electron-vite tells the main process to load renderers from
// the dev server instead of the build. Anything spawned by a running `npm run dev` inherits
// it, and the buddy's own brain is spawned by exactly that: a test run started from inside
// the app (or from any shell descended from it) would silently exercise the dev server's
// renderer, from whichever checkout that server happens to be serving, rather than the
// build the test just produced. Strip it so a spec always tests its own build.
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'ELECTRON_RENDERER_URL') continue
    if (v !== undefined) env[k] = v
  }
  return { ...env, ...extra }
}
