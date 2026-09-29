#!/usr/bin/env node
/**
 * 网页控制台 —— 加订阅、看进度、暂停 / 继续。
 *
 * 设计上刻意跟调度器跑在**同一个进程**里，理由有两条：
 *
 * 1) 状态天然共享。暂停按钮要能立刻打断调度器那个动辄几小时的休眠，还要能
 *    掐掉正在跑的专辑子进程，跨进程做就得再搭一套 IPC，不值当。
 *
 * 2) 进度库不能两个人开。nedb 是「整个文件读进内存 + 写时追加」的模型，
 *    两个进程各开一份，后写的会覆盖前者，进度会丢。所以调度器进程自己
 *    从不碰 nedb，网页这边也**不 import nedb**，而是把 db 文件当纯文本
 *    按行解析（nedb 的落盘格式就是 NDJSON）。只读、无锁、每次拿到的都是
 *    子进程刚写完的最新数据 —— 这正好也是「父进程的 nedb 实例看不到子进程
 *    写入」那个坑最省事的绕法。
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {config, dbDirPath} from './common/config.js'
import {projectRoot} from './settings.js'
import {log} from './common/log4jscf.js'
import {state, wake, killCurrent} from './common/control.js'

/** 容器里以 root 跑，写出来的文件属主要拉回宿主机用户，否则以后不好直接编辑 */
const OWNER = {uid: 1000, gid: 1001}

function xmdDir() {
    return String(config.xmd || '~/.xmd').replace('~', os.homedir())
}

function albumsFile() {
    const sched = config.schedule || {}
    return sched.albumsFile
        ? path.resolve(projectRoot, sched.albumsFile)
        : path.join(projectRoot, 'albums.txt')
}

function chownBack(file) {
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) return
    try {
        fs.chownSync(file, OWNER.uid, OWNER.gid)
    } catch (e) {
        // 宿主机上没这个 uid / 没权限就算了，不影响功能
    }
}

/**
 * 把 nedb 文件解析成 Map。nedb 每行一个 JSON：普通文档、`$$deleted` 删除标记、
 * `$$indexCreated` 索引定义混在一起，这里只留「活着的普通文档」。
 *
 * 加 mtime + size 缓存：一张专辑的 track.db 也就几百 KB，但页面 5 秒轮询一次，
 * 没必要每秒都重读一遍磁盘。
 */
const CACHE_TTL = 2000
let cache = {key: '', at: 0, docs: new Map()}

function readNedb(file) {
    const key = file
    const now = Date.now()
    if (cache.key === key && now - cache.at < CACHE_TTL) return cache.docs

    const docs = new Map()
    try {
        const text = fs.readFileSync(file, 'utf-8')
        for (const rawLine of text.split('\n')) {
            const line = rawLine.trim()
            if (line === '') continue
            let o
            try {
                o = JSON.parse(line)
            } catch (e) {
                continue // 半行（正在写）是正常的，跳过
            }
            if (o.$$deleted === true) {
                if (o._id) docs.delete(o._id)
                continue
            }
            if (o.$$indexCreated || o.$$indexRemoved) continue
            if (o._id) docs.set(o._id, o)
        }
    } catch (e) {
        // 文件还不存在（还没跑过第一轮）很正常
    }
    cache = {key, at: now, docs}
    return docs
}

/** 订阅列表：和 scheduler.js 的 parseAlbumIds 保持同一套规则 */
function readSubs() {
    const file = albumsFile()
    const out = []
    try {
        if (!fs.existsSync(file)) return out
        for (const rawLine of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
            const line = rawLine.split('#')[0].trim()
            if (line === '') continue
            const m = line.match(/album\/(\d+)/) || line.match(/(\d{4,})/)
            if (m && !out.includes(m[1])) out.push(m[1])
        }
    } catch (e) {
        log.warn(`网页读订阅列表失败：${e.message}`)
    }
    return out
}

/** 从用户输入里抠出 albumId，认纯数字、专辑链接、带 albumId 参数的链接 */
function parseAlbumId(input) {
    const s = String(input == null ? '' : input).trim()
    if (s === '') return null
    const m = s.match(/album\/(\d+)/)
        || s.match(/[?&]albumId=(\d+)/)
        || s.match(/^(\d{4,})$/)
        || s.match(/(\d{4,})/)
    return m ? m[1] : null
}

function addSub(input) {
    const id = parseAlbumId(input)
    if (id == null) return {ok: false, msg: '没解析出专辑 ID，粘专辑链接或纯数字 ID 都行'}
    if (readSubs().includes(id)) return {ok: false, msg: '这个专辑已经在订阅列表里了', albumId: id}

    const file = albumsFile()
    fs.mkdirSync(path.dirname(file), {recursive: true})
    let text = ''
    try {
        text = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''
    } catch (e) {
        text = ''
    }
    if (text !== '' && !text.endsWith('\n')) text += '\n'
    fs.writeFileSync(file, text + id + '\n')
    chownBack(file)
    // 正在休眠就立刻叫醒，不用等倒计时走完
    wake()
    return {ok: true, albumId: id}
}

function removeSub(id) {
    const file = albumsFile()
    if (!fs.existsSync(file)) return {ok: false, msg: '订阅列表文件不存在'}
    const kept = []
    for (const rawLine of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
        const t = rawLine.split('#')[0].trim()
        if (t === '') {
            kept.push(rawLine)
            continue
        }
        const m = t.match(/album\/(\d+)/) || t.match(/(\d{4,})/)
        if (m && m[1] === String(id)) continue
        kept.push(rawLine)
    }
    fs.writeFileSync(file, kept.join('\n'))
    chownBack(file)
    return {ok: true}
}

/** 每个订阅的进度：总数 / 已完成 / 标题 / 主播，全从进度库推。
 *  注意进度库走 dbDirPath()（全账号共用那份），**不是** xmdDir() —— 多账号下
 *  xmdDir() 只是某个账号的凭据目录，里面没有 track.db。 */
function collectAlbums() {
    const base = path.join(dbDirPath(), 'db', 'file')
    const tracks = readNedb(path.join(base, 'track.db'))
    const albumDocs = readNedb(path.join(base, 'album.db'))

    const meta = new Map()
    for (const doc of albumDocs.values()) {
        if (doc.albumId) meta.set(String(doc.albumId), doc)
    }

    const stats = new Map()
    for (const t of tracks.values()) {
        const id = String(t.albumId)
        let s = stats.get(id)
        if (s == null) {
            s = {total: 0, done: 0}
            stats.set(id, s)
        }
        s.total++
        if (t.path != null) s.done++
    }

    const subs = readSubs()
    const list = subs.map(id => {
        const s = stats.get(id) || {total: 0, done: 0}
        const m = meta.get(id) || {}
        const pct = s.total > 0 ? Number(((s.done / s.total) * 100).toFixed(1)) : 0
        return {
            albumId: id,
            title: m.albumTitle || null,
            anchor: m.anchorName || null,
            // isFinished：0 不间断更新 1 连载中 2 完结
            isFinished: m.isFinished,
            total: s.total,
            done: s.done,
            percent: pct,
            pending: Math.max(0, s.total - s.done),
            // 进度库里查不到任何章节 = 还没跑过，只有订阅
            seen: s.total > 0,
        }
    })

    // 进度库里存在、但已从订阅列表删掉的专辑，单独列出来，免得用户以为数据丢了
    const orphans = []
    for (const id of stats.keys()) {
        if (subs.includes(id)) continue
        const s = stats.get(id)
        orphans.push({albumId: id, title: (meta.get(id) || {}).albumTitle || null, done: s.done, total: s.total})
    }
    return {list, orphans}
}

function buildState() {
    const {list, orphans} = collectAlbums()
    const sched = config.schedule || {}
    const totalDone = list.reduce((a, x) => a + x.done, 0)
    const totalAll = list.reduce((a, x) => a + x.total, 0)
    return {
        now: Date.now(),
        paused: state.paused === true,
        phase: state.phase,
        round: state.round,
        albumId: state.albumId,
        startedAt: state.startedAt,
        uptime: Date.now() - state.startedAt,
        sleepUntil: state.sleepUntil,
        sleepReason: state.sleepReason,
        current: state.current,
        lastRound: state.lastRound,
        sched: state.sched,
        albums: list,
        orphans,
        summary: {
            done: totalDone,
            total: totalAll,
            pending: Math.max(0, totalAll - totalDone),
            percent: totalAll > 0 ? Number(((totalDone / totalAll) * 100).toFixed(1)) : 0,
        },
        env: {
            output: String(config.archives || ''),
            albumsFile: albumsFile(),
            quality: config.quality ? config.quality.mode : null,
            paidLevel: config.quality ? config.quality.paidLevel : null,
            intervalHours: sched.intervalHours,
            slow: sched.slow === true,
            retryMinutes: sched.retryMinutes,
            maxRetries: sched.maxRetries,
            // 主动避让（2026-09-29）：单轮上限 / 当日上限，页面设置区直接显示
            maxPerRound: sched.maxPerRound,
            dailyCap: sched.dailyCap,
            // 多账号（2026-09-29）：账号列表 + 共用的进度库目录。两个上限是**按账号各算一份**的。
            accounts: sched.accounts,
            dbDir: config.dbDir || null,
        },
    }
}

/**
 * 日志：优先用内存里的尾巴（跨重启会丢），太短就从 app.log 兜底读一段。
 * 这样刚重启完打开页面也不至于一片空白。
 */
function collectLog() {
    const lines = state.logTail.slice()
    if (lines.length >= 60) return {lines, source: 'memory'}
    const file = path.join(projectRoot, 'logs', 'app.log')
    try {
        if (fs.existsSync(file)) {
            const text = fs.readFileSync(file, 'utf-8')
            // 本机 Windows 上 log4js 写的是 \r\n，行尾那个 \r 留着会让页面里凭空多空行
            const tail = text.split('\n')
                .map(x => x.replace(/\r$/, ''))
                .filter(x => x.trim() !== '')
                .slice(-200)
            return {lines: lines.length > 0 ? tail.concat(lines) : tail, source: 'file'}
        }
    } catch (e) {
        // 读不到就只给内存里的
    }
    return {lines, source: 'memory'}
}

// ---------------------------------------------------------------- HTTP

function sendJson(res, code, obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf-8')
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': body.length,
    })
    res.end(body)
}

function readBody(req) {
    return new Promise(resolve => {
        let buf = ''
        req.on('data', chunk => {
            buf += chunk
            if (buf.length > 64 * 1024) req.destroy() // 就几个字段，防呆
        })
        req.on('end', () => {
            if (buf === '') return resolve({})
            try {
                resolve(JSON.parse(buf))
            } catch (e) {
                resolve({})
            }
        })
    })
}

async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const p = url.pathname
    const method = req.method

    if (method === 'GET' && (p === '/' || p === '/index.html')) {
        const body = Buffer.from(PAGE, 'utf-8')
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Length': body.length,
        })
        return res.end(body)
    }

    if (method === 'GET' && p === '/api/state') {
        return sendJson(res, 200, {ok: true, data: buildState()})
    }

    if (method === 'GET' && p === '/api/log') {
        return sendJson(res, 200, {ok: true, ...collectLog()})
    }

    if (method === 'POST' && p === '/api/albums') {
        const body = await readBody(req)
        const r = addSub(body.input)
        if (r.ok) log.info(`网页添加订阅：${r.albumId}`)
        else log.warn(`网页添加订阅失败：${r.msg}（输入 ${JSON.stringify(String(body.input || ''))}）`)
        return sendJson(res, r.ok ? 200 : 400, r)
    }

    if (method === 'POST' && p === '/api/albums/remove') {
        const body = await readBody(req)
        const id = String(body.albumId || '')
        if (id === '') return sendJson(res, 400, {ok: false, msg: '缺少 albumId'})
        const r = removeSub(id)
        if (r.ok) log.info(`网页移除订阅：${id}（已下载的文件和进度记录都保留）`)
        return sendJson(res, r.ok ? 200 : 400, r)
    }

    if (method === 'POST' && p === '/api/pause') {
        state.paused = true
        wake()        // 把休眠状态打断，否则要等倒计时走完才生效
        killCurrent() // 正在下的那张专辑掐掉，恢复后从断点续传
        log.warn('网页操作：已暂停自动下载（当前专辑已中止，恢复后自动续传）')
        return sendJson(res, 200, {ok: true, data: buildState()})
    }

    if (method === 'POST' && p === '/api/resume') {
        state.paused = false
        wake()
        log.info('网页操作：继续自动下载')
        return sendJson(res, 200, {ok: true, data: buildState()})
    }

    if (method === 'POST' && p === '/api/run') {
        state.paused = false
        wake()
        log.info('网页操作：立即执行一轮')
        return sendJson(res, 200, {ok: true, data: buildState()})
    }

    if (p.startsWith('/api/')) return sendJson(res, 404, {ok: false, msg: '没有这个接口'})

    res.writeHead(302, {Location: '/'})
    res.end()
}

export function startWebServer() {
    const port = Number(process.env.XMD_WEB_PORT) > 0 ? Number(process.env.XMD_WEB_PORT) : 8787
    const server = http.createServer((req, res) => {
        handle(req, res).catch(e => {
            log.error(`网页请求出错 ${req.method} ${req.url}：${e && e.stack || e}`)
            try {
                sendJson(res, 500, {ok: false, msg: String(e && e.message || e)})
            } catch (e2) {
                // 头都发出去了就算了
            }
        })
    })
    server.on('error', e => {
        log.error(`网页控制台启动失败（端口 ${port}）：${e.message}`)
    })
    server.listen(port, '0.0.0.0', () => {
        log.info(`网页控制台已启动：http://<飞牛IP>:${port}/`)
    })
    return server
}

// 单独 `node web.js` 跑的时候只有页面和订阅管理能用，暂停/立即跑这两类操作
// 打不到调度器 —— 因为调度器在那个进程里跑。生产上由 scheduler.js 启动本模块。
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    startWebServer()
}

// ---------------------------------------------------------------- 前端

const PAGE = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>喜马拉雅下载 · 控制台</title>
<style>
:root{
  --bg:#f3f4f6; --card:#fff; --fg:#16181d; --muted:#6b7280; --line:#e4e6ea;
  --accent:#c8342f; --accent-fg:#fff; --ok:#177f45; --warn:#a5691a; --err:#c02626;
  --bar:#e8eaee; --chip:#f0f1f4; --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0e1014; --card:#171a20; --fg:#e7e9ec; --muted:#98a1ab; --line:#262b34;
    --accent:#d94a44; --ok:#43bd7c; --warn:#d5a04c; --err:#e06661;
    --bar:#232833; --chip:#20242c;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:880px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:17px;margin:0;letter-spacing:.3px;font-weight:600}
h2{font-size:13px;margin:0 0 10px;color:var(--muted);font-weight:600;letter-spacing:.5px}
.top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.spacer{flex:1}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:14px}
.chip{display:inline-flex;align-items:center;gap:6px;background:var(--chip);
  border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:12px;color:var(--muted)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--muted);flex:none}
.dot.run{background:var(--ok);animation:pulse 1.4s infinite}
.dot.pause{background:var(--warn)}
.dot.sleep{background:#4a7fd4}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
button{font:inherit;font-size:13px;padding:6px 14px;border-radius:7px;cursor:pointer;
  border:1px solid var(--line);background:var(--card);color:var(--fg);transition:.15s}
button:hover{border-color:var(--accent);color:var(--accent)}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
button.primary:hover{filter:brightness(1.08);color:var(--accent-fg)}
button:disabled{opacity:.45;cursor:not-allowed}
button:disabled:hover{border-color:var(--line);color:var(--fg)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
input[type=text]{flex:1;min-width:200px;font:inherit;font-size:13px;padding:7px 11px;border-radius:7px;
  border:1px solid var(--line);background:var(--bg);color:var(--fg)}
input[type=text]:focus{outline:none;border-color:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
.kv{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 11px}
.kv .k{font-size:11px;color:var(--muted);margin-bottom:2px}
.kv .v{font-size:13px;font-weight:600;word-break:break-all}
.alb{border-top:1px solid var(--line);padding:12px 0}
.alb:first-child{border-top:none}
.alb-h{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.alb-t{font-size:14px;font-weight:600;word-break:break-all}
.alb-m{font-size:12px;color:var(--muted);font-family:var(--mono)}
.bar{height:6px;background:var(--bar);border-radius:99px;overflow:hidden;margin:8px 0 4px}
.bar>i{display:block;height:100%;background:var(--accent);border-radius:99px;transition:width .4s}
.bar.done>i{background:var(--ok)}
.alb-f{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--muted)}
.alb-f .grow{flex:1}
.log{background:#0b0d11;color:#c8cdd4;border-radius:8px;padding:10px 12px;height:320px;overflow:auto;
  font:12px/1.65 var(--mono);white-space:pre-wrap;word-break:break-all;border:1px solid var(--line)}
.log .w{color:#e0b060}.log .e{color:#e0756f}
.hint{font-size:12px;color:var(--muted);margin-top:8px}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--fg);color:var(--bg);
  padding:8px 16px;border-radius:8px;font-size:13px;opacity:0;transition:.25s;pointer-events:none;z-index:9}
.toast.on{opacity:.94}
.empty{color:var(--muted);font-size:13px;padding:14px 0;text-align:center}
details summary{cursor:pointer;font-size:13px;color:var(--muted);font-weight:600;letter-spacing:.5px;
  list-style:none;user-select:none}
details summary::-webkit-details-marker{display:none}
details summary::before{content:"▸ ";font-size:11px}
details[open] summary::before{content:"▾ "}
details summary:hover{color:var(--accent)}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <h1>喜马拉雅下载 · 控制台</h1>
    <span class="chip" id="chip-phase"><i class="dot" id="dot"></i><span id="phase-text">连接中</span></span>
    <span class="spacer"></span>
    <span class="chip" id="chip-uptime">已运行 -</span>
  </div>

  <div class="card">
    <h2>总览</h2>
    <div class="grid">
      <div class="kv"><div class="k">订阅专辑</div><div class="v" id="sum-albums">-</div></div>
      <div class="kv"><div class="k">已完成</div><div class="v" id="sum-done">-</div></div>
      <div class="kv"><div class="k">待下载</div><div class="v" id="sum-pending">-</div></div>
      <div class="kv"><div class="k">当前轮次</div><div class="v" id="sum-round">-</div></div>
    </div>
    <div class="bar" id="sum-bar" style="margin-top:12px"><i style="width:0"></i></div>
    <div class="hint" id="sum-hint">-</div>
  </div>

  <div class="card">
    <h2>控制</h2>
    <div class="row">
      <button class="primary" id="btn-pause">暂停</button>
      <button id="btn-resume">继续</button>
      <button id="btn-run">立即跑一轮</button>
      <span class="spacer"></span>
      <span class="chip" id="chip-next">-</span>
    </div>
    <div class="hint" id="now-hint">-</div>
  </div>

  <div class="card">
    <h2>添加订阅</h2>
    <div class="row">
      <input type="text" id="in-album" placeholder="粘贴专辑链接，或直接填专辑 ID（如 22216262）" autocomplete="off">
      <button class="primary" id="btn-add">添加</button>
    </div>
    <div class="hint">加完不用重启容器：正闲着会立刻开工，正在下载则等当前专辑结束。</div>
  </div>

  <div class="card">
    <h2>订阅列表</h2>
    <div id="albums"><div class="empty">加载中…</div></div>
  </div>

  <div class="card">
    <details id="logbox">
      <summary>运行日志（最近 400 行）</summary>
      <div class="log" id="log" style="margin-top:10px"></div>
    </details>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
var $ = function(id){ return document.getElementById(id) }
var lastState = null
var busy = false

function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]
  })
}
function dur(ms){
  if (ms == null || ms < 0) return '-'
  var s = Math.floor(ms / 1000)
  var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600)
  var m = Math.floor((s % 3600) / 60), sec = s % 60
  if (d > 0) return d + ' 天 ' + h + ' 小时'
  if (h > 0) return h + ' 小时 ' + m + ' 分'
  if (m > 0) return m + ' 分 ' + sec + ' 秒'
  return sec + ' 秒'
}
function num(n){ return n == null ? '-' : String(n) }
function toast(msg, bad){
  var el = $('toast')
  el.textContent = msg
  el.style.background = bad ? 'var(--err)' : 'var(--fg)'
  el.style.color = '#fff'
  el.classList.add('on')
  clearTimeout(el._t)
  el._t = setTimeout(function(){ el.classList.remove('on') }, 2600)
}

var PHASE = {idle:'空闲', planning:'获取章节列表', running:'下载中', sleeping:'休眠中'}

function render(st){
  lastState = st
  var paused = st.paused === true
  var phase = paused ? 'pause' : st.phase
  var dotCls = paused ? 'pause' : (st.phase === 'sleeping' ? 'sleep' : (st.phase === 'running' || st.phase === 'planning' ? 'run' : ''))
  $('dot').className = 'dot ' + dotCls
  $('phase-text').textContent = paused ? '已暂停' : (PHASE[st.phase] || st.phase)
  $('chip-uptime').textContent = '已运行 ' + dur(st.uptime)

  $('sum-albums').textContent = num(st.albums.length)
  $('sum-done').textContent = num(st.summary.done)
  $('sum-pending').textContent = num(st.summary.pending)
  $('sum-round').textContent = st.round > 0 ? ('第 ' + st.round + ' 轮') : '未开始'
  $('sum-bar').firstChild.style.width = st.summary.percent + '%'
  $('sum-hint').textContent = '共 ' + st.summary.total + ' 集，已完成 ' + st.summary.done
    + '（' + st.summary.percent + '%）'
    + (st.lastRound ? '　·　上轮：成功 ' + st.lastRound.ok + ' / 失败 ' + st.lastRound.fail
        + '，新增 ' + (st.lastRound.downloaded == null ? '?' : st.lastRound.downloaded) + ' 集'
        + '，耗时 ' + st.lastRound.minutes + ' 分钟' : '')

  $('btn-pause').disabled = paused || busy
  $('btn-resume').disabled = !paused || busy
  $('btn-run').disabled = busy

  if (st.sleepUntil) {
    $('chip-next').textContent = '下次唤醒 ' + dur(st.sleepUntil - st.now) + '后'
  } else if (paused) {
    $('chip-next').textContent = '已暂停，不会自动开始'
  } else if (st.phase === 'running' || st.phase === 'planning') {
    $('chip-next').textContent = '正在工作'
  } else {
    $('chip-next').textContent = '待命'
  }

  var hints = []
  if (st.albumId) hints.push('当前专辑 ' + st.albumId)
  if (st.current) {
    hints.push('本专辑进度 ' + st.current.done + '/' + st.current.total + '（' + st.current.pct + '%）')
    if (st.current.title) hints.push('最近：' + st.current.title)
  }
  if (st.sleepReason) hints.push(st.sleepReason)
  $('now-hint').textContent = hints.length ? hints.join('　·　') : '没有正在进行的任务'

  renderAlbums(st)
}

function renderAlbums(st){
  var box = $('albums')
  if (!st.albums.length && !st.orphans.length) {
    box.innerHTML = '<div class="empty">还没有订阅。在上面填专辑链接或 ID 即可。</div>'
    return
  }
  var html = ''
  st.albums.forEach(function(a){
    // 注意字段名是 seen（进度库里有没有这张专辑的章节记录），别写成 saw
    var finished = a.seen && a.pending === 0
    var status = !a.seen ? '等待首次拉取'
      : (finished ? (a.isFinished === 2 ? '已完结 · 全部下载完成' : '全部下载完成')
                  : '待下载 ' + a.pending + ' 集')
    html += '<div class="alb">'
      + '<div class="alb-h">'
      +   '<span class="alb-t">' + (a.title ? esc(a.title) : '（尚未获取到专辑名）') + '</span>'
      +   '<span class="alb-m">' + esc(a.albumId) + (a.anchor ? ' · ' + esc(a.anchor) : '') + '</span>'
      +   '<span class="spacer" style="flex:1"></span>'
      +   '<button data-remove="' + esc(a.albumId) + '">移除</button>'
      + '</div>'
      + '<div class="bar' + (finished ? ' done' : '') + '"><i style="width:' + (a.percent || 0) + '%"></i></div>'
      + '<div class="alb-f">'
      +   '<span>' + a.done + ' / ' + (a.seen ? a.total : '?') + '　' + (a.percent || 0) + '%</span>'
      +   '<span class="grow"></span>'
      +   '<span>' + status + '</span>'
      + '</div>'
      + '</div>'
  })
  if (st.orphans.length) {
    html += '<div class="alb" style="opacity:.7"><div class="alb-f">'
      + '<span>另有 ' + st.orphans.length + ' 个专辑在进度库里但已取消订阅：'
      + st.orphans.map(function(o){ return esc(o.title || o.albumId) + '(' + o.done + '/' + o.total + ')' }).join('、')
      + '。文件和进度都还在，重新订阅即可续传。</span></div></div>'
  }
  box.innerHTML = html
  Array.prototype.forEach.call(box.querySelectorAll('button[data-remove]'), function(b){
    b.onclick = function(){ removeAlbum(b.getAttribute('data-remove')) }
  })
}

function refresh(){
  fetch('/api/state', {cache:'no-store'}).then(function(r){ return r.json() }).then(function(r){
    if (r && r.ok) render(r.data)
    else toast('读取状态失败', true)
  }).catch(function(){ toast('连不上服务', true) })
}

function refreshLog(){
  fetch('/api/log', {cache:'no-store'}).then(function(r){ return r.json() }).then(function(r){
    if (!r || !r.ok) return
    var box = $('log')
    // 停在底部时才自动滚，免得用户翻历史被打断
    var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40
    box.innerHTML = r.lines.map(function(l){
      var cls = /\[ERROR\]/.test(l) ? ' class="e"' : (/\[WARN\]/.test(l) ? ' class="w"' : '')
      return '<span' + cls + '>' + esc(l) + '</span>'
    }).join('\n')
    if (atBottom) box.scrollTop = box.scrollHeight
  }).catch(function(){})
}

function act(path, body, okMsg){
  if (busy) return
  busy = true
  fetch(path, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body || {})
  }).then(function(r){ return r.json() }).then(function(r){
    busy = false
    if (r && r.ok) { if (okMsg) toast(okMsg); refresh() }
    else toast((r && r.msg) || '操作失败', true)
  }).catch(function(e){
    busy = false
    toast('请求出错：' + e.message, true)
  })
}

function addAlbum(){
  var input = $('in-album').value.trim()
  if (input === '') { toast('先填点东西', true); return }
  fetch('/api/albums', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({input: input})
  }).then(function(r){ return r.json() }).then(function(r){
    if (r && r.ok) { $('in-album').value = ''; toast('已添加 ' + r.albumId); refresh() }
    else toast((r && r.msg) || '添加失败', true)
  }).catch(function(e){ toast('请求出错：' + e.message, true) })
}

function removeAlbum(id){
  if (!confirm('确定不再自动下载专辑 ' + id + ' 吗？\n\n已下载的文件和进度记录都会保留，重新添加即可续传。')) return
  act('/api/albums/remove', {albumId: id}, '已移除 ' + id)
}

$('btn-pause').onclick = function(){ act('/api/pause', {}, '已暂停') }
$('btn-resume').onclick = function(){ act('/api/resume', {}, '已继续') }
$('btn-run').onclick = function(){ act('/api/run', {}, '已触发一轮') }
$('btn-add').onclick = addAlbum
$('in-album').addEventListener('keydown', function(e){ if (e.key === 'Enter') addAlbum() })
$('logbox').addEventListener('toggle', function(){ if ($('logbox').open) refreshLog() })

refresh()
refreshLog()
setInterval(refresh, 4000)
setInterval(function(){ if ($('logbox').open) refreshLog() }, 6000)
</script>
</body>
</html>`
