@echo off
REM Run the web app privately on this computer (Windows): http://127.0.0.1:8765
REM Only this computer can open it. Close this window (or press Ctrl+C) to stop.
cd /d "%~dp0web"
where npm >nul 2>nul
if errorlevel 1 (
    echo Node.js is needed ^(one-time install^): https://nodejs.org  - choose the LTS version.
    pause
    exit /b 1
)
if not exist "node_modules" (
    echo First run: installing the web app ^(one time^)...
    call npm ci
    if errorlevel 1 (
        pause
        exit /b 1
    )
)
echo Starting at http://127.0.0.1:8765 - your browser will open. Close this window to stop.
call npm start
pause
