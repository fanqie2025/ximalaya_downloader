@echo off
rem ---------------------------------------------------------------------------
rem Launch the device-fingerprint collector (GUI).
rem
rem Keep this file PURE ASCII. cmd.exe parses .cmd in the system ANSI codepage,
rem so any Chinese characters in here turn into mojibake and the paths break.
rem Chinese lives in the .py file, which Python reads as UTF-8.
rem ---------------------------------------------------------------------------
cd /d "%~dp0"

if exist ".venv\Scripts\pythonw.exe" (
  start "" ".venv\Scripts\pythonw.exe" "collect_device_info.py"
  exit /b
)

where pythonw >nul 2>nul
if errorlevel 1 goto nopython
start "" pythonw "collect_device_info.py"
exit /b

:nopython
echo.
echo   Python not found. This tool needs Python 3 (with tkinter).
echo.
echo   Try running it directly instead:
echo       .venv\Scripts\python.exe collect_device_info.py
echo.
pause
