#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
喜马拉雅下载器 —— 公共逻辑（CLI 与图形界面共用，避免两边走偏）

只管四件事：
  1. 找到 node 与项目根目录（打包成 exe 后也要能找到）
  2. 清掉代理环境变量（不清会让 axios 把明文 HTTP 发到 443 端口，登录必 400）
  3. 读写 settings.local.json（下载目录 + 音质档位）
  4. 补零重命名 / 推送飞牛
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

# Windows 控制台默认 GBK，直接 print 中文/emoji 会炸
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

# 代理环境变量：指向 HTTP 代理时，axios 对 https:// 的请求会变成明文 HTTP
# 直发 443 端口，服务端回 "The plain http request was sent to https port"（400），
# 登录直接失败。喜马拉雅是国内站，本机分流本就直连，一律清掉。
PROXY_KEYS = (
    "http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY",
    "all_proxy", "ALL_PROXY",
)

# node 的查找顺序（公开仓库里不写任何个人路径，见 node_bin()）：
#   1) 自带的便携版 node/node[.exe]（相对项目根）
#   2) 环境变量 XMD_NODE 指定的可执行文件
#   3) PATH 里的 node
#   4) 几个常见安装位置
NODE_ENV = "XMD_NODE"
NODE_CANDIDATES = [
    # 优先用工具自带的便携版 Node —— 不依赖系统里那一份。
    Path("node/node.exe"),
    Path("node/node"),
    Path("node/bin/node"),
]
NODE_COMMON = [
    Path(r"C:\Program Files\nodejs\node.exe"),
    Path(r"C:\Program Files (x86)\nodejs\node.exe"),
    Path("/usr/local/bin/node"),
    Path("/usr/bin/node"),
    Path("/opt/homebrew/bin/node"),
]

# 与 JS 侧 common/naming.js 的 isAudioFileName 保持同一套后缀：
# 曾经漏掉 .mp4，害得音频被判成「没下」。
AUDIO_EXT = {".m4a", ".mp4", ".m4b", ".mp3", ".mp2", ".aac", ".flac",
             ".ogg", ".oga", ".opus", ".wav", ".wma"}
NUM_PREFIX = re.compile(r"^(\d{1,5})\s*[.、_\-\s]\s*(.*)$")

QUALITY_LABELS = {
    "high": "高音质",
    "standard": "标准",
    "low": "省流量",
}
QUALITY_FROM_LABEL = {v: k for k, v in QUALITY_LABELS.items()}

# 飞牛（NAS）主机，形如「用户名@地址」。公开仓库里不放真实地址：由
# settings.local.json 的 nasHost（该文件在 .gitignore 里）或环境变量
# XMD_FEINI_HOST 提供；两处都没配就停下来提示，不瞎猜一个地址去连。
FEINI_HOST_ENV = "XMD_FEINI_HOST"
ABS_LIB = "/vol1/1000/youshengshu"
# 飞牛上自动下载容器的项目目录（凭据与设备指纹都往这里放）。
# 注意是 /vol2 —— 飞牛的 docker 项目统一放 /vol2/1000/docker/，
# 而媒体库 youshengshu 在 /vol1（那块盘大，1.4T 空余；/vol2 只剩十几 G，
# 下载文件绝不能往那边写）。
FNOS_DOCKER_DIR = "/vol2/1000/docker/ximalaya-auto"
FNOS_XMD_DIR = f"{FNOS_DOCKER_DIR}/xmd"
# 付费/VIP 声音靠它换 xm-sign。免费声音不需要。
DEVICE_INFO = Path.home() / ".xmd" / "device-info.json"

DEFAULT_SETTINGS = {
    "archives": "",
    # 飞牛主机（用户名@地址），推送 ABS 库和设备指纹时用。空 = 还没配。
    "nasHost": "",
    "quality": {"mode": "high", "paidLevel": 1},
    "naming": {
        "template": "《{title}》{anchor} {author}",
        "padWidth": 4,
        "authorGuess": True,
    },
    "schedule": {
        "albumsFile": "config/albums.txt",
        "intervalHours": 12,
        "concurrency": 3,
        "slow": False,
        "retryMinutes": 30,
        "maxRetries": 6,
        "backoffAt": "00:05",
    },
}


# ---------------------------------------------------------------- 路径与环境

def project_root() -> Path:
    """打包成 exe 后用 exe 所在目录，脚本运行时用脚本所在目录。"""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def node_bin() -> str | None:
    """找 node。相对路径一律相对「项目根」解析 ——
    双击 exe 启动时工作目录不一定是 exe 所在目录，用 os.getcwd() 会找错地方。

    顺序：自带便携版 → 环境变量 XMD_NODE → PATH → 常见安装位置。
    公开仓库里不放个人路径：以前写死了某台机器的 WorkBuddy / D:\\nodejs，
    换个环境就是死路，也会把个人目录结构泄出去。
    """
    root = project_root()
    for p in NODE_CANDIDATES:
        cand = p if p.is_absolute() else (root / p)
        if cand.exists():
            return str(cand)
    env_node = os.environ.get(NODE_ENV, "").strip()
    if env_node:
        cand = Path(env_node)
        if not cand.is_absolute():
            cand = root / cand
        if cand.exists():
            return str(cand)
    found = shutil.which("node")
    if found:
        return found
    for p in NODE_COMMON:
        if p.exists():
            return str(p)
    return None


def child_env() -> dict:
    env = os.environ.copy()
    for k in PROXY_KEYS:
        env.pop(k, None)
    return env


def no_window_flags() -> int:
    """让子进程不要弹出黑色控制台窗口（仅 Windows 有效）。"""
    return getattr(subprocess, "CREATE_NO_WINDOW", 0)


# ---------------------------------------------------------------- 设置读写

def settings_path() -> Path:
    return project_root() / "settings.local.json"


def load_settings() -> dict:
    s = json.loads(json.dumps(DEFAULT_SETTINGS))  # 深拷贝
    p = settings_path()
    if p.exists():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            s.update({k: v for k, v in data.items() if k != "quality"})
            if isinstance(data.get("quality"), dict):
                s["quality"].update(data["quality"])
        except Exception:
            pass
    if not s.get("archives"):
        s["archives"] = str(project_root() / "下载")
    return s


def save_settings(archives: str, quality_mode: str, paid_level: int = 1) -> None:
    """只覆盖 archives / quality，其余键原样保留。

    早先这里是整份重写：GUI 里改一次下载目录，naming（目录命名模板）和
    schedule（容器调度）两段配置就被无声抹掉了，下次跑下载目录名全变，
    整库重下。所以这里必须先读、再改、再写回。
    """
    data = {}
    p = settings_path()
    if p.exists():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            data = {}
    if not isinstance(data, dict):
        data = {}
    data["archives"] = archives
    data["quality"] = {"mode": quality_mode, "paidLevel": int(paid_level)}
    p.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def feini_host() -> str:
    """飞牛主机（用户名@地址）。环境变量优先，其次 settings.local.json 的 nasHost。

    每次调用现读，改完设置不用重启；都没配就返回空串，由调用方提示。
    """
    env = (os.environ.get(FEINI_HOST_ENV) or "").strip()
    if env:
        return env
    try:
        return str(load_settings().get("nasHost") or "").strip()
    except Exception:
        return ""


# ---------------------------------------------------------------- 补零重命名

def fix_numbering(album_dir, log=print) -> int:
    """把 `1.标题.mp3` 补零成 `0001.标题.mp3`，让 ABS 按数字顺序识别章节。

    判据是「数字位宽是否一致」，不是文件个数 —— 8 个文件命名成
    1,10,11,12,2,3,9 照样乱序。统一补到 4 位，与 ABS 库既有规范一致。
    """
    album_dir = Path(album_dir)
    if not album_dir.is_dir():
        log(f"[!] 目录不存在，跳过补零：{album_dir}")
        return 0

    files = [f for f in album_dir.iterdir()
             if f.is_file() and f.suffix.lower() in AUDIO_EXT]
    if not files:
        log(f"[=] {album_dir.name}：目录下没有音频")
        return 0

    parsed = []
    for f in sorted(files, key=lambda p: p.name):
        m = NUM_PREFIX.match(f.stem)
        if m:
            parsed.append((f, int(m.group(1)), m.group(2).strip()))

    if not parsed:
        log(f"[=] {album_dir.name}：文件名没有序号前缀，原样不动")
        return 0

    width = max(4, len(str(max(p[1] for p in parsed))))
    if all(len(str(n)) == width for _, n, _ in parsed):
        log(f"[=] {album_dir.name}：序号已统一为 {width} 位，无需补零")
        return 0

    plan, taken = [], set()
    for f, num, title in parsed:
        new_name = (f"{num:0{width}d}.{title}{f.suffix}" if title
                    else f"{num:0{width}d}{f.suffix}")
        if new_name == f.name:
            continue
        if (album_dir / new_name).exists() or new_name in taken:
            log(f"[!] 目标已存在，跳过：{new_name}")
            continue
        plan.append((f, album_dir / new_name))
        taken.add(new_name)

    if not plan:
        log(f"[=] {album_dir.name}：命名已符合规范")
        return 0

    # 两步走：先改成临时名，避免 A->B、B->A 互相覆盖
    staged = []
    for src, dst in plan:
        tmp = src.with_name(src.name + ".tmpren")
        src.rename(tmp)
        staged.append((tmp, dst))
    for tmp, dst in staged:
        tmp.rename(dst)

    log(f"[+] {album_dir.name}：补零重命名 {len(plan)} 个文件（统一 {width} 位）")
    return len(plan)


def list_album_dirs(root) -> list:
    root = Path(root)
    if not root.is_dir():
        return []
    return [d for d in root.iterdir() if d.is_dir()]


# ---------------------------------------------------------------- 推送飞牛

def push_to_nas(album_dir, lib=ABS_LIB, log=print) -> int:
    album_dir = Path(album_dir)
    if not album_dir.is_dir():
        log(f"[!] 目录不存在，跳过推送：{album_dir}")
        return 1
    host = feini_host()
    if not host:
        log(f"[!] 还没配置飞牛主机：在 settings.local.json 里写 "
            f"\"nasHost\": \"用户名@地址\"，或设环境变量 {FEINI_HOST_ENV}")
        return 1
    dest = f"{host}:{lib}/"
    log(f"[*] 推送到飞牛 {dest}（可能要一会儿）")
    rc = subprocess.call(
        ["scp", "-r", "-o", "BatchMode=yes", str(album_dir), dest],
        env=child_env(), creationflags=no_window_flags(),
    )
    if rc == 0:
        log("[+] 推送完成。去 ABS 后台对该媒体库触发一次扫描即可入库。")
    else:
        log("[x] 推送失败，检查到飞牛的免密登录是否还有效")
    return rc


def push_device_info(src=None, log=print) -> int:
    """把设备指纹同步到飞牛容器。

    指纹必须从**日常在用的浏览器**里采（自动化浏览器采出来的会被风控直接拒），
    而容器里没有浏览器 —— 所以只能本机采一次、推过去，两边共用同一份。
    """
    src = Path(src) if src else DEVICE_INFO
    if not src.exists():
        log(f"[!] 指纹文件不存在：{src}")
        return 1
    host = feini_host()
    if not host:
        log(f"[!] 还没配置飞牛主机：在 settings.local.json 里写 "
            f"\"nasHost\": \"用户名@地址\"，或设环境变量 {FEINI_HOST_ENV}")
        return 1
    dest = f"{host}:{FNOS_XMD_DIR}/device-info.json"
    log(f"[*] 同步到飞牛 {dest}")
    rc = subprocess.call(
        ["scp", "-o", "BatchMode=yes", str(src), dest],
        env=child_env(), creationflags=no_window_flags(),
    )
    if rc == 0:
        log("[+] 已同步，容器下一轮扫描就会用上")
    else:
        log("[x] 同步失败，检查到飞牛的免密登录是否还有效")
    return rc


# ---------------------------------------------------------------- 设备指纹采集

COLLECT_SCRIPT = "collect-fingerprint.js"
COLLECTED_NAME = "_device-info.collected.json"
_FP_OUT_RE = re.compile(r"^XMD_FP_OUT=(.+)$")


def validate_device_info(info) -> list:
    """挑出致命问题，空列表表示能用。

    两个入口（自动采集 / 手动剪贴板）共用这一份判据，避免只有一边收紧。
    """
    if not isinstance(info, dict):
        return ["内容不是 JSON 对象，可能复制到别的东西了"]
    problems = []
    if "ew1" not in info:
        problems.append(
            "找不到 ew1 字段 —— 多半不是在 ximalaya.com 页面上采的")
    elif not isinstance(info["ew1"], dict) or "yV2" not in info["ew1"]:
        problems.append("ew1.yV2 缺失 —— 采到的不是风控 SDK 的设备信息")
    if len(info) < 20:
        problems.append(
            f"只采到 {len(info)} 个字段，正常有几十上百个，八成不完整")
    return problems


def install_device_info(src, log=print) -> bool:
    """校验通过才覆盖 ~/.xmd/device-info.json。

    采集产物先落临时文件、校验过关再顶替，是为了别让「采到一半」把原本能用
    的那份指纹弄坏 —— 弄坏了付费声音会全线报「被风控」，而且看不出原因。
    """
    src = Path(src)
    try:
        info = json.loads(src.read_text(encoding="utf-8"))
    except Exception as e:
        log(f"[x] 读不出采集结果 {src}：{e}")
        return False

    problems = validate_device_info(info)
    if problems:
        log("[!] 校验没通过，没有覆盖本机指纹：")
        for p in problems:
            log(f"    · {p}")
        return False

    DEVICE_INFO.parent.mkdir(parents=True, exist_ok=True)
    DEVICE_INFO.write_text(
        json.dumps(info, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    ua = ""
    try:
        ua = str(info["ew1"]["yV2"])
    except Exception:
        pass
    log(f"[+] 指纹已生效：{DEVICE_INFO}（{len(info)} 个字段）")
    if ua:
        log(f"    User-Agent：{ua}")
    return True


def run_collect_fingerprint(log=print):
    """自动采集设备指纹，逐行把 node 的输出交给 log。返回 (退出码, 产物路径)。

    做法：用**真实浏览器**正常启动（不带任何自动化开关），再通过 CDP 调试端口
    把风控 SDK 里的设备信息读出来。被风控拒的是「自动化标志」而不是指纹内容本身，
    所以这样采出来的指纹是能用的；Playwright / Selenium 那种才会被直接拒。
    """
    node = node_bin()
    if node is None:
        log("[x] 找不到 Node.js，无法自动采集")
        return 1, None

    root = project_root()
    script = root / COLLECT_SCRIPT
    if not script.exists():
        log(f"[x] 找不到采集脚本：{script}")
        return 1, None

    cmd = [node, str(script)]
    log("[*] " + " ".join(cmd))
    out_path = None
    try:
        p = subprocess.Popen(
            cmd, cwd=str(root), env=child_env(),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
            creationflags=no_window_flags(),
        )
        for line in p.stdout:
            line = line.rstrip()
            log(line)
            m = _FP_OUT_RE.match(line)
            if m:
                out_path = Path(m.group(1).strip())
        rc = p.wait()
    except Exception as e:
        log(f"[x] 自动采集出错：{e}")
        return 1, None

    if out_path is None:
        out_path = root / COLLECTED_NAME
    if not out_path.exists():
        log(f"[x] 没找到采集产物：{out_path}")
        return rc or 1, None
    return rc, out_path
