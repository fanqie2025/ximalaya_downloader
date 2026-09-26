#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""重新打包图形界面。

改过 xmgui.py / xmcore.py 之后跑这个，会重新生成「喜马拉雅下载器.exe」。
重命名放在 Python 里做 —— .cmd 文件里写中文会被 cmd 按 ANSI 解析成乱码。
"""
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BUILT = "XimalayaDownloader.exe"
FINAL = "喜马拉雅下载器.exe"


def main():
    py = HERE / ".venv" / "Scripts" / "python.exe"
    if not py.exists():
        print(f"[x] 找不到虚拟环境：{py}")
        print("    先建一个：python -m venv .venv")
        print("    再装打包工具：.venv\\Scripts\\python.exe -m pip install pyinstaller")
        return 1

    cmd = [
        str(py), "-m", "PyInstaller",
        "--noconfirm", "--clean", "--onefile", "--windowed",
        "--name", "XimalayaDownloader",
        "--paths", ".", "--distpath", ".", "--workpath", "build/work",
        "--specpath", "build",
        "xmgui.py",
    ]
    print("[*] " + " ".join(cmd), flush=True)
    rc = subprocess.call(cmd, cwd=str(HERE))
    if rc != 0:
        print(f"[x] 打包失败，退出码 {rc}")
        return rc

    built = HERE / BUILT
    if not built.exists():
        print(f"[x] 没找到产物 {BUILT}")
        return 1
    os.replace(built, HERE / FINAL)
    size = (HERE / FINAL).stat().st_size / 1024 / 1024
    print(f"[+] 完成：{FINAL}（{size:.1f} MB）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
