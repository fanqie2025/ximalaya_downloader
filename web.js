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

/* 账号卡片（v7） */
.acc{border-top:1px solid var(--line);padding:12px 0}
.acc:first-child{border-top:none}
.acc-h{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.acc-n{font-size:14px;font-weight:600}
.acc-m{font-size:12px;color:var(--muted);font-family:var(--mono);word-break:break-all}
.badge{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:2px 9px;
  font-size:11px;border:1px solid var(--line);background:var(--chip);color:var(--muted)}
.badge.ok{color:var(--ok);border-color:var(--ok)}
.badge.bad{color:var(--err);border-color:var(--err)}
.badge.off{color:var(--warn);border-color:var(--warn)}
.acc-b{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.acc-b button{font-size:12px;padding:4px 10px}
.acc-sub{font-size:12px;color:var(--muted);margin-top:4px}
.mask{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;align-items:center;
  justify-content:center;padding:16px;z-index:20}
.mask.on{display:flex}
.modal{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;
  width:100%;max-width:540px;max-height:88vh;overflow:auto}
.modal-h{display:flex;align-items:center;gap:10px;margin-bottom:12px;font-size:14px}
.qr{display:flex;flex-direction:column;align-items:center;gap:8px;background:#fff;
  border-radius:10px;padding:12px;margin:10px 0}
.qr img{width:250px;height:250px;image-rendering:pixelated}
.qr .t{color:#333;font-size:12px}
textarea{width:100%;min-height:130px;font:12px/1.5 var(--mono);padding:9px 11px;border-radius:7px;
  border:1px solid var(--line);background:var(--bg);color:var(--fg);resize:vertical}
textarea:focus{outline:none;border-color:var(--accent)}
.mono{font-family:var(--mono);font-size:12px;word-break:break-all}
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
    <h2>账号</h2>
    <div class="row">
      <input type="text" id="in-acc" placeholder="新账号名（字母/数字/下划线，如 bob）" autocomplete="off">
      <button class="primary" id="btn-acc-add">添加账号</button>
      <span class="spacer"></span>
      <span class="chip" id="chip-acc">-</span>
    </div>
    <div id="accounts" style="margin-top:10px"><div class="empty">加载中…</div></div>
    <div class="hint">同一时间只有一个账号在下载（交替上阵），每个账号各自有每日上限，用满自动换下一个。
      账号失效会在轮到他之前被自动探测出来、禁用并换人，不用你盯着。</div>
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

<div class="mask" id="mask">
  <div class="modal">
    <div class="modal-h">
      <b id="modal-title">-</b>
      <span class="spacer" style="flex:1"></span>
      <button id="modal-close">关闭</button>
    </div>
    <div id="modal-body"></div>
  </div>
</div>

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
  renderAccounts(st)
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

// ---------------------------------------------------------------- 账号（v7）

var accPoll = null

function ago(ts){
  if (!ts) return '-'
  var s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前'
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前'
  return Math.floor(s / 86400) + ' 天前'
}

function openModal(title, html){
  $('modal-title').textContent = title
  $('modal-body').innerHTML = html
  $('mask').classList.add('on')
}

function closeModal(){
  $('mask').classList.remove('on')
  $('modal-body').innerHTML = ''
  if (accPoll) { clearInterval(accPoll); accPoll = null }
}

function postJson(path, body, okMsg){
  return fetch(path, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body || {})
  }).then(function(r){ return r.json() }).then(function(r){
    if (r && r.ok) { if (okMsg) toast(okMsg); refresh() }
    else toast((r && r.msg) || '操作失败', true)
    return r
  }).catch(function(e){ toast('请求出错：' + e.message, true); return null })
}

function copyText(text, okMsg){
  var done = function(){ toast(okMsg || '已复制') }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function(){ toast('复制失败，手动选中吧', true) })
    return
  }
  var ta = document.createElement('textarea')
  ta.value = text
  document.body.appendChild(ta)
  ta.select()
  try { document.execCommand('copy'); done() } catch (e) { toast('复制失败，手动选中吧', true) }
  document.body.removeChild(ta)
}

function accBadge(a){
  if (a.disabled) return {cls:'off', text: a.disabledReason || '已禁用'}
  if (a.probing) return {cls:'', text:'探测中…'}
  if (a.logging) return {cls:'', text:'登录中…'}
  var st = a.status
  if (!st || st.at == null) return {cls:'', text:'未探测'}
  if (st.alive === true) {
    var t = st.nickname || '正常'
    return {cls:'ok', text: t + (st.vip ? ' · VIP' : '')}
  }
  return {cls:'bad', text: st.reason || '失效'}
}

function renderAccounts(st){
  var box = $('accounts')
  var list = st.accounts || []
  $('chip-acc').textContent = list.length + ' 个账号'
    + (st.probing ? ('　·　正在探测 ' + st.probing) : '')
  if (!list.length) {
    box.innerHTML = '<div class="empty">还没有账号。上面填个名字点「添加账号」，然后扫码登录。</div>'
    return
  }
  var html = ''
  list.forEach(function(a){
    var b = accBadge(a)
    var rec = a.status || {}
    var sub = []
    if (a.daily) sub.push('今日 ' + a.daily.count + '/' + (a.daily.cap || '?'))
    if (rec.uid) sub.push('uid ' + rec.uid)
    if (rec.vipExpire != null) sub.push('VIP 剩 ' + rec.vipExpire + ' 天')
    if (rec.robot) sub.push('⚠ 被判定为机器人')
    if (rec.ban) sub.push('⚠ 禁止登录')
    sub.push(a.credential ? ('凭据 ' + a.credential) : '没有凭据（还需扫码登录）')
    var fp = a.fingerprint || {}
    var fpText = fp.exists ? '指纹 ✔'
      : (fp.usingShared ? '指纹（用共用目录那份）' : '没有指纹')
    html += '<div class="acc">'
      + '<div class="acc-h">'
      +   '<span class="acc-n">' + esc(a.name) + '</span>'
      +   '<span class="badge ' + b.cls + '">' + esc(b.text) + '</span>'
      +   '<span class="acc-m">' + esc(fpText) + '</span>'
      +   '<span class="spacer" style="flex:1"></span>'
      +   '<span class="acc-m">' + (rec.at ? ('探测 ' + ago(rec.at)) : '') + '</span>'
      + '</div>'
      + '<div class="acc-sub">' + esc(sub.join('　·　')) + '</div>'
      + '<div class="acc-sub mono">' + esc(a.dir) + '</div>'
      + '<div class="acc-b">'
      +   '<button data-acc-probe="' + esc(a.name) + '">探测</button>'
      +   '<button data-acc-login="' + esc(a.name) + '">扫码登录</button>'
      +   '<button data-acc-fp="' + esc(a.name) + '">指纹</button>'
      +   (a.disabled
            ? '<button data-acc-enable="' + esc(a.name) + '">启用</button>'
            : '<button data-acc-disable="' + esc(a.name) + '">禁用</button>')
      +   '<button data-acc-remove="' + esc(a.name) + '">移出名单</button>'
      + '</div>'
      + '</div>'
  })
  box.innerHTML = html
  Array.prototype.forEach.call(box.querySelectorAll('button[data-acc-probe]'), function(x){
    x.onclick = function(){ accProbe(x.getAttribute('data-acc-probe')) }
  })
  Array.prototype.forEach.call(box.querySelectorAll('button[data-acc-login]'), function(x){
    x.onclick = function(){ accLogin(x.getAttribute('data-acc-login'), 'web') }
  })
  Array.prototype.forEach.call(box.querySelectorAll('button[data-acc-fp]'), function(x){
    x.onclick = function(){ accFingerprint(x.getAttribute('data-acc-fp')) }
  })
  Array.prototype.forEach.call(box.querySelectorAll('button[data-acc-disable]'), function(x){
    x.onclick = function(){
      var n = x.getAttribute('data-acc-disable')
      if (confirm('禁用账号 ' + n + '？\n\n他不再参与轮转（凭据文件不删），随时可以再启用。')) {
        postJson('/api/accounts/disable', {name:n}, '已禁用 ' + n)
      }
    }
  })
  Array.prototype.forEach.call(box.querySelectorAll('button[data-acc-enable]'), function(x){
    x.onclick = function(){ postJson('/api/accounts/enable', {name:x.getAttribute('data-acc-enable')}, '已启用') }
  })
  Array.prototype.forEach.call(box.querySelectorAll('button[data-acc-remove]'), function(x){
    x.onclick = function(){
      var n = x.getAttribute('data-acc-remove')
      if (confirm('把账号 ' + n + ' 移出名单？\n\n只是不再参与轮转，凭据和指纹文件都留在磁盘上。')) {
        postJson('/api/accounts/remove', {name:n}, '已移出 ' + n)
      }
    }
  })
}

function accAdd(){
  var n = $('in-acc').value.trim()
  if (n === '') { toast('先填个账号名', true); return }
  postJson('/api/accounts/add', {name:n}, '账号 ' + n + ' 已加入，接着扫码登录').then(function(r){
    if (r && r.ok) {
      $('in-acc').value = ''
      refresh()
      accLogin(n, 'web')
    }
  })
}

function accProbe(name){
  openModal('探测账号 ' + name, '<div class="acc-sub">正在查两个通道的登录态，并拿这份指纹去数盟报一次（最多等 2 分钟）…</div>')
  postJson('/api/accounts/probe', {name:name}).then(function(r){
    if (!r || !r.ok) { toast((r && r.msg) || '探测失败', true); return }
    var d = r.probe || {}
    var html = '<div class="acc-sub">账号 <b>' + esc(name) + '</b>　'
      + (d.alive ? '<span class="badge ok">可用</span>' : '<span class="badge bad">不可用</span>')
      + '</div>'
    if (d.nickname || d.uid) html += '<div class="acc-sub">昵称 ' + esc(d.nickname || '-') + '　uid ' + esc(d.uid || '-') + '</div>'
    html += '<div class="acc-sub">VIP ' + (d.vip ? '是' : '否')
      + (d.vipExpire != null ? ('（剩 ' + d.vipExpire + ' 天）') : '') + '</div>'
    var ch = d.channels || {}
    Object.keys(ch).forEach(function(k){
      var c = ch[k]
      html += '<div class="acc-sub">通道 ' + esc(k) + '：'
        + (c.ok ? '<span class="badge ok">正常</span>' : '<span class="badge bad">不可用</span>')
        + ' ' + esc(c.msg || '') + '</div>'
    })
    var fp = d.fingerprint
    if (fp) {
      html += '<div class="acc-sub">指纹：'
        + (!fp.exists ? '<span class="badge bad">没有文件</span> ' + esc(fp.path || '')
            : (fp.accepted ? '<span class="badge ok">服务端认</span>' : '<span class="badge bad">服务端不认</span>')
              + '　字段 ' + (fp.fields || '?') + '　设备 ' + esc(fp.aid || '-'))
        + '</div>'
      if (fp.error) html += '<div class="acc-sub">' + esc(fp.error) + '</div>'
    }
    if (!d.alive && d.reason) html += '<div class="acc-sub">' + esc(d.reason) + '</div>'
    openModal('账号 ' + name + ' 探测结果', html)
    toast(d.alive ? '账号可用' : '账号不可用', !d.alive)
  })
}

function accLogin(name, type){
  postJson('/api/accounts/login', {name:name, type:type || 'web'}).then(function(r){
    if (r && r.ok) showQr(name, type || 'web')
  })
}

function showQr(name, type){
  var html = '<div class="acc-sub">用<b>喜马拉雅 APP</b> 扫下面这张二维码。扫完页面会自己刷新出凭据，不用管终端。</div>'
    + '<div class="row" style="margin-top:10px">'
    +   '<button id="qr-web">网页端登一次</button>'
    +   '<button id="qr-pc">电脑版登一次</button>'
    +   '<button id="qr-cancel">取消登录</button>'
    + '</div>'
    + '<div class="qr">'
    +   '<img id="qr-img" alt="二维码" src="/api/accounts/qrcode?name=' + encodeURIComponent(name) + '&t=' + Date.now() + '">'
    +   '<div class="t" id="qr-t">二维码加载中…</div>'
    + '</div>'
    + '<div class="acc-sub">两条通道的 cookie 是分开存的（网页端 www2 / 电脑版 mac）。想都能下就各扫一遍；只扫一条也能下，'
    + '另一条通道不可用时调度器会自动切过去。</div>'
  openModal('账号 ' + name + ' 扫码登录', html)
  $('qr-web').onclick = function(){ accLogin(name, 'web') }
  $('qr-pc').onclick = function(){ accLogin(name, 'pc') }
  $('qr-cancel').onclick = function(){
    postJson('/api/accounts/login/cancel', {name:name}, '已取消登录')
    closeModal()
  }
  if (accPoll) clearInterval(accPoll)
  accPoll = setInterval(function(){
    var img = $('qr-img')
    if (!img) return
    img.onload = function(){ $('qr-t').textContent = '用喜马拉雅 APP 扫码，扫完稍等几秒' }
    img.onerror = function(){ $('qr-t').textContent = '二维码还没生成，等一下…' }
    img.src = '/api/accounts/qrcode?name=' + encodeURIComponent(name) + '&t=' + Date.now()
    refresh()
    var hit = ((lastState && lastState.accounts) || []).filter(function(x){ return x.name === name })[0]
    if (hit && !hit.logging && hit.credential) {
      clearInterval(accPoll)
      accPoll = null
      $('qr-t').textContent = '登录成功，凭据已保存'
      toast('账号 ' + name + ' 登录完成')
      setTimeout(closeModal, 1500)
    }
  }, 2500)
}

function fpTools(name, text){
  return '<div class="row" style="margin-top:10px">'
    +   '<button id="fp-verify">真校验（报一次数盟）</button>'
    +   '<button id="fp-copy-root">从共用目录复制</button>'
    +   '<button id="fp-copy">复制 JSON</button>'
    +   '<button id="fp-clear">删掉这份</button>'
    + '</div>'
    + '<div class="acc-sub" style="margin-top:14px">导入 / 替换：把设备指纹 JSON 粘进来，或选一个文件</div>'
    + '<textarea id="fp-text" spellcheck="false" placeholder="粘贴 device-info.json 的内容…">' + esc(text || '') + '</textarea>'
    + '<div class="row" style="margin-top:8px">'
    +   '<input type="file" id="fp-file" accept=".json,application/json">'
    +   '<span class="spacer" style="flex:1"></span>'
    +   '<button class="primary" id="fp-import">导入</button>'
    + '</div>'
}

function wireFp(name){
  $('fp-verify').onclick = function(){
    openModal('校验账号 ' + name + ' 的指纹', '<div class="acc-sub">正在拿这份指纹去数盟报一次（最多等 2 分钟）…</div>')
    postJson('/api/accounts/fingerprint/verify', {name:name}).then(function(r){
      if (!r || !r.ok) { toast((r && r.msg) || '校验失败', true); return }
      var fp = r.fingerprint || {}
      var html = '<div class="acc-sub">'
        + (fp.accepted ? '<span class="badge ok">服务端认这份指纹</span>' : '<span class="badge bad">服务端不认</span>')
        + '　设备 ' + esc(fp.aid || '-') + '　字段 ' + (fp.fields || '?') + ' 个</div>'
        + '<div class="acc-sub">HTTP ' + esc(fp.http == null ? '-' : String(fp.http)) + '　err ' + esc(fp.err == null ? '-' : String(fp.err)) + '</div>'
        + '<div class="acc-sub">文件 ' + esc(fp.path || '-') + (fp.exists ? '' : '（不存在）') + '</div>'
        + (fp.ua ? '<div class="acc-sub mono">' + esc(fp.ua) + '</div>' : '')
        + (fp.error ? '<div class="acc-sub">' + esc(fp.error) + '</div>' : '')
        + '<div class="acc-sub">判据：服务端认的指纹会回填 GJ2 和 fd2.av1；不认就是 aid/cadd 空。</div>'
      openModal('账号 ' + name + ' 指纹校验结果', html)
      toast(fp.accepted ? '指纹可用' : '指纹不可用', !fp.accepted)
    })
  }
  $('fp-copy-root').onclick = function(){
    postJson('/api/accounts/fingerprint/copy-root', {name:name}, '已从共用目录复制一份给这个账号')
  }
  $('fp-copy').onclick = function(){
    copyText($('fp-text').value, '指纹 JSON 已复制到剪贴板')
  }
  $('fp-clear').onclick = function(){
    if (!confirm('删掉这个账号目录里的指纹文件？\n\n删了以后会用共用目录那份（如果存在）。')) return
    postJson('/api/accounts/fingerprint/clear', {name:name}, '已删掉，回退用共用目录那份')
  }
  $('fp-import').onclick = function(){
    var t = $('fp-text').value.trim()
    if (t === '') { toast('先粘一份 JSON 进来', true); return }
    postJson('/api/accounts/fingerprint/import', {name:name, json:t}, '指纹已导入，点「真校验」试试服务端认不认')
  }
  $('fp-file').onchange = function(){
    var f = this.files && this.files[0]
    if (!f) return
    var fr = new FileReader()
    fr.onload = function(){ $('fp-text').value = String(fr.result) }
    fr.readAsText(f)
  }
}

function accFingerprint(name){
  fetch('/api/accounts/fingerprint?name=' + encodeURIComponent(name), {cache:'no-store'})
    .then(function(r){ return r.json() }).then(function(r){
      if (!r || !r.ok) {
        openModal('账号 ' + name + ' 的设备指纹',
          '<div class="acc-sub">' + esc((r && r.msg) || '读不到指纹') + '</div>' + fpTools(name, ''))
        wireFp(name)
        return
      }
      var d = r.data
      var head = '<div class="acc-sub">来源：'
        + (d.from === 'shared' ? '共用目录（这个账号自己没有，用的是兜底那份）' : '账号自己的目录')
        + '　字段 ' + d.fields + ' 个　' + Math.round(d.size / 1024) + ' KB</div>'
        + '<div class="acc-sub">注册状态：'
        + (d.registered
            ? '<span class="badge ok">已注册</span>（服务端回填过 GJ2 / fd2.av1）'
            : '<span class="badge bad">看不出注册</span>（缺 GJ2 / fd2.av1，付费声音大概率下不了）')
        + '</div>'
        + '<div class="acc-sub">设备 ' + esc(d.deviceId || '-') + '</div>'
        + '<div class="acc-sub mono">' + esc(d.path) + '</div>'
        + '<div class="acc-sub mono">' + esc(d.ua || '-') + '</div>'
      openModal('账号 ' + name + ' 的设备指纹', head + fpTools(name, d.text))
      wireFp(name)
    }).catch(function(e){ toast('读指纹出错：' + e.message, true) })
}

$('btn-pause').onclick = function(){ act('/api/pause', {}, '已暂停') }
$('btn-resume').onclick = function(){ act('/api/resume', {}, '已继续') }
$('btn-run').onclick = function(){ act('/api/run', {}, '已触发一轮') }
$('btn-add').onclick = addAlbum
$('in-album').addEventListener('keydown', function(e){ if (e.key === 'Enter') addAlbum() })
$('btn-acc-add').onclick = accAdd
$('in-acc').addEventListener('keydown', function(e){ if (e.key === 'Enter') accAdd() })
$('modal-close').onclick = closeModal
$('mask').addEventListener('click', function(e){ if (e.target === $('mask')) closeModal() })
document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeModal() })
$('logbox').addEventListener('toggle', function(){ if ($('logbox').open) refreshLog() })

refresh()
refreshLog()
setInterval(refresh, 4000)
setInterval(function(){ if ($('logbox').open) refreshLog() }, 6000)
</script>
</body>
</html>`
