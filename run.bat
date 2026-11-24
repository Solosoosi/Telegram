@echo off
REM Double-click to run the Telegram scraper on Windows.
REM Extra arguments are passed through, e.g.:  run.bat --start 7d --end now --mode history
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    echo First run: setting up a private Python environment...
    py -3 -m venv .venv 2>nul || python -m venv .venv
    if errorlevel 1 (
        echo Could not create the environment. Install Python 3.9+ from https://www.python.org and retry.
        pause
        exit /b 1
    )
    ".venv\Scripts\python.exe" -m pip install --upgrade pip >nul
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt
)
".venv\Scripts\python.exe" scraper.py %*
echo.
pause
