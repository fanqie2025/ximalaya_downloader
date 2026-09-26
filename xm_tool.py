#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
喜马拉雅下载器 · 命令行入口

图形界面（xmgui.py / 喜马拉雅下载器.exe）是推荐用法，
这个脚本给喜欢打命令或要写进自动化脚本的场景用。两者共用 xmcore.py。

用法：
    python xm_tool.py 12345678                 下载专辑（用设置里的音质与目录）
    python xm_tool.py 12345678 -o G:/有声书     临时指定目录
    python xm_tool.py 12345678 --low           临时切低音质
    python xm_tool.py 12345678 --fast          快速模式（并发 10，易触发风控）
    python xm_tool.py 12345678 --pc            只用电脑版接口登录（只扫一次码）
    python xm_tool.py 12345678 --push          下载后推到飞牛 ABS 库
    python xm_tool.py --login --pc             只登录，不下载
    python xm_tool.py --fix-only D:/某专辑      只做补零重命名
    python xm_tool.py --push-only D:/某专辑     只推送

专辑 ID 怎么拿：专辑页地址形如 https://www.ximalaya.com/album/12345678
"""
import argparse
import re
import subprocess
import sys
from pathlib import Path

import xmcore as core

HERE = core.project_root()


def run_node(args):
    cmd = [core.node_bin()] + args
    print("[*] " + " ".join(cmd), flush=True)
    return subprocess.call(
        cmd, cwd=str(HERE), env=core.child_env(),
        creationflags=core.no_window_flags(),
    )


def main():
    ap = argparse.ArgumentParser(
        description="喜马拉雅专辑下载 + ABS 入库辅助",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("album", nargs="?", help="专辑 ID 或专辑页链接")
    ap.add_argument("-o", "--output", help="保存目录（默认读设置文件）")
    ap.add_argument("--high", action="store_true", help="高音质")
    ap.add_argument("--standard", action="store_true", help="标准音质")
    ap.add_argument("--low", action="store_true", help="省流量（低音质）")
    ap.add_argument("--fast", action="store_true", help="快速模式（并发 10，易被风控）")
    ap.add_argument("--pc", action="store_true", help="只用电脑版接口登录（只扫一次码）")
    ap.add_argument("--web", action="store_true", help="只用网页端接口登录")
    ap.add_argument("--push", action="store_true", help="下载后推送到飞牛 ABS 库")
    ap.add_argument("--login", action="store_true", help="只登录（扫码），不下载")
    ap.add_argument("--fix-only", metavar="DIR", help="只做补零重命名")
    ap.add_argument("--push-only", metavar="DIR", help="只推送到飞牛")
    ap.add_argument("--no-fix", action="store_true", help="下载后不做补零重命名")
    args = ap.parse_args()

    if args.fix_only:
        core.fix_numbering(args.fix_only)
        return

    if args.push_only:
        sys.exit(core.push_to_nas(args.push_only))

    settings = core.load_settings()

    if args.login:
        cmd = ["login.js"] + (["pc"] if args.pc else ["web"] if args.web else [])
        sys.exit(run_node(cmd))

    if not args.album:
        ap.print_help()
        return

    # 音质：命令行参数优先，否则用设置文件
    mode = settings["quality"]["mode"]
    for name in ("high", "standard", "low"):
        if getattr(args, name):
            mode = name
    paid = settings["quality"].get("paidLevel", 1)

    # 允许直接粘专辑页链接
    raw = args.album.strip().rstrip("/")
    m = re.search(r"/album/(\d+)", raw)
    album_id = m.group(1) if m else raw
    if not album_id.isdigit():
        sys.exit(f"[x] 看不懂这个专辑标识：{args.album}")

    out_dir = Path(args.output or settings["archives"])
    out_dir.mkdir(parents=True, exist_ok=True)

    # 把本次生效的音质写回设置文件，让图形界面/下次运行保持一致
    core.save_settings(str(out_dir).replace("\\", "/"), mode, paid)

    cmd = ["xmd.js", "-a", album_id, "-o", str(out_dir)]
    if not args.fast:
        cmd.append("-s")
    if args.pc:
        cmd += ["-t", "pc"]
    elif args.web:
        cmd += ["-t", "web"]
    rc = run_node(cmd)
    if rc != 0:
        print(f"[!] 下载器退出码 {rc}（常见原因：风控额度用尽，等下一个整点再跑）")

    albums = sorted(core.list_album_dirs(out_dir),
                    key=lambda d: d.stat().st_mtime, reverse=True)
    if not albums:
        print("[!] 保存目录下没有找到专辑文件夹")
        return
    target = albums[0]
    print(f"[*] 专辑目录：{target}")

    if not args.no_fix:
        core.fix_numbering(target)

    if args.push:
        core.push_to_nas(target)

    n = len([f for f in target.iterdir() if f.suffix.lower() in core.AUDIO_EXT])
    print(f"[=] 完成：{target.name} 共 {n} 个音频")


if __name__ == "__main__":
    main()
