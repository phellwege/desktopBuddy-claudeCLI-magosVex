@echo off
setlocal
rem Double-click wrapper for install.ps1. Passes any switches through, e.g.
rem   "Install Mechanicus Buddy.cmd" -StartWithWindows
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 (
  echo.
  echo The install did not finish. The message above says why.
  pause
  exit /b 1
)
timeout /t 8
endlocal
