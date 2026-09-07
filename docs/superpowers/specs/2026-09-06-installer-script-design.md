# Installer script design

Date: 2026-09-06. Status: approved by Peter. Supersedes the electron-builder proposal made
the same evening, which he judged heavier than the problem.

## 1. Decision

No packaging toolchain. A PowerShell script in the repo turns a plain `git clone` into a
running desktop buddy on a machine with nothing but Git installed: it fetches a portable
Node into the checkout, installs and builds in place, creates shortcuts, writes a first
config, and launches. Re-running after `git pull` is the update path. Nothing is installed
system-wide and no admin prompt appears.

Rejected: an electron-builder NSIS installer (icon work, a second build pipeline, signing
questions) for a gift install that a script covers in eighty lines.

## 2. Files

- `install/install.ps1`: the script. Runs on Windows PowerShell 5.1 (what every Windows
  machine has) as well as PowerShell 7.
- `install/Install Mechanicus Buddy.cmd`: double-click wrapper that runs the script with
  `-ExecutionPolicy Bypass` and pauses on failure so the message stays on screen.
- `.gitignore` gains `.node/`.
- README gains an "Install on a machine without dev tools" section.

## 3. What the script does

1. Portable Node 22 into `<checkout>\.node`. The exact zip name is read from
   `https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt` and the download is checked
   against that hash. Skipped when `node.exe` is already there.
2. `npm ci` and `npm run build` with that Node (the Electron binary arrives through npm's
   postinstall). `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` so the dev-only Playwright dependency
   never fetches browsers.
3. A first `config.json` under the app's data folder with `workspace` set to the user's
   home folder, only when no config exists yet. Existing settings are never touched.
4. A Start-menu shortcut whose target is the bundled `electron.exe` with the checkout as
   its argument, so the app opens with no console window. `-StartWithWindows` adds the same
   shortcut to the Startup folder; without the switch a stale Startup shortcut is removed.
5. `-WithClaude` runs Anthropic's official Windows installer (`claude.ai/install.ps1`),
   for machines that have a subscription. The login stays manual (`claude` in a terminal)
   because it is interactive.
6. Launches the app unless `-NoLaunch`, stopping any instance already running from this
   checkout first.

`-Uninstall` stops the app, removes both shortcuts, `.node`, `node_modules` and `out`,
and leaves the checkout and the data folder for the user to delete.

The data folder honours `BUDDY_USER_DATA` when set, matching the app's own test hook, so
the script can be verified against a throwaway profile.

## 4. Verification

On the development machine: clone the repo into a temp folder, run the script there with
`BUDDY_USER_DATA` pointing at a temp profile, confirm from the app log that the pack
loaded and the workspace is the home folder, then `-Uninstall` and confirm the shortcuts
are gone. The real install on Peter's wife's machine is the acceptance test.

## 5. Out of scope

macOS (needs the platform port first; a bash twin of this script comes with it), code
signing, auto-update, a packaged installer.
