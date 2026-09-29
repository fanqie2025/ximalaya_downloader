@echo off
chcp 65001 >nul
setlocal
rem 找 Python，按顺序试：① 项目自带的虚拟环境 ② Windows 的 py 启动器 ③ PATH 里的 python。
rem 公开仓库里不写个人路径 —— 以前这里写死了某台机器的 WorkBuddy python.exe，
rem 换台机器就是死路，也会把个人目录结构泄出去。
set "PY=%~dp0.venv\Scripts\python.exe"
if exist "%PY%" goto run
where py >nul 2>nul && set "PY=py -3" && goto run
set "PY=python"
:run
"%PY%" "%~dp0xm_tool.py" %*
