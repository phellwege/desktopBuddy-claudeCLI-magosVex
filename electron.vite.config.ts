// Electron 44
import { copyFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'electron-vite'

// The permission-hook script is plain Node with no dependencies (run by the Claude CLI as a
// bare child process), so it is copied verbatim into out/hook/ rather than bundled.
function copyHookScript(): Plugin {
  return {
    name: 'copy-hook-script',
    closeBundle() {
      const outDir = resolve(__dirname, 'out/hook')
      mkdirSync(outDir, { recursive: true })
      copyFileSync(resolve(__dirname, 'src/hook/permission-hook.cjs'), resolve(outDir, 'permission-hook.cjs'))
    },
  }
}

export default defineConfig({
  main: {
    plugins: [copyHookScript()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } } },
  },
  preload: {
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } } },
  },
  renderer: {
    build: {
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, 'src/renderer/overlay/index.html'),
          hologram: resolve(__dirname, 'src/renderer/hologram/index.html'),
        },
      },
    },
  },
})
