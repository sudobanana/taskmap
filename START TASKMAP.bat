@echo off
setlocal
cd /d "%~dp0"
title TaskMap Launcher

echo ========================================
echo              TaskMap Launcher
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is not installed on this computer.
    echo.
    echo TaskMap needs Node.js to run locally.
    echo Your browser will open the Node.js download page.
    echo Install the LTS version, then double-click this file again.
    start "" "https://nodejs.org/en/download"
    echo.
    pause
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo npm could not be found. Reinstall the Node.js LTS version,
    echo then double-click this file again.
    pause
    exit /b 1
)

if not exist ".env.local" if exist ".env.example" (
    copy /Y ".env.example" ".env.local" >nul
)

if not exist "node_modules" (
    echo First launch: installing TaskMap dependencies...
    echo This only needs to happen once.
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo Dependency installation failed. Review the error above.
        pause
        exit /b 1
    )
)

echo Starting TaskMap...
echo A separate TaskMap server window will stay open while the app is running.
echo Close that server window, or press Ctrl+C in it, to stop TaskMap.
echo.

start "TaskMap Dev Server" cmd /k "cd /d ""%~dp0"" && npm run dev"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$deadline=(Get-Date).AddSeconds(45); do { try { $r=Invoke-WebRequest -UseBasicParsing 'http://localhost:3000' -TimeoutSec 1; if ($r.StatusCode -ge 200) { Start-Process 'http://localhost:3000'; exit 0 } } catch {}; Start-Sleep -Milliseconds 500 } while ((Get-Date) -lt $deadline); Start-Process 'http://localhost:3000'"

endlocal
exit /b 0
