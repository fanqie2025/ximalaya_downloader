#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
喜马拉雅付费声音 · 设备指纹采集助手（图形界面）

免费声音开箱即用；付费 / VIP 声音的播放地址接口带风控，请求头要带 xm-sign，
而这个签名由官方风控 SDK 用**浏览器设备指纹**换取 —— 所以必须从浏览器里采一份。

窗口里给了两条路：

  1. 自动采集（默认走这条）
     程序自己用系统中真实的 Edge / Chrome 打开喜马拉雅，读走风控 SDK 里的设备
     信息，采完自动关窗口。你不需要按 F12、不需要复制粘贴。

     为什么这样采出来的能用：风控拒的是「自动化标志」（--enable-automation、
     navigator.webdriver、cdc_ 之类），不是指纹内容本身。这里浏览器是当普通程序
     启动的，我们只是事后连上它的调试端口读一个 JS 变量，痕迹全干净。

  2. 备用手动（自动这条路不通时用）
     老办法：自己在浏览器 F12 控制台里执行一行命令，把结果读回来。
"""

from __future__ import annotations

import json
import queue
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import ttk
from tkinter.scrolledtext import ScrolledText

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xmcore as core  # noqa: E402

TITLE = "喜马拉雅付费声音 · 设备指纹采集"

# 与上游 README 一字不差，别改
COLLECT_JS = (
    "copy(JSON.stringify((()=>{const s=window.du_web_sdk,"
    "c=s._deviceInfoCollector||s._checkextensions._deviceInfoCollector,o={};"
    "for(const k of Object.keys(c)){const v=c[k];if(typeof v==='function')continue;"
    "try{JSON.stringify(v);o[k]=v}catch(e){}}return o})()))"
)


def describe_existing() -> str:
    """本机那份指纹现在什么样 —— 别让人摸黑重采。"""
    p = core.DEVICE_INFO
    if not p.exists():
        return "本机还没有指纹，付费声音会一直报「被风控」。"
    try:
        info = json.loads(p.read_text(encoding="utf-8"))
        ua = ""
        try:
            ua = str(info["ew1"]["yV2"])[:70]
        except Exception:
            pass
        return (f"本机已有一份指纹：{len(info)} 个字段"
                + (f"\nUser-Agent：{ua}" if ua else ""))
    except Exception as e:
        return f"本机那份指纹读不出来（{e}），建议重采一次。"


class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.q: queue.Queue = queue.Queue()
        self.busy = False

        root.title(TITLE)
        root.geometry("880x720")
        root.minsize(760, 620)

        self.var_sync = tk.BooleanVar(value=True)
        self.var_state = tk.StringVar(value=describe_existing())
        self._build()
        self.root.after(100, self._drain)

        self.log("就绪。直接点「开始自动采集」就行 —— 中途会弹出一个浏览器窗口，")
        self.log("那是采集用的，采完它自己会关，不用管。")
        self.log(f"目标文件：{core.DEVICE_INFO}")

    # ---------------------------------------------------------------- 界面
    def _build(self):
        pad = {"padx": 12, "pady": 5}
        frm = ttk.Frame(self.root, padding=10)
        frm.pack(fill="both", expand=True)
        frm.columnconfigure(0, weight=1)

        # --- 主路径：自动采集
        auto = ttk.LabelFrame(frm, text=" 推荐 · 一键自动采集 ", padding=10)
        auto.grid(row=0, column=0, sticky="ew", **pad)
        auto.columnconfigure(0, weight=1)

        ttk.Label(
            auto, foreground="#333", justify="left",
            text=("点下面这个按钮就走了：程序自己开一个真实浏览器读指纹，采完自动关闭。\n"
                  "不用按 F12，不用复制粘贴。整个过程大约半分钟。"),
        ).grid(row=0, column=0, sticky="w")

        bar = ttk.Frame(auto)
        bar.grid(row=1, column=0, sticky="w", pady=(8, 2))
        self.btn_auto = ttk.Button(bar, text="开始自动采集", width=18,
                                   command=self._auto)
        self.btn_auto.pack(side="left")
        ttk.Checkbutton(bar, text="采完同时同步给飞牛容器（无人值守下载要用）",
                        variable=self.var_sync).pack(side="left", padx=12)

        ttk.Label(auto, foreground="#666", justify="left",
                  textvariable=self.var_state).grid(row=2, column=0, sticky="w",
                                                    pady=(4, 0))

        # --- 备选：手动
        man = ttk.LabelFrame(frm, text=" 备用 · 手动采集（自动方式失败时用） ",
                             padding=10)
        man.grid(row=1, column=0, sticky="ew", **pad)
        man.columnconfigure(0, weight=1)

        ttk.Label(
            man, foreground="#555", justify="left",
            text=("用你**日常在用的** Chrome 或 Edge 打开 https://www.ximalaya.com，\n"
                  "按 F12 → 切到 Console（控制台）→ 粘贴下面这行 → 回车，\n"
                  "结果会自动进剪贴板，然后回到这里点第二个按钮。"),
        ).grid(row=0, column=0, sticky="w")

        self.txt_js = tk.Text(man, height=4, wrap="char", font=("Consolas", 9))
        self.txt_js.grid(row=1, column=0, sticky="ew", pady=(6, 4))
        self.txt_js.insert("1.0", COLLECT_JS)
        self.txt_js.configure(state="disabled")

        bar2 = ttk.Frame(man)
        bar2.grid(row=2, column=0, sticky="w")
        ttk.Button(bar2, text="复制这行命令", width=16,
                   command=self._copy_js).pack(side="left")
        ttk.Button(bar2, text="从剪贴板读取并保存", width=22,
                   command=self._save_clipboard).pack(side="left", padx=8)

        # --- 日志
        logf = ttk.LabelFrame(frm, text=" 日志 ", padding=8)
        logf.grid(row=2, column=0, sticky="nsew", **pad)
        frm.rowconfigure(2, weight=1)
        logf.columnconfigure(0, weight=1)
        self.log_box = ScrolledText(logf, height=16, wrap="word",
                                    font=("Consolas", 9))
        self.log_box.grid(row=0, column=0, sticky="nsew")
        self.log_box.configure(state="disabled")

    # ---------------------------------------------------------------- 工具
    def log(self, text: str):
        self.log_box.configure(state="normal")
        self.log_box.insert("end", text + "\n")
        self.log_box.see("end")
        self.log_box.configure(state="disabled")

    def _set_busy(self, on: bool):
        self.busy = on
        self.btn_auto.configure(state="disabled" if on else "normal")

    def _drain(self):
        try:
            while True:
                kind, payload = self.q.get_nowait()
                if kind == "log":
                    self.log(payload)
                elif kind == "state":
                    self.var_state.set(payload)
                elif kind == "done":
                    self._set_busy(False)
        except queue.Empty:
            pass
        self.root.after(100, self._drain)

    def _copy_js(self):
        self.root.clipboard_clear()
        self.root.clipboard_append(COLLECT_JS)
        self.log("[+] 命令已复制。去浏览器控制台粘贴执行。")

    # ---------------------------------------------------------------- 自动采集
    def _auto(self):
        if self.busy:
            self.log("[=] 上一轮还在跑，先等它结束。")
            return
        self._set_busy(True)
        self.log("")
        self.log("=== 自动采集开始 ===")
        threading.Thread(target=self._worker_auto, daemon=True).start()

    def _worker_auto(self):
        def emit(s):
            self.q.put(("log", s))

        try:
            rc, out = core.run_collect_fingerprint(log=emit)
            if rc != 0 or out is None:
                emit("[x] 自动采集没成功。可以试下面的备用手动方式，")
                emit("    或者把上面的日志发我，我看是哪一步卡住了。")
                return
            if not core.install_device_info(out, log=emit):
                emit("[!] 校验没过，没有覆盖本机指纹 —— 原来那份还能继续用。")
                return
            if self.var_sync.get():
                core.push_device_info(log=emit)
            else:
                emit("[=] 没勾同步。容器要用时勾上再采一次，或手动 scp。")
            emit("[+] 搞定了。付费 / VIP 声音现在应该能正常下载。")
        except Exception as e:
            emit(f"[x] 出错：{e}")
        finally:
            self.q.put(("state", describe_existing()))
            self.q.put(("done", None))

    # ---------------------------------------------------------------- 手动采集
    def _save_clipboard(self):
        if self.busy:
            self.log("[=] 自动采集正在跑，等它结束再用这条。")
            return
        try:
            raw = self.root.clipboard_get()
        except tk.TclError:
            self.log("[!] 剪贴板是空的。先在浏览器控制台里执行那行命令。")
            return

        try:
            info = json.loads(raw)
        except Exception as e:
            self.log(f"[!] 剪贴板内容不是合法 JSON：{e}")
            self.log(f"    开头是：{raw[:120]}")
            self.log("    提示：要复制的是控制台执行后的**结果**，不是那行命令本身。")
            return

        problems = core.validate_device_info(info)
        if problems:
            self.log("[!] 校验没通过，没有写盘：")
            for p in problems:
                self.log(f"    · {p}")
            self.log("    常见原因：没在 ximalaya.com 页面上执行 / 页面没登录 /"
                     "复制了别的东西。")
            return

        # 复用同一条落盘路径，别让手动这条路绕开校验
        tmp = core.project_root() / core.COLLECTED_NAME
        try:
            tmp.write_text(
                json.dumps(info, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8")
        except Exception as e:
            self.log(f"[x] 写临时文件失败：{e}")
            return

        if not core.install_device_info(tmp, log=self.log):
            return

        if self.var_sync.get():
            core.push_device_info(log=self.log)
        else:
            self.log("[=] 没勾同步。需要时手动跑："
                     "scp 该文件到飞牛 /vol1/1000/docker/ximalaya-auto/xmd/")
        self.var_state.set(describe_existing())


def main():
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
