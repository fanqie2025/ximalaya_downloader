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
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {config, dbDirPath} from './common/config.js'
import {projectRoot} from './settings.js'
import {log} from './common/log4jscf.js'
import {state, wake, killCurrent} from './common/control.js'
import {
    accountsFile,
    readAccounts,
    addAccount,
    removeAccount,
    normalizeName,
    readStatus,
    updateStatus,
    isDisabled,
    disabledReason,
    accountDirFor,
    findCredential,
    dbDir as sharedDbDir,
} from './common/accountstore.js'
import {loadAlbumMeta} from './common/naming.js'
import {assetSummary} from './common/albumassets.js'
import {
    identifyLibrary,
    invalidateLibraryCache,
    parseNumSpec,
    readIgnore,
    scanLibrary,
    writeIgnore,
    writeSkip,
} from './common/library.js'

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
        // 账号（v7）：每个账号的凭据 / 指纹 / 探测结论 / 今日额度。调度器那条链跟这个共用一份状态文件。
        accounts: collectAccounts(),
        probing: state.probing || null,
        accountsFile: accountsFile(),
        // 库里已有的书（v8）：下载目录里有什么、下完没有。60 秒缓存，轮询页面不会一直扫盘。
        library: collectLibrary(false),
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
            // v7：账号名单文件（网页面板可增删，改完不用重启容器）
            accountsFile: accountsFile(),
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

// ---------------------------------------------------------------- 账号（v7）

const PROBE_TIMEOUT_MS = 120000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
// 正在扫码登录的子进程：账号名 → {child, type, at}。同一账号重复点登录时，先把上一个收掉。
const loginJobs = new Map()

/**
 * 跑 probe-account.js 子进程，取回最后那行 XMD_PROBE_RESULT。
 * 为什么是子进程：config.xmd 在进程启动时就定死了，探第二个账号必须换个进程。
 * 失败（超时 / 起不来）返回 {ok:false, msg} —— 上层**不能**据此判定账号失效。
 */
function runProbe(name, extraArgs = []) {
    return new Promise(resolve => {
        let child
        try {
            child = spawn(process.execPath, ['probe-account.js', name, ...extraArgs], {
                cwd: projectRoot,
                env: {...process.env, XMD_XMD_DIR: accountDirFor(name), XMD_DB_DIR: sharedDbDir()},
                stdio: ['ignore', 'pipe', 'pipe'],
            })
        } catch (e) {
            return resolve({ok: false, msg: `探测进程起不来：${e.message}`})
        }
        let out = ''
        const eat = chunk => {
            out += String(chunk)
        }
        child.stdout.on('data', eat)
        child.stderr.on('data', eat)
        const timer = setTimeout(() => {
            try {
                child.kill('SIGKILL')
            } catch (e) {
                // 杀不掉就算了，它自己会退
            }
            resolve({ok: false, msg: `探测超时（${Math.round(PROBE_TIMEOUT_MS / 1000)} 秒）：接口慢或者网络不通，不一定是账号坏了`})
        }, PROBE_TIMEOUT_MS)
        child.on('close', () => {
            clearTimeout(timer)
            const lines = out.split(/\r?\n/)
            for (let i = lines.length - 1; i >= 0; i--) {
                const l = lines[i].trim()
                if (!l.startsWith('XMD_PROBE_RESULT=')) continue
                try {
                    return resolve({ok: true, data: JSON.parse(l.slice('XMD_PROBE_RESULT='.length))})
                } catch (e) {
                    return resolve({ok: false, msg: '探测输出解析失败'})
                }
            }
            resolve({ok: false, msg: '探测没回结果（子进程可能崩了，看日志）'})
        })
    })
}

function statOf(file) {
    try {
        const st = fs.statSync(file)
        return {exists: true, size: st.size, mtime: st.mtimeMs}
    } catch (e) {
        return {exists: false, size: 0, mtime: null}
    }
}

/** 指纹文件：账号目录里那份优先；没有就用共用目录那份（跟 xm-sign.deviceInfoPath 的兜底一致） */
function fingerprintPaths(name) {
    const dir = accountDirFor(name)
    const own = path.join(dir, 'device-info.json')
    const shared = path.join(sharedDbDir(), 'device-info.json')
    return {own, shared}
}

/** 一个账号在页面上的完整样子：名字 / 目录 / 凭据 / 指纹 / 状态 / 今日额度 */
function accountView(name) {
    const dir = accountDirFor(name)
    const cred = findCredential(dir)
    const rec = readStatus()[name] || null
    const {own, shared} = fingerprintPaths(name)
    const fp = statOf(own)
    const fpShared = statOf(shared)
    const daily = (((state.sched || {}).accounts) || []).find(a => a.name === name) || null
    const job = loginJobs.get(name) || null
    return {
        name,
        dir,
        credential: cred ? path.basename(cred) : null,
        credentialAt: cred ? statOf(cred).mtime : null,
        status: rec,
        disabled: isDisabled(rec),
        disabledReason: disabledReason(rec),
        probing: state.probing === name,
        logging: job != null,
        daily,
        fingerprint: {
            path: own,
            exists: fp.exists,
            size: fp.size,
            mtime: fp.mtime,
            sharedPath: fpShared.exists ? shared : null,
            usingShared: !fp.exists && fpShared.exists,
            checked: rec && rec.fingerprint ? rec.fingerprint : null,
            checkedAt: rec && rec.fingerprintAt ? rec.fingerprintAt : null,
        },
    }
}

function collectAccounts() {
    return readAccounts().map(accountView)
}

// ------------------------------------------------------- 库里已有的书（v8）
// 面板上「库中已有书籍」直接看下载目录，不看订阅列表 —— 订阅列表只说明「打算下什么」，
// 这张卡片回答的是「盘里到底有什么、下完没有」。认专辑的顺序：sidecar → 目录名吻合
// （按书名去搜喜马拉雅这条路走不通，风控直接回 risk invalid，所以对不上就得手工绑定）。

/** 下载目录（config.archives）。跟调度器算的是同一个地方，改一处要记得另一处 */
function archivesDir() {
    return path.resolve(String(config.archives || '~/Downloads').replace('~', os.homedir()))
}

/** 进度库里的专辑记录。web.js 刻意不 import nedb，一律把 db 文件当 NDJSON 读 */
function albumDocs() {
    const base = path.join(dbDirPath(), 'db', 'file')
    return [...readNedb(path.join(base, 'album.db')).values()]
}

function collectLibrary(force = false) {
    const root = archivesDir()
    try {
        const rows = identifyLibrary(scanLibrary(root, {force}), albumDocs(), loadAlbumMeta())
        return {root, rows}
    } catch (e) {
        log.warn(`扫下载目录失败：${e.message}`)
        return {root, rows: [], error: e.message}
    }
}

/** 补附件要借一个账号的凭据：挑第一个有凭据的就行（调度器那边才需要按轮转挑）*/
function pickJobAccount() {
    const names = readAccounts()
    for (const n of names) {
        if (findCredential(accountDirFor(n)) != null) return n
    }
    return names.length > 0 ? names[0] : null
}

/** 跑 assets.js 补封面/简介/主播，读它最后打的那行 XMD_ASSETS={...} */
function runAssetsJob(name, albumId, dir) {
    return new Promise(resolve => {
        let child
        try {
            child = spawn(process.execPath, ['assets.js', String(albumId), dir], {
                cwd: projectRoot,
                env: {...process.env, XMD_XMD_DIR: accountDirFor(name), XMD_DB_DIR: sharedDbDir()},
                stdio: ['ignore', 'pipe', 'pipe'],
            })
        } catch (e) {
            return resolve({ok: false, error: e.message})
        }
        let buf = ''
        let settled = false
        const done = out => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(out)
        }
        const timer = setTimeout(() => {
            try {
                child.kill('SIGKILL')
            } catch (e) {
                // 已经退了
            }
            done({ok: false, error: '补封面超时（90 秒）'})
        }, 90000)
        const onData = c => {
            const s = c.toString()
            buf += s
            process.stdout.write(s)
        }
        child.stdout.on('data', onData)
        child.stderr.on('data', onData)
        child.on('error', e => done({ok: false, error: e.message}))
        child.on('close', code => {
            const m = /XMD_ASSETS=(\{.*\})/m.exec(buf)
            let out = null
            if (m) {
                try {
                    out = JSON.parse(m[1])
                } catch (e) {
                    out = null
                }
            }
            done(out || {ok: false, error: `assets.js 退出码 ${code}`})
        })
    })
}

/** 这个接口会往目录里写文件，所以目录必须在下载目录之下，别的路径一律拒绝 */
function insideArchives(dir) {
    const root = archivesDir()
    const p = path.resolve(String(dir == null ? '' : dir))
    if (p === root) return null
    return p.startsWith(root + path.sep) ? p : null
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
        const body = readPanel('index.html')
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Length': body.length,
        })
        return res.end(body)
    }

    if (method === 'GET' && p === '/panel/app.js') {
        const body = readPanel('app.js')
        res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
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

    // ------------------------------------------------------------ 账号（v7）
    // 一串账号相关的接口。共同的规矩：改完都回 collectAccounts()，页面直接重画账号卡片。

    if (method === 'GET' && p === '/api/accounts') {
        return sendJson(res, 200, {ok: true, data: collectAccounts()})
    }

    if (method === 'POST' && p === '/api/accounts/add') {
        const body = await readBody(req)
        const r = addAccount(body.name)
        if (r.ok) log.info(`网页操作：添加账号 ${r.name}（目录 ${r.dir}）—— 还得扫码登录才能上场`)
        else log.warn(`网页操作：添加账号失败 —— ${r.msg}`)
        return sendJson(res, r.ok ? 200 : 400, {...r, data: collectAccounts()})
    }

    if (method === 'POST' && p === '/api/accounts/remove') {
        const body = await readBody(req)
        const r = removeAccount(body.name)
        if (r.ok) log.warn(`网页操作：把账号 ${r.name} 移出名单（凭据文件留在磁盘上，没有删）`)
        return sendJson(res, r.ok ? 200 : 400, {...r, data: collectAccounts()})
    }

    if (method === 'POST' && p === '/api/accounts/disable') {
        const body = await readBody(req)
        const name = normalizeName(body.name)
        if (name == null) return sendJson(res, 400, {ok: false, msg: '账号名不对'})
        updateStatus(name, {disabled: true, reason: '网页上手动禁用'})
        log.warn(`网页操作：禁用账号 ${name}（不再参与轮转，凭据不删）`)
        return sendJson(res, 200, {ok: true, data: collectAccounts()})
    }

    if (method === 'POST' && p === '/api/accounts/enable') {
        const body = await readBody(req)
        const name = normalizeName(body.name)
        if (name == null) return sendJson(res, 400, {ok: false, msg: '账号名不对'})
        // 手动启用把两种禁用一起解掉：用户说能用了就是能用了
        updateStatus(name, {disabled: false, autoDisabled: false, reason: ''})
        log.info(`网页操作：启用账号 ${name}`)
        return sendJson(res, 200, {ok: true, data: collectAccounts()})
    }

    // 真探一次（子进程跑 probe-account.js：查两个通道的登录态 + 报一次指纹）
    if (method === 'POST' && p === '/api/accounts/probe') {
        const body = await readBody(req)
        const name = normalizeName(body.name)
        if (name == null) return sendJson(res, 400, {ok: false, msg: '账号名不对'})
        log.info(`网页操作：探测账号 ${name}`)
        state.probing = name
        let r
        try {
            r = await runProbe(name)
        } finally {
            state.probing = null
        }
        if (!r.ok) {
            // 探测本身失败（超时 / 崩了）：只报错，**不动**账号状态，免得把好账号判死
            log.warn(`账号 ${name} 探测没拿到结果：${r.msg}`)
            return sendJson(res, 200, {ok: false, msg: r.msg, data: collectAccounts()})
        }
        const d = r.data
        const patch = {
            at: d.at || Date.now(),
            alive: d.alive === true,
            reason: d.alive === true ? '' : (d.reason || '探测未通过'),
            uid: d.uid,
            nickname: d.nickname,
            vip: d.vip,
            vipExpire: d.vipExpire,
            robot: d.robot,
            ban: d.ban,
            channels: d.channels,
            fingerprint: d.fingerprint,
            fingerprintAt: Date.now(),
        }
        // 探活了就自动解掉「探测判死」那个禁用；手动禁用的那个不动（得用户自己点启用）
        if (patch.alive) patch.autoDisabled = false
        updateStatus(name, patch)
        log.info(`账号 ${name} 探测完成：${d.alive ? '可用' : '不可用 —— ' + patch.reason}`)
        return sendJson(res, 200, {ok: true, data: collectAccounts(), probe: d})
    }

    // 扫码登录：起 login.js 子进程（它内部会拉二维码、写进账号目录，并等扫码）
    if (method === 'POST' && p === '/api/accounts/login') {
        const body = await readBody(req)
        const name = normalizeName(body.name)
        if (name == null) return sendJson(res, 400, {ok: false, msg: '账号名不对'})
        const prev = loginJobs.get(name)
        if (prev) {
            try {
                prev.child.kill('SIGKILL')
            } catch (e) {
                // 已经退出了
            }
            loginJobs.delete(name)
        }
        // web = 网页端（www2 通道），pc = 电脑版（mac 通道）；两个都扫才最稳，但一个也能下
        const type = body.type === 'pc' ? 'pc' : 'web'
        const chan = type === 'pc' ? 'mac' : 'www2'
        const dir = accountDirFor(name)
        fs.mkdirSync(dir, {recursive: true})
        chownBack(dir)
        // 先删掉旧二维码，免得页面上显示的是上一次那张（扫了也没用）
        for (const f of ['www2-qrcode.png', 'mac-qrcode.png']) {
            try {
                fs.unlinkSync(path.join(dir, f))
            } catch (e) {
                // 本来就没有
            }
        }
        const child = spawn(process.execPath, ['login.js', type], {
            cwd: projectRoot,
            env: {...process.env, XMD_XMD_DIR: dir, XMD_DB_DIR: sharedDbDir()},
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        const eat = chunk => {
            process.stdout.write(String(chunk)) // 扫码过程的日志也进 app.log
        }
        child.stdout.on('data', eat)
        child.stderr.on('data', eat)
        loginJobs.set(name, {child, type, chan, at: Date.now()})
        const timer = setTimeout(() => {
            log.warn(`账号 ${name} 的扫码登录超过 5 分钟没完成，收工（二维码会过期，重新点一次即可）`)
            try {
                child.kill('SIGKILL')
            } catch (e) {
                // 已经退出了
            }
            loginJobs.delete(name)
        }, LOGIN_TIMEOUT_MS)
        child.on('close', code => {
            clearTimeout(timer)
            loginJobs.delete(name)
            if (code === 0) {
                log.info(`账号 ${name} 扫码登录完成，凭据已存到 ${dir}`)
                updateStatus(name, {disabled: false, autoDisabled: false, reason: ''})
            } else {
                log.warn(`账号 ${name} 的扫码登录进程退出（码 ${code}），凭据没有更新`)
            }
        })
        log.info(`网页操作：账号 ${name} 开始扫码登录（${type === 'web' ? '网页端 www2' : '电脑版 mac'}）`)
        return sendJson(res, 200, {ok: true, msg: '已开始，请扫页面上的二维码', data: collectAccounts()})
    }

    if (method === 'POST' && p === '/api/accounts/login/cancel') {
        const body = await readBody(req)
        const name = normalizeName(body.name)
        const job = name == null ? null : loginJobs.get(name)
        if (job) {
            try {
                job.child.kill('SIGKILL')
            } catch (e) {
                // 已经退出了
            }
            loginJobs.delete(name)
            log.info(`网页操作：取消账号 ${name} 的扫码登录`)
        }
        return sendJson(res, 200, {ok: true, data: collectAccounts()})
    }

    // 二维码 PNG：login.js 子进程把它写进账号目录，页面每 2 秒拉一次
    if (method === 'GET' && p === '/api/accounts/qrcode') {
        const name = normalizeName(url.searchParams.get('name'))
        if (name == null) return sendJson(res, 400, {ok: false, msg: '账号名不对'})
        const dir = accountDirFor(name)
        const job = loginJobs.get(name) || null
        // 有活跃登录任务时只认它那条通道的图，避免显示另一条通道的旧二维码
        const names = job ? [`${job.chan}-qrcode.png`] : ['www2-qrcode.png', 'mac-qrcode.png']
        for (const f of names) {
            try {
                const buf = fs.readFileSync(path.join(dir, f))
                res.writeHead(200, {
                    'Content-Type': 'image/png',
                    'Cache-Control': 'no-store',
                    'Content-Length': buf.length,
                })
                return res.end(buf)
            } catch (e) {
                // 还没生成，看下一个
            }
        }
        return sendJson(res, 404, {ok: false, msg: '二维码还没生成，稍等一秒再看'})
    }

    // 读当前生效的指纹全文（页面显示 / 复制 / 下载都靠它）
    if (method === 'GET' && p === '/api/accounts/fingerprint') {
        const name = normalizeName(url.searchParams.get('name'))
        if (name == null) return sendJson(res, 400, {ok: false, msg: '账号名不对'})
        const {own, shared} = fingerprintPaths(name)
        let file = own
        let from = 'account'
        if (!fs.existsSync(file)) {
            file = shared
            from = 'shared'
        }
        try {
            const text = fs.readFileSync(file, 'utf-8')
            const obj = JSON.parse(text)
            return sendJson(res, 200, {
                ok: true,
                data: {
                    name,
                    from,
                    path: file,
                    fields: Object.keys(obj).length,
                    size: text.length,
                    text,
                    ua: obj.ew1 && obj.ew1.yV2 ? 'Mozilla/' + obj.ew1.yV2 : null,
                    // 服务端认的标志：注册成功会回填 GJ2 和 fd2.av1（和采集器同一套判据）
                    registered: Boolean(obj.GJ2) && Boolean(obj.fd2 && obj.fd2.av1),
                    deviceId: (obj.fd2 && obj.fd2.Ja5) || null,
                },
            })
        } catch (e) {
            return sendJson(res, 404, {ok: false, msg: `读不到指纹文件（${file}）：${e.message}`})
        }
    }

    // 导入指纹（页面上粘一段 JSON，或者选个文件读出来）
    if (method === 'POST' && p === '/api/accounts/fingerprint/import') {
        const body = await readBody(req)
        const name = normalizeName(body.name)
        if (name == null) return sendJson(res, 400, {ok: false, msg: '账号名不对'})
        let obj
        try {
            obj = JSON.parse(String(body.json == null ? '' : body.json).trim())
        } catch (e) {
            return sendJson(res, 400, {ok: false, msg: `不是合法 JSON：${e.message}`})
        }
        if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
            return sendJson(res, 400, {ok: false, msg: '指纹文件应该是一个 JSON 对象'})
        }
        if (obj.ew1 == null || obj.ew1.yV2 == null) {
            return sendJson(res, 400, {ok: false, msg: '这份 JSON 不像设备指纹（缺 ew1 / ew1.yV2），别把别的东西粘进来'})
        }
        const dir = accountDirFor(name)
        fs.mkdirSync(dir, {recursive: true})
        const file = path.join(dir, 'device-info.json')
        if (fs.existsSync(file)) {
            try {
                fs.copyFileSync(file, file + '.bak')
            } catch (e) {
                // 备份失败不影响导入
            }
        }
        fs.writeFileSync(file, JSON.stringify(obj), 'utf-8')
        chownBack(file)
        log.info(`网页操作：给账号 ${name} 导入设备指纹（${Object.keys(obj).length} 个字段）→ ${file}`)
        return sendJson(res, 200, {ok: true, data: collectAccounts()})
    }

    // 把共用目录那份指纹复制给这个账号（同机采的就是同一台设备）
    if (method === 'POST' && p === '/api/accounts/fingerprint/copy-root') {
        const body = await readBody(req)
        const name = normalizeName(body.name)
        if (name == null) return sendJson(res, 400, {ok: false, msg: '账号名不对'})
        const {own, shared} = fingerprintPaths(name)
        if (!fs.existsSync(shared)) {
            return sendJson(res, 404, {ok: false, msg: `共用目录里没有指纹文件（${shared}）`})
        }
        const dir = accountDirFor(name)
        fs.mkdirSync(dir, {recursive: true})
        if (fs.existsSync(own)) {
            try {
                fs.copyFileSync(own, own + '.bak')
            } catch (e) {
                // 备份失败不影响复制
            }
        }
        fs.copyFileSync(shared, own)
        chownBack(own)
        log.info(`网页操作：把共用目录的指纹复制给账号 ${name}（${shared} → ${own}）`)
        return sendJson(res, 200, {ok: true, data: collectAccounts()})
    }

    // 删掉账号目录那份（退回用共用目录那份）
    if (method === 'POST' && p === '/api/accounts/fingerprint/clear') {
        const body = await readBody(req)
        const name = normalizeName(body.name)
        if (name == null) return sendJson(res, 400, {ok: false, msg: '账号名不对'})
        const {own, shared} = fingerprintPaths(name)
        try {
            if (fs.existsSync(own)) fs.unlinkSync(own)
            log.warn(`网页操作：删掉账号 ${name} 的指纹文件`
                + (fs.existsSync(shared) ? '，以后用共用目录那份' : '（共用目录那份也没有，付费集会下不了）'))
        } catch (e) {
            return sendJson(res, 400, {ok: false, msg: `删不掉：${e.message}`})
        }
        return sendJson(res, 200, {ok: true, data: collectAccounts()})
    }

    // 真校验：拿这份指纹去数盟报一次，看服务端认不认（只有真报过才知道有没有注册）
    if (method === 'POST' && p === '/api/accounts/fingerprint/verify') {
        const body = await readBody(req)
        const name = normalizeName(body.name)
        if (name == null) return sendJson(res, 400, {ok: false, msg: '账号名不对'})
        log.info(`网页操作：校验账号 ${name} 的设备指纹（真报一次数盟）`)
        const r = await runProbe(name, ['--fingerprint-only'])
        if (!r.ok) return sendJson(res, 200, {ok: false, msg: r.msg, data: collectAccounts()})
        const fp = (r.data || {}).fingerprint || null
        if (fp != null) updateStatus(name, {fingerprint: fp, fingerprintAt: Date.now()})
        return sendJson(res, 200, {ok: true, data: collectAccounts(), fingerprint: fp})
    }

    // ------------------------------------------------------ 库里已有的书（v8）

    if (method === 'GET' && p === '/api/library') {
        const force = /[?&]force=1/.test(req.url || '')
        return sendJson(res, 200, {ok: true, data: collectLibrary(force)})
    }

    // 绑定专辑：目录名跟专辑名对不上时，手工告诉程序「这个目录是哪张专辑」。
    // 绑定会写 sidecar（下次扫库就认得），顺带把封面/简介/主播补上。
    if (method === 'POST' && p === '/api/library/bind') {
        const body = await readBody(req)
        const dir = insideArchives(body.dir)
        if (dir == null) return sendJson(res, 400, {ok: false, msg: '目录不在下载目录之下'})
        const albumId = parseAlbumId(body.albumId)
        if (albumId == null) return sendJson(res, 400, {ok: false, msg: 'albumId 不对（填数字或专辑链接）'})
        const name = pickJobAccount()
        if (name == null) return sendJson(res, 400, {ok: false, msg: '还没有账号，先去「账号」卡片加一个'})
        const out = await runAssetsJob(name, albumId, dir)
        const sum = out.ok ? assetSummary(out) : ''
        if (!out.ok) {
            log.warn(`网页操作：把《${path.basename(dir)}》绑定到专辑 ${albumId} 失败：${out.error}`)
            return sendJson(res, 400, {ok: false, msg: out.error || '绑定失败', data: collectLibrary(true)})
        }
        log.info(`网页操作：把《${path.basename(dir)}》绑定到专辑 ${albumId}`
            + `（《${out.albumTitle || ''}》，用账号 ${name}）${sum === '' ? '' : `，补上：${sum}`}`)
        invalidateLibraryCache()
        return sendJson(res, 200, {ok: true, data: collectLibrary(true), result: out})
    }

    // 「非本站」标记：番茄唱听这类不是喜马拉雅来的书，永远拿不到 albumId、绑不上专辑，
    // 老把它列成「未识别，等着绑」就是一条永远清不掉的假待办。标记只在目录里放一个
    // `.xmd-skip`，音频文件一个都不动（ABS 照常扫、照常播），面板改显示「非本站 · 已忽略」。
    if (method === 'POST' && p === '/api/library/skip') {
        const body = await readBody(req)
        const dir = insideArchives(body.dir)
        if (dir == null) return sendJson(res, 400, {ok: false, msg: '目录不在下载目录之下'})
        const on = !(body.skip === false || body.skip === 'false' || body.skip === 0 || body.skip === '0')
        const reason = body.reason == null ? '' : String(body.reason).trim().slice(0, 200)
        if (!writeSkip(dir, on, reason)) {
            return sendJson(res, 400, {ok: false, msg: '写标记失败（目录只读？）', data: collectLibrary(true)})
        }
        const base = path.basename(dir)
        log.info(on
            ? `网页操作：《${base}》标记为非本站（${reason === '' ? '没写来源' : reason}）`
            : `网页操作：《${base}》取消了「非本站」标记`)
        invalidateLibraryCache()
        return sendJson(res, 200, {ok: true, data: collectLibrary(true), skipped: on})
    }

    // 单集忽略：专辑里那几集不想要的，删掉之后主循环会当成「还没下」再下一遍
    // （专辑级的 .xmd-skip 管不到单集）。规则写在专辑目录的 `.xmd-ignore.json`，
    // 下一轮下载开始时由下载器解析、在进度库打 skip 标记；音频文件一个都不动，
    // 面板把被忽略的集从「还差 N 集」里扣掉。
    if (method === 'POST' && p === '/api/library/track-skip') {
        const body = await readBody(req)
        const dir = insideArchives(body.dir)
        if (dir == null) return sendJson(res, 400, {ok: false, msg: '目录不在下载目录之下'})
        const base = path.basename(dir)
        const off = body.off === true || body.off === 'true'
        if (off) {
            if (!writeIgnore(dir, {nums: [], patterns: []})) {
                return sendJson(res, 400, {ok: false, msg: '写规则失败（目录只读？）', data: collectLibrary(true)})
            }
            log.info(`网页操作：《${base}》取消单集忽略（下一轮下载起这些集又算待下载）`)
            invalidateLibraryCache()
            return sendJson(res, 200, {ok: true, data: collectLibrary(true), ignore: null})
        }
        const addNums = parseNumSpec(body.nums)
        const rawPat = body.pattern == null ? '' : String(body.pattern).trim()
        const addPatterns = rawPat === '' ? [] : [rawPat]
        if (addNums.length === 0 && addPatterns.length === 0) {
            return sendJson(res, 400, {ok: false, msg: '要么填集号（如 651,656-660），要么填标题匹配（一段文字或正则）'})
        }
        // 与已有规则**合并**：再加一条不该把上次忽略的那几集放回来
        const prev = readIgnore(dir) || {nums: [], patterns: [], reason: ''}
        const nums = [...new Set([...(prev.nums || []), ...addNums])].sort((a, b) => a - b)
        const patterns = [...new Set([...(prev.patterns || []), ...addPatterns])]
        const reason = body.reason == null ? String(prev.reason || '') : String(body.reason).trim().slice(0, 200)
        // 正则写坏了不拦：ignoreMatches 会退化成子串匹配，写错也不至于把整本卡住
        if (!writeIgnore(dir, {nums: nums, patterns: patterns, reason: reason})) {
            return sendJson(res, 400, {ok: false, msg: '写规则失败（目录只读？）', data: collectLibrary(true)})
        }
        log.info(`网页操作：《${base}》新增单集忽略：集号 [${addNums.join(',')}]`
            + `${addPatterns.length === 0 ? '' : ` 标题匹配 ${JSON.stringify(addPatterns)}`}`
            + `${reason === '' ? '' : `（${reason}）`}——下一轮下载开始时生效，音频一个都不动`)
        invalidateLibraryCache()
        return sendJson(res, 200, {ok: true, data: collectLibrary(true), ignore: {nums, patterns, reason}})
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

/**
 * 面板页面与前端脚本是真实文件（panel/index.html、panel/app.js），不是塞在
 * 模板字符串里的字符串：能直接 node --check / diff，前端语法错误提交前就能发现，
 * 改样式改交互也不用在 43KB 的模板字面量里翻。按请求读盘，重建镜像后刷新即生效。
 */
const PANEL_DIR = path.join(projectRoot, 'panel')

function readPanel(name) {
    return fs.readFileSync(path.join(PANEL_DIR, name))
}

