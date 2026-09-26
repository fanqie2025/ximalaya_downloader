@echo off
rem Pure ASCII on purpose: cmd parses .bat/.cmd with the ANSI codepage,
rem so non-ASCII text in this file would come out garbled.
chcp 65001 >nul
cd /d "%~dp0"
set "PY=%~dp0.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" "%~dp0rebuild.py" %*
echo.
pause
