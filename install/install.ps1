<#
Installs and launches Mechanicus Buddy from this checkout, on a machine that has nothing
but Git. No admin, nothing system-wide: a portable Node lives in .node\ inside the
checkout, node_modules and out\ are built in place, and the only things outside the folder
are a Start-menu shortcut (plus a Startup one with -StartWithWindows) and the app's own
settings under %APPDATA%\mechanicus-buddy.

Run from a clone of the repo:
  powershell -ExecutionPolicy Bypass -File install\install.ps1 [-StartWithWindows] [-WithClaude] [-NoLaunch]
  powershell -ExecutionPolicy Bypass -File install\install.ps1 -Uninstall
or double-click "Install Mechanicus Buddy.cmd" in this folder.

Update: git pull, then run it again. Settings are never touched by a re-run.
#>
[CmdletBinding()]
param(
  [switch]$StartWithWindows,
  [switch]$WithClaude,
  [switch]$NoLaunch,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
# Invoke-WebRequest is many times slower with its progress bar on.
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$NodeDir = Join-Path $Root '.node'
$NodeExe = Join-Path $NodeDir 'node.exe'
$Npm = Join-Path $NodeDir 'npm.cmd'
$Electron = Join-Path $Root 'node_modules\electron\dist\electron.exe'
$AppName = 'Mechanicus Buddy'
$StartMenuLnk = Join-Path ([Environment]::GetFolderPath('Programs')) "$AppName.lnk"
$StartupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) "$AppName.lnk"
# Same override the app itself honours, so the script can be tried against a throwaway profile.
$DataDir = if ($env:BUDDY_USER_DATA) { $env:BUDDY_USER_DATA } else { Join-Path $env:APPDATA 'mechanicus-buddy' }

function Step($msg) { Write-Host "== $msg" -ForegroundColor Cyan }

function Stop-Buddy {
  Get-Process electron -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $Electron } |
    Stop-Process -Force -ErrorAction SilentlyContinue
}

function New-BuddyShortcut($path) {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = $Electron
  $lnk.Arguments = "`"$Root`""
  $lnk.WorkingDirectory = $Root
  $lnk.IconLocation = "$Electron,0"
  $lnk.Description = $AppName
  $lnk.Save()
}

if ($Uninstall) {
  Step 'Stopping the app'
  Stop-Buddy
  Step 'Removing shortcuts, portable Node, and build output'
  Remove-Item -Force -ErrorAction SilentlyContinue $StartMenuLnk, $StartupLnk
  foreach ($d in @($NodeDir, (Join-Path $Root 'node_modules'), (Join-Path $Root 'out'))) {
    if (Test-Path $d) { Remove-Item -Recurse -Force $d }
  }
  Write-Host "Removed. The checkout at $Root and the settings under $DataDir are untouched; delete them by hand if you want them gone."
  return
}

# 1. Portable Node 22. The zip name comes from the release's own checksum list, and the
#    download is verified against it.
if (-not (Test-Path $NodeExe)) {
  Step 'Downloading portable Node 22'
  $base = 'https://nodejs.org/dist/latest-v22.x'
  $sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content
  $line = ($sums -split "`n") | Where-Object { $_ -match 'node-v22\.[0-9.]+-win-x64\.zip' } | Select-Object -First 1
  if (-not $line) { throw 'Could not find the Node 22 win-x64 zip in SHASUMS256.txt' }
  $parts = $line.Trim() -split '\s+'
  $hash = $parts[0]; $file = $parts[1]
  $zip = Join-Path $env:TEMP $file
  Invoke-WebRequest "$base/$file" -OutFile $zip -UseBasicParsing
  $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $hash) { throw "Node download failed its checksum (expected $hash, got $actual)" }
  $tmp = Join-Path $env:TEMP ('node-extract-' + [guid]::NewGuid().ToString('N'))
  Expand-Archive $zip -DestinationPath $tmp
  $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
  if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
  Move-Item $inner.FullName $NodeDir
  Remove-Item -Recurse -Force $tmp
  Remove-Item -Force $zip
}
Write-Host "Node $(& $NodeExe --version) at $NodeDir"

# 2. Dependencies and build. Electron's own binary is downloaded by npm here. Playwright is a
#    dev-only dependency; make sure it never fetches browsers.
$env:Path = "$NodeDir;$env:Path"
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
Push-Location $Root
try {
  Step 'Installing dependencies (the long part, a few minutes)'
  & $Npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
  # Electron 44 ships no postinstall: the binary download is a separate bin, install-electron.
  # package.json runs it from a root postinstall, so npm ci normally leaves the binary in
  # place. Keep this fallback for the case where install scripts were skipped.
  if (-not (Test-Path $Electron)) {
    Step 'Fetching the Electron binary'
    & $NodeExe (Join-Path $Root 'node_modules\electron\install.js')
    if ($LASTEXITCODE -ne 0) { throw "Electron download failed with exit code $LASTEXITCODE" }
  }
  Step 'Building'
  & $Npm run build
  if ($LASTEXITCODE -ne 0) { throw "build failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }
if (-not (Test-Path $Electron)) { throw "Electron was not found at $Electron after the install" }

# 3. First settings: the workspace defaults to a developer's C:\repo; a fresh machine gets
#    the home folder instead. Never overwrite settings that already exist.
$config = Join-Path $DataDir 'config.json'
if (-not (Test-Path $config)) {
  Step 'Writing first settings'
  New-Item -ItemType Directory -Force $DataDir | Out-Null
  $json = @{ workspace = $env:USERPROFILE } | ConvertTo-Json
  # No byte-order mark: the app parses this with JSON.parse, which rejects one.
  [IO.File]::WriteAllText($config, $json + "`n", (New-Object Text.UTF8Encoding $false))
}

# 4. Shortcuts. The target is the bundled electron.exe with the checkout as its argument,
#    so the app opens with no console window.
Step 'Creating shortcuts'
New-BuddyShortcut $StartMenuLnk
if ($StartWithWindows) { New-BuddyShortcut $StartupLnk }
elseif (Test-Path $StartupLnk) { Remove-Item -Force $StartupLnk }

# 5. Claude Code, for machines with a subscription. The login is interactive and stays manual.
if ($WithClaude) {
  Step 'Installing Claude Code with the official installer'
  Invoke-Expression (Invoke-RestMethod 'https://claude.ai/install.ps1' -UseBasicParsing)
  Write-Host 'Claude Code installed. Open a new terminal, run "claude" once to log in, then relaunch the buddy.' -ForegroundColor Yellow
}

# 6. Launch.
if (-not $NoLaunch) {
  Step 'Launching'
  Stop-Buddy
  Start-Process -FilePath $Electron -ArgumentList "`"$Root`"" -WorkingDirectory $Root
}
Write-Host ''
Write-Host "Done. Start-menu shortcut: $StartMenuLnk" -ForegroundColor Green
if ($StartWithWindows) { Write-Host "Starts with Windows via: $StartupLnk" -ForegroundColor Green }
Write-Host "Update later with: git pull, then run this again. Remove with: install\install.ps1 -Uninstall"
