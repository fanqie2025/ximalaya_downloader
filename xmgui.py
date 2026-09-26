#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
喜马拉雅下载器 · 图形界面

双击即可运行。填专辑链接 → 选音质 → 选目录 → 开始下载。
下载完自动补零重命名（ABS 按数字顺序识别章节必需），可选推到飞牛。
"""
from __future__ import annotations

import os
import queue
import re
import subprocess
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
from tkinter.scrolledtext import ScrolledText

import xmcore as core

PROGRESS_RE = re.compile(r"进度:([\d.]+)%\((\d+)/(\d+)\)")
# xmd.js 在开下之前会打印实际写进哪个目录，直接拿它比事后猜可靠
ALBUM_DIR_RE = re.compile(r"专辑目录名:(.+?)\s*$")
APP_TITLE = "喜马拉雅下载器"


class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.proc: subprocess.Popen | None = None
        self.q: queue.Queue = queue.Queue()
        self.running = False
        self.last_album_dir: Path | None = None

        root.title(APP_TITLE)
        root.geometry("860x660")
        root.minsize(760, 560)

        s = core.load_settings()
        self.var_album = tk.StringVar()
        self.var_quality = tk.StringVar(
            value=core.QUALITY_LABELS.get(s["quality"]["mode"], "高音质"))
        self.var_dir = tk.StringVar(value=s["archives"])
        self.var_slow = tk.BooleanVar(value=True)
        self.var_fix = tk.BooleanVar(value=True)
        self.var_push = tk.BooleanVar(value=False)
        self.var_status = tk.StringVar(value="就绪")

        self._build()
        self.root.after(100, self._drain)
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

    # ------------------------------------------------------------ 界面
    def _build(self):
        pad = {"padx": 10, "pady": 6}
        frm = ttk.Frame(self.root, padding=12)
        frm.pack(fill="both", expand=True)
        frm.columnconfigure(1, weight=1)
        r = 0

        # 专辑
        ttk.Label(frm, text="专辑链接或 ID").grid(row=r, column=0, sticky="w", **pad)
        e = ttk.Entry(frm, textvariable=self.var_album)
        e.grid(row=r, column=1, columnspan=2, sticky="ew", **pad)
        e.focus_set()
        r += 1
        ttk.Label(
            frm, foreground="#666",
            text="专辑页地址形如 ximalaya.com/album/12345678，整条粘进来会自动截取数字",
        ).grid(row=r, column=1, columnspan=2, sticky="w", padx=10)

        # 音质
        r += 1
        ttk.Label(frm, text="音质").grid(row=r, column=0, sticky="w", **pad)
        cb = ttk.Combobox(
            frm, textvariable=self.var_quality, state="readonly", width=14,
            values=["高音质", "标准", "省流量"],
        )
        cb.grid(row=r, column=1, sticky="w", **pad)
        ttk.Label(
            frm, foreground="#666",
            text="免费声音真实生效；VIP/付费声音由平台参数决定，默认与官方一致",
        ).grid(row=r, column=2, sticky="w", padx=10)

        # 下载目录
        r += 1
        ttk.Label(frm, text="下载目录").grid(row=r, column=0, sticky="w", **pad)
        ttk.Entry(frm, textvariable=self.var_dir).grid(row=r, column=1, sticky="ew", **pad)
        box = ttk.Frame(frm)
        box.grid(row=r, column=2, sticky="w")
        ttk.Button(box, text="选择…", width=7, command=self._pick_dir).pack(side="left", padx=2)
        ttk.Button(box, text="打开", width=6, command=self._open_dir).pack(side="left", padx=2)

        # 选项
        r += 1
        opt = ttk.LabelFrame(frm, text="选项", padding=8)
        opt.grid(row=r, column=0, columnspan=3, sticky="ew", padx=10, pady=8)
        ttk.Checkbutton(opt, text="慢速模式（并发 1，强烈建议，防风控）",
                        variable=self.var_slow).pack(anchor="w")
        ttk.Checkbutton(opt, text="补零重命名（新下载已自动补零，勾上=顺带修历史文件）",
                        variable=self.var_fix).pack(anchor="w")
        ttk.Checkbutton(opt, text="下载完推送到飞牛 ABS 库（192.168.10.111）",
                        variable=self.var_push).pack(anchor="w")

        # 按钮
        r += 1
        bar = ttk.Frame(frm)
        bar.grid(row=r, column=0, columnspan=3, sticky="ew", padx=10, pady=4)
        self.btn_login = ttk.Button(bar, text="扫码登录", width=12, command=self._login)
        self.btn_login.pack(side="left", padx=2)
        self.btn_start = ttk.Button(bar, text="开始下载", width=14, command=self._start)
        self.btn_start.pack(side="left", padx=2)
        self.btn_stop = ttk.Button(bar, text="停止", width=8, command=self._stop, state="disabled")
        self.btn_stop.pack(side="left", padx=2)

        # 进度
        r += 1
        self.pb = ttk.Progressbar(frm, mode="determinate", maximum=100)
        self.pb.grid(row=r, column=0, columnspan=3, sticky="ew", padx=10, pady=(2, 8))

        # 日志
        r += 1
        frm.rowconfigure(r, weight=1)
        self.log = ScrolledText(frm, height=16, wrap="word", font=("Consolas", 9))
        self.log.grid(row=r, column=0, columnspan=3, sticky="nsew", padx=10)
        self.log.configure(state="disabled")

        # 状态栏
        r += 1
        ttk.Label(frm, textvariable=self.var_status, foreground="#0a6").grid(
            row=r, column=0, columnspan=3, sticky="w", padx=10, pady=(6, 0))

    # ------------------------------------------------------------ 工具
    def _log(self, text: str):
        self.log.configure(state="normal")
        self.log.insert("end", text + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def _pick_dir(self):
        d = filedialog.askdirectory(initialdir=self.var_dir.get() or str(core.project_root()))
        if d:
            self.var_dir.set(d.replace("\\", "/"))

    def _open_dir(self):
        d = Path(self.var_dir.get())
        d.mkdir(parents=True, exist_ok=True)
        try:
            os.startfile(str(d))
        except Exception as e:
            messagebox.showwarning(APP_TITLE, f"打不开目录：{e}")

    def _parse_album(self) -> str | None:
        raw = self.var_album.get().strip()
        if not raw:
            return None
        m = re.search(r"/album/(\d+)", raw)
        if m:
            return m.group(1)
        digits = re.sub(r"\D", "", raw)
        return digits or None

    def _precheck(self) -> bool:
        if self.running:
            messagebox.showinfo(APP_TITLE, "正在忙，先等这一轮跑完")
            return False
        if core.node_bin() is None:
            messagebox.showerror(
                APP_TITLE,
                "找不到 Node.js。\n\n本工具靠 Node 运行核心程序，\n"
                "请先装 Node.js（建议 20 或 22），装完重开本程序。")
            return False
        return True

    def _set_running(self, on: bool):
        self.running = on
        self.btn_start.configure(state="disabled" if on else "normal")
        self.btn_login.configure(state="disabled" if on else "normal")
        self.btn_stop.configure(state="normal" if on else "disabled")

    # ------------------------------------------------------------ 动作
    def _login(self):
        if not self._precheck():
            return
        self._set_running(True)
        self.var_status.set("等待扫码…")
        self._log("=== 开始登录：请用喜马拉雅 App 扫描弹出的二维码 ===")
        threading.Thread(
            target=self._worker_login, daemon=True).start()

    def _worker_login(self):
        node = core.node_bin()
        cmd = [node, "login.js", "pc"]
        self.q.put(("log", "[*] " + " ".join(cmd)))
        try:
            p = subprocess.Popen(
                cmd, cwd=str(core.project_root()), env=core.child_env(),
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace", bufsize=1,
                creationflags=core.no_window_flags(),
            )
            self.proc = p
            for line in p.stdout:
                self.q.put(("log", line.rstrip()))
            p.wait()
            self.q.put(("log", "[=] 登录流程结束" if p.returncode == 0
                        else f"[!] 登录退出码 {p.returncode}"))
        except Exception as e:
            self.q.put(("log", f"[x] 登录出错：{e}"))
        finally:
            self.proc = None
            self.q.put(("done", None))

    def _start(self):
        album = self._parse_album()
        if album is None:
            messagebox.showwarning(APP_TITLE, "先填专辑链接或 ID")
            return
        if not self._precheck():
            return

        out_dir = Path(self.var_dir.get())
        out_dir.mkdir(parents=True, exist_ok=True)
        mode = core.QUALITY_FROM_LABEL.get(self.var_quality.get(), "high")
        core.save_settings(str(out_dir).replace("\\", "/"), mode)

        self._set_running(True)
        self.pb.configure(value=0)
        self.var_status.set("下载中…")
        self._log("")
        self._log(f"=== 专辑 {album}　音质：{self.var_quality.get()}　目录：{out_dir} ===")
        # 提前说一声。缺指纹时报错是「所有下载方式都受限了」，跟真被风控一模一样，
        # 不说的话人会以为是额度用尽，白白等一小时再来试。
        if not core.DEVICE_INFO.exists():
            self._log("[!] 本机还没有设备指纹 —— 免费声音照下，"
                      "付费/VIP 声音会失败。")
            self._log("    双击 collect-device-info.cmd 一键采集，采完再跑一次就行。")
        threading.Thread(target=self._worker_download,
                         args=(album, out_dir), daemon=True).start()

    def _worker_download(self, album: str, out_dir: Path):
        node = core.node_bin()
        cmd = [node, "xmd.js", "-a", album, "-o", str(out_dir)]
        if self.var_slow.get():
            cmd.append("-s")
        self.q.put(("log", "[*] " + " ".join(cmd)))
        rc = -1
        album_dir: Path | None = None
        fp_hint = False
        try:
            p = subprocess.Popen(
                cmd, cwd=str(core.project_root()), env=core.child_env(),
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace", bufsize=1,
                creationflags=core.no_window_flags(),
            )
            self.proc = p
            for line in p.stdout:
                line = line.rstrip()
                self.q.put(("log", line))
                m = PROGRESS_RE.search(line)
                if m:
                    self.q.put(("progress", float(m.group(1))))
                # 上游把真实原因糊成一句「受限」，这里把指纹那条线索捡出来
                if "缺少设备指纹" in line or "device-info.json" in line:
                    fp_hint = True
                # 目录名以日志为准。早先是拿「下载目录里修改时间最新的文件夹」
                # 来猜的 —— 目录一多就会张冠李戴，把补零/推送作用到别的专辑上。
                m2 = ALBUM_DIR_RE.search(line)
                if m2:
                    album_dir = out_dir / m2.group(1).strip()
            rc = p.wait()
        except Exception as e:
            self.q.put(("log", f"[x] 运行出错：{e}"))
        finally:
            self.proc = None

        if rc != 0:
            self.q.put(("log", f"[!] 下载器退出码 {rc}"
                               "（常见原因：风控额度用尽，等下一个整点再跑）"))
            if fp_hint:
                self.q.put(("log", "[!] 上面的报错里有设备指纹的线索："
                                   "付费/VIP 声音需要它，免费声音不需要。"))
                self.q.put(("log", "    双击 collect-device-info.cmd → 点「开始自动采集」，"
                                   "大约半分钟，完事再跑一次下载。"))

        if album_dir is not None and album_dir.is_dir():
            target = album_dir
        else:
            # 兜底：日志里没拿到目录名时退回猜测，但要提醒人核对
            albums = sorted(core.list_album_dirs(out_dir),
                            key=lambda d: d.stat().st_mtime, reverse=True)
            if not albums:
                self.q.put(("log", "[!] 下载目录下没有找到专辑文件夹，跳过后续处理"))
                self.q.put(("done", None))
                return
            target = albums[0]
            self.q.put(("log", "[!] 没能从日志里读到专辑目录名，"
                               "按「最近修改」猜的，请核对是不是这一张"))

        self.q.put(("log", ""))
        self.q.put(("log", f"[*] 专辑目录：{target}"))

        if self.var_fix.get():
            core.fix_numbering(target, log=lambda s: self.q.put(("log", s)))

        if self.var_push.get():
            core.push_to_nas(target, log=lambda s: self.q.put(("log", s)))

        n = len([f for f in target.iterdir()
                 if f.suffix.lower() in core.AUDIO_EXT])
        self.q.put(("log", f"[=] 完成：{target.name} 共 {n} 个音频"))
        self.q.put(("done", None))

    def _stop(self):
        p = self.proc
        if p and p.poll() is None:
            p.terminate()
            self._log("[!] 已请求停止")
        self.var_status.set("已停止")

    # ------------------------------------------------------------ 消息泵
    def _drain(self):
        try:
            while True:
                kind, payload = self.q.get_nowait()
                if kind == "log":
                    self._log(payload)
                elif kind == "progress":
                    self.pb.configure(value=payload)
                elif kind == "done":
                    self._set_running(False)
                    self.var_status.set("完成")
        except queue.Empty:
            pass
        self.root.after(100, self._drain)

    def _on_close(self):
        p = self.proc
        if p and p.poll() is None:
            if not messagebox.askyesno(APP_TITLE, "还在下载，确定要退出吗？"):
                return
            p.terminate()
        self.root.destroy()


def main():
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
