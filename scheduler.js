#!/usr/bin/env node
/**
 * 无人值守调度器 —— 让飞牛上的容器自己追更新，Windows 可以关机。
 *
 * 两个设计决定值得说明：
 *
 * 1) 走 `node xmd.js` 子进程，而不是 import 上游的 main()。
 *    上游 main() 是「执行即跑」，且 taskCount / finishCount / DownloaderFactory
 *    都是模块级单例，同一进程里连着跑多张专辑会互相串。
 *
 * 2) 启动先验凭据。服务端没有屏幕，扫码登录这条路是走不通的：
 *    上游 login() 在非 serverMode 下会 spawn `xdg-open` 打开二维码图片，
 *    然后 while(true) 轮询扫码结果 —— 容器里既打不开图，也没人去扫，
 *    进程会永远挂在那里，看起来像「卡住」而不是报错。
 *    所以这里提前判断 ~/.xmd 下有没有凭据，没有就直接报错退出。
 *
 * 凭据怎么来：在**有屏幕的 Windows** 上跑一次 `node login.js` 扫码，
 * 然后把 `C:\Users\<你>\.xmd` 整个目录拷到宿主机的映射目录里。
 * cookie 是纯文本，Windows 上扫出来的在 Linux 里能直接用（实测有效期到 2094 年）。
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import {spawn} from 'child_process'
import {config} from './common/config.js'
import {projectRoot} from './settings.js'
import {log} from './common/log4jscf.js'
import {
    state,
    sleepInterruptible,
    waitForWake,
    pushLog,
    registerChildKiller,
} from './common/control.js'
import {startWebServer} from './web.js'
import {albumDB} from './db/albumdb.js'
import {loadAlbumMeta} from './common/naming.js'
import {assetSummary} from './common/albumassets.js'
import {identifyLibrary, invalidateLibraryCache, scanLibrary} from './common/library.js'
// 账号名单 + 健康状态（2026-09-29 v7）：网页和调度器读同一份，见 common/accountstore.js
import {
    readAccounts,
    readStatus,
    updateStatus,
    isDisabled,
    disabledReason,
    accountDirFor,
    findCredential,
    accountsFile,
} from './common/accountstore.js'

const PROXY_KEYS = ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']

/**
 * 子进程环境：清掉代理变量。
 *
 * 踩过的坑：http_proxy 指向一个 HTTP 代理时，axios 处理 https:// 请求会把
 * 明文发到 443，服务端回 "The plain http request was sent to https port"，
 * 表现成莫名其妙的 400。容器里一般没代理，但这个变量从宿主机漏进来就麻烦了。
 */
function childEnv(extra) {
    const env = {...process.env}
    for (const k of PROXY_KEYS) delete env[k]
    // 多账号（2026-09-29）：这两个是**每次 spawn 现算**的，不是写死在 compose 里的容器级
    // 环境变量，因为每个账号不一样：
    //   XMD_XMD_DIR → 这个账号自己的目录（cookie 与设备指纹都在里面）
    //   XMD_DB_DIR  → 全账号**共用**的进度库（track.db / album.db）
    // 进度库绝不能跟着账号走：它是「这集下过没有」的唯一依据，各记一份就会重复下。
    if (extra) Object.assign(env, extra)
    return env
}

let currentChild = null

// 本轮**真正下到**的集数。
// 必须认「下载成功」这三个字：日志里还有「当前信息>>>>>进度:」这类同样能匹配
// RE_PROGRESS 的行（专辑已下完时每轮都会打一行），只按 RE_PROGRESS 数会虚高 ——
// 2026-09-27 核查时踩到：`grep '进度:'` 数出 821，真实只有 807。
let roundDownloaded = 0

/**
 * 主动避让（2026-09-29，定的方案是：单轮 240 集、每天 4 轮、当日封顶 950 集）。
 *
 * 动机：被动撞墙法一天只拿到 602 集（9/28）。因为**单轮上限和当日上限返回的都是
 * ret:1001「系统繁忙」**，根本没法从错误码区分，只能靠「本轮有没有新增集数」猜，
 * 而实测单轮那道的产出还在 90~497 之间飘。既然早晚要被挡，不如自己数着下：
 * 一轮下满 N 集就收工，当天累计够 M 集就睡到明天。
 */
// 单轮上限（集）。0 = 不限制。到量后主动 SIGTERM 掐子进程 —— 见 maybeStopAtRoundCap。
let roundCap = 0
// 这次掐子进程是**我们自己按上限掐的**，不是被平台挡的。必须区分开：
// 否则 runOnce 会把正常收工当成失败，白走一轮重试/退避。
let roundCapped = false
// 当日累计（只数真正下到的集数）。跨自然日归零。
// **按账号分开记**（2026-09-29 多账号）：平台那道当日墙是按账号算的，
// 「这个账号今天还剩多少」自然也要各算各的。
let dailyDate = ''
let dailyCounts = {}   // {账号名: 今天已下的集数}
// 落盘挑 logs/ —— 它本来就是挂出来的目录（./logs:/app/logs），重建容器/重新 build
// 都不会把当天的计数忘掉。忘掉的后果是当天再下一轮 240 集，直接顶到平台的墙上。
const dailyStateFile = path.join(projectRoot, 'logs', 'daily-state.json')

function localDateStr(d = new Date()) {
    const p = n => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function loadDailyState() {
    try {
        const j = JSON.parse(fs.readFileSync(dailyStateFile, 'utf-8'))
        if (j && typeof j.date === 'string') {
            // 新格式：{date, accounts:{账号: 集数}}
            if (j.accounts && typeof j.accounts === 'object' && !Array.isArray(j.accounts)) {
                const counts = {}
                for (const [k, v] of Object.entries(j.accounts)) {
                    if (Number.isFinite(Number(v))) counts[k] = Number(v)
                }
                return {date: j.date, counts}
            }
            // 旧格式（v5 单账号）：{date, count} —— 那份计数就是 default 账号的
            if (Number.isFinite(Number(j.count))) {
                return {date: j.date, counts: {default: Number(j.count)}}
            }
        }
    } catch (e) {
        // 第一次跑、文件还没生成、或内容坏了：都从「今天 0 集」开始
    }
    return {date: localDateStr(), counts: {}}
}

function saveDailyState() {
    try {
        fs.mkdirSync(path.dirname(dailyStateFile), {recursive: true})
        fs.writeFileSync(dailyStateFile, JSON.stringify({date: dailyDate, accounts: dailyCounts}) + '\n')
    } catch (e) {
        // 计数落盘失败只影响「重建容器后记不记得」，不该因此打断下载
        log.warn(`当日计数写盘失败（不影响本轮）：${e.message}`)
    }
}

/**
 * 账号名单：逗号分隔（如 "default,bob"）。空 = 单账号，也就是 2026-09-29 之前的行为。
 *
 * `default` 这个名字是**保留**的：它指根 xmd 目录 —— 老部署那份唯一的凭据就在那儿，
 * 所以「加第二个账号」不需要搬动任何现有文件。其它名字都落在 <xmd>/accounts/<名字>/。
 */
export function parseAccounts(raw) {
    const list = String(raw == null ? '' : raw)
        .split(',')
        .map(s => s.trim())
        .filter(s => s !== '')
    return list.length > 0 ? [...new Set(list)] : ['default']
}

// 子进程进度行长这样：
//   (web)下载成功＞＞＞＞＞进度:12.34%(196/1589)---->/downloads/《书名》主播 作者/0001.mp3
const RE_PROGRESS = /进度:([\d.]+)%\((\d+)\/(\d+)\)/
const RE_TARGET = /---->(.+)$/

/**
 * 接管 xmd.js 的输出。
 *
 * 从 stdio:'inherit' 换成 pipe 有两个原因：
 *   1) 网页要显示「本专辑下到多少了 / 最近下的是哪一集」，这些数字只有子进程日志里有；
 *   2) 顺手攒进内存给页面看，用户就不用去翻 app.log 了。
 * 注意 stdout / stderr **两个都要读** —— 只读一个，另一个管道写满 64KB 会把子进程堵死。
 */
function forward(stream) {
    let buf = ''
    stream.setEncoding('utf-8')
    stream.on('data', chunk => {
        process.stdout.write(chunk) // 保持 docker logs 里也看得见
        buf += chunk
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, '')
            buf = buf.slice(idx + 1)
            onChildLine(line)
        }
        if (buf.length > 16384) buf = buf.slice(-2048) // 没有换行的超长输出，别无脑堆内存
    })
}

function onChildLine(line) {
    if (line.trim() === '') return
    // 「获取章节列中…」是首次拉列表时每集刷一行，只用来推阶段、不进页面日志，
    // 否则 1589 集能把日志面板整个冲掉
    if (line.includes('获取章节列')) {
        if (state.phase !== 'planning') {
            state.phase = 'planning'
            pushLog(line)
        }
        return
    }
    pushLog(line)
    const p = line.match(RE_PROGRESS)
    if (p) {
        if (line.includes('下载成功')) {
            roundDownloaded++
            maybeStopAtRoundCap()
        }
        state.phase = 'running'
        const t = line.match(RE_TARGET)
        state.current = {
            done: Number(p[2]),
            total: Number(p[3]),
            pct: Number(p[1]),
            title: t ? path.basename(t[1].trim()) : (state.current ? state.current.title : null),
            at: Date.now(),
        }
    }
}

/**
 * 本轮下满就主动停 —— 这是正常收工，不是失败。
 *
 * 为什么掐子进程，而不是给 xmd.js 加个 --max：上游压根没这个选项（也不该为了
 * 调度去改上游下载器）。而 SIGTERM 这条路有现成先例 —— 网页上的「暂停」就是
 * 这么干的：正在下的那一集进度库里没记上，下一轮会重新下，不会留个半集在那儿。
 */
function maybeStopAtRoundCap() {
    if (roundCap <= 0 || roundCapped || !currentChild) return
    if (roundDownloaded < roundCap) return
    roundCapped = true
    log.info(`本轮已下到 ${roundDownloaded} 集，达到单轮上限 ${roundCap} 集 —— 主动停下，`
        + `剩下的留到下一个周期（正常收工，不是失败，不触发重试/退避）`)
    try {
        currentChild.kill('SIGTERM')
    } catch (e) {
        // 掐不掉就算了，这一轮只会多下一点
    }
}

function runAlbum(albumId, opts) {
    return new Promise(resolve => {
        const args = ['xmd.js', '-a', String(albumId), '-o', opts.output]
        if (opts.slow) {
            args.push('--slow')
        } else {
            args.push('-n', String(opts.concurrency))
        }
        if (opts.dryRun) args.push('--dry-run')
        log.info(`${'='.repeat(12)} 开始处理专辑 ${albumId} ${'='.repeat(12)}`)
        const child = spawn(process.execPath, args, {
            cwd: projectRoot,
            env: childEnv(opts.accountEnv),
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        currentChild = child
        state.albumId = String(albumId)
        state.phase = 'planning'
        state.current = null
        forward(child.stdout)
        forward(child.stderr)
        child.on('error', e => {
            log.error(`启动专辑 ${albumId} 失败：${e.message}`)
            currentChild = null
            state.albumId = null
            state.phase = 'idle'
            resolve(-1)
        })
        child.on('close', (code, signal) => {
            log.info(`${'='.repeat(12)} 专辑 ${albumId} 结束，退出码 ${code}`
                + `${signal ? `（被 ${signal} 中止）` : ''} ${'='.repeat(12)}`)
            currentChild = null
            state.albumId = null
            state.current = null
            state.phase = 'idle'
            resolve(code == null ? -1 : code)
        })
    })
}

async function runOnce(ids, opts) {
    const begun = Date.now()
    roundDownloaded = 0
    roundCapped = false
    roundCap = Number(opts.maxPerRound) > 0 ? Math.floor(Number(opts.maxPerRound)) : 0
    let ok = 0
    let fail = 0
    let aborted = false
    for (const id of ids) {
        if (state.paused) {
            aborted = true
            break
        }
        const code = await runAlbum(id, opts)
        if (roundCapped) {
            // 是我们自己按单轮上限掐的：算这一轮成功，而且**不再接着跑后面的专辑** ——
            // 本轮配额已经下完了，接着跑就失去「主动避让」的意义。
            ok++
            break
        }
        if (code === 0) {
            ok++
        } else if (state.paused) {
            // 是被网页上的「暂停」掐掉的，不算失败 —— 否则会白触发一轮短间隔重试
            aborted = true
            break
        } else {
            fail++
        }
    }
    const mins = ((Date.now() - begun) / 60000).toFixed(1)
    const got = roundDownloaded
    // 「秒级失败」是个很值钱的指纹：getDownloader 取不到播放地址就直接抛、整张专辑退出，
    // 所以耗时 <1 分钟基本等于「一进去就被挡」= 限流 / 额度耗尽，不是凭据或网络问题。
    // 2026-09-26 那次整夜 0 集，日志全是「耗时 0.1 分钟」——当时没能一眼看出来。
    //
    // 判定阈值**故意不改成「本轮 0 集」**：实测 2026-09-27 那几轮里，跑了 15 分钟、
    // 下了 301 集才被挡的轮次根因同样是额度耗尽，但它们不属于「第一集就被挡」。
    // 那种情况靠上面那个「新增 N 集」区分：一集没捞到才是真的一进去就被挡。
    const quickFail = fail > 0 && Number(mins) < 1 && !roundCapped
    log.info(`本轮结束：成功 ${ok} 个，失败 ${fail} 个，新增 ${got} 集，耗时 ${mins} 分钟`
        + `${opts.account ? `（账号 ${opts.account}）` : ''}`
        + `${aborted ? '（被暂停打断）' : ''}`
        + `${roundCapped ? `　← 达到单轮上限 ${roundCap} 集，主动停下（正常收工，不该退避）` : ''}`
        + `${quickFail ? '　← 秒级失败：第一集就被挡，通常是限流/额度耗尽，不是凭据问题' : ''}`)
    state.lastRound = {
        ok, fail, minutes: Number(mins), at: Date.now(), aborted, downloaded: got, capped: roundCapped,
        account: opts.account || null,
    }
    return {ok, fail, aborted, capped: roundCapped, downloaded: got}
}

/**
 * 距离「下一天的某个时刻」还有多久（毫秒）。
 *
 * 用途：撞上自然日额度后，退避到次日 00:05 再试 —— 而不是 30 分钟一次地盲试。
 * 今天这个时刻已经过了就取明天的。容器里 TZ=Asia/Shanghai，所以 new Date()
 * 拿到的就是本地时间，不用额外换算。
 *
 * @param {string} hhmm 形如 "00:05"
 * @returns {{ms:number,label:string}|null} 格式不对返回 null
 */
function msUntilNextDayWindow(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim())
    if (!m) return null
    const h = Number(m[1])
    const min = Number(m[2])
    if (h > 23 || min > 59) return null
    const now = new Date()
    const target = new Date(now)
    target.setHours(h, min, 0, 0)
    if (target.getTime() <= now.getTime()) {
        target.setDate(target.getDate() + 1)
    }
    const pad = n => String(n).padStart(2, '0')
    return {
        ms: target.getTime() - now.getTime(),
        label: `${target.getMonth() + 1}/${target.getDate()} ${pad(h)}:${pad(min)}`,
    }
}

function resolveHome(p) {
    return String(p).replace('~', os.homedir())
}

function xmdDir() {
    return resolveHome(config.xmd || '~/.xmd')
}

// 账号目录 + 凭据查找现在放在 common/accountstore.js 里（accountDirFor / findCredential）——
// 网页面板也要用同一套规则，两边各写一份迟早会分叉。规则仍然是：
//   default → 根 xmd 目录；其它 → <xmd>/accounts/<名字>。

/**
 * 解析订阅列表。一行一个，支持纯 albumId 和专辑链接，`#` 之后当注释。
 */
export function parseAlbumIds(text) {
    const out = []
    for (const rawLine of String(text).split(/\r?\n/)) {
        const line = rawLine.split('#')[0].trim()
        if (line === '') continue
        const m = line.match(/album\/(\d+)/) || line.match(/(\d{4,})/)
        if (m) out.push(m[1])
    }
    return [...new Set(out)]
}

/**
 * 让子进程 assets.js 去补一张专辑的封面 / 简介 / 主播。
 *
 * 为什么又开子进程：`config.xmd`（凭据目录）是进程启动时定死的，多账号下必须靠
 * XMD_XMD_DIR 指到对应账号 —— 跟 probe-account.js 同一个道理。
 *
 * @param {string|number} albumId
 * @param {string} dir 目标专辑目录
 * @param {object} accountEnv {XMD_XMD_DIR, XMD_DB_DIR}
 * @returns {Promise<{ok:boolean, cover?:string, desc?:string, reader?:string, albumTitle?:string, error?:string}>}
 */
function runAssets(albumId, dir, accountEnv) {
    return new Promise(resolve => {
        let child
        try {
            child = spawn(process.execPath, ['assets.js', String(albumId), dir], {
                cwd: projectRoot,
                env: childEnv(accountEnv),
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
        // 补附件是「顺手做的好事」，绝不能拖住一轮下载 —— 90 秒没结果就当它失败
        const timer = setTimeout(() => {
            try {
                child.kill('SIGKILL')
            } catch (e) {
                // 已经退了
            }
            done({ok: false, error: 'assets.js 超时（90 秒）'})
        }, 90000)
        const onData = chunk => {
            buf += chunk.toString()
            // 转进容器日志（面板看的是 logs/app.log，那边由 log4js 自己写）
            process.stdout.write(chunk)
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

/**
 * 每轮开跑前扫一遍下载目录（「库里已有的书」）：
 *
 *   ① 认得出是哪张专辑、但缺封面/简介/主播的 —— 顺手补上。**不用按钮、不用提示**：
 *      用户要的是「自己增加下载好的也确认下」，已经下完的书重跑一次也会走到这里
 *      （xmd.js 里补附件那段特意放在「已完成就 return」之前）。
 *   ② 没下完的 —— 只在日志里说一句，**绝不自动塞进订阅队列**：接着下会花额度，
 *      那是人的决定，网页上「库中已有书籍」里有「继续下载」按钮。
 *
 * 认不出来的那几本（库里没有专辑记录、目录名也对不上）这里一声不吭，
 * 交给网页上手工「绑定专辑」——按书名搜索这条路走不通，喜马拉雅风控直接回
 * `risk invalid`（实测 2026-09-30）。
 */
async function refreshLibrary(opts, accountEnv) {
    let albums = []
    try {
        albums = await albumDB.find({})
    } catch (e) {
        log.warn(`读专辑记录失败，这次不补库里已有的书：${e.message}`)
        return []
    }
    const rows = identifyLibrary(scanLibrary(opts.output, {force: true}), albums, loadAlbumMeta())
    let fixed = 0
    for (const r of rows) {
        if (r.albumId == null) continue
        if (r.hasCover && r.hasDesc && r.hasReader) continue
        const out = await runAssets(r.albumId, r.dir, accountEnv)
        if (out.ok) {
            const sum = assetSummary(out)
            if (sum !== '') {
                log.info(`库里《${r.albumTitle || r.name}》补上：${sum}`)
                fixed++
            }
        } else {
            log.warn(`库里《${r.name}》补封面/简介失败：${out.error || '未知原因'}`)
        }
    }
    if (fixed > 0) invalidateLibraryCache()
    for (const r of rows) {
        if (r.albumId != null && r.complete === false) {
            log.info(`库里《${r.name}》还没下完：${r.audio}/${r.total} 集，还差 ${r.remaining} 集`
                + `　—— 要接着下就在网页「库中已有书籍」里点「继续下载」（专辑 ${r.albumId}）`)
        }
    }
    return rows
}

async function main() {
    const sched = config.schedule || {}
    const opts = {
        output: resolveHome(config.archives || '~/Downloads'),
        concurrency: Number(sched.concurrency) > 0 ? Number(sched.concurrency) : 3,
        slow: sched.slow === true,
        dryRun: process.argv.includes('--dry-run'),
    }
    const intervalHours = Number(sched.intervalHours) > 0 ? Number(sched.intervalHours) : 12
    // 失败后的**短间隔**重试。默认 30 分钟一次，最多 6 次（= 3 小时）。
    // 3 小时足够覆盖「瞬时 / 小时级」风控；再往下试也不会好，见下面的退避。
    const retryMinutes = Number(sched.retryMinutes) > 0 ? Number(sched.retryMinutes) : 30
    // 短试次数上限。**2026-09-27 起语义变了**：以前是「总重试次数」（曾设 24 = 12 小时），
    // 现在是「短试次数」，超限后不再空转，交给下面的 backoffAt 退避。
    const maxRetries = Number(sched.maxRetries) > 0 ? Number(sched.maxRetries) : 6
    // 2026-09-28 起它只数**一集没捞到**的连续轮次：有新增集数的那一轮走 progressRetryMinutes。
    // 【2026-09-28 实测补上的一档】喜马拉雅有**两道**上限，旧代码把两道混成了一道：
    //   ① 单轮上限 ≈ 301 集 —— 撞上后约 1 小时就恢复（9/27 三个整点 burst 各 301 集，
    //      相隔 34~70 分钟；9/28 两轮独立复现 792→1093、1093→1394，都是正好 301 集）。
    //   ② 当日上限 ≈ 990 集 —— 这个才要等自然日（9/26=989、9/27=991）。
    // 所以「本轮下到了东西、最后才被挡」说明额度是有的，只是单轮配额用完，睡一会儿再来就行，
    // 不该退避到次日：9/28 就是照旧退避，白睡了 21 小时，当天只拿到 602 集。
    // 取 60 分钟：9/27 实测撞墙后 30 分钟那次仍秒级失败，60 分钟那次拿满 301 集。
    // 设成 off / 0 关掉，退回旧三段式行为（有新增集数也照样退避）。
    const rawProgressRetry = sched.progressRetryMinutes
    const progressRetryMinutes = (rawProgressRetry === undefined || rawProgressRetry === null
        || /^off$/i.test(String(rawProgressRetry).trim()))
        ? 0
        : (Number(rawProgressRetry) > 0 ? Number(rawProgressRetry) : 60)
    // 短试用完**且一集没捞到** —— 才是真的撞了自然日额度（实测：约 990 集/日，跨整点不恢复，
    // 只有跨过 0 点才回）。这时继续 30 分钟一次地盲试纯属浪费，直接退避到次日这个时刻。
    // 实测 2026-09-27 00:01 唤醒即恢复，所以取 00:05 留几分钟余量。
    // 设成空串 / off 可关掉，退化为原来的「回到 intervalHours 常规周期」。
    const rawBackoff = sched.backoffAt === undefined || sched.backoffAt === null
        ? '00:05'
        : String(sched.backoffAt).trim()
    const backoffAt = /^off$/i.test(rawBackoff) ? '' : rawBackoff
    // ---- 主动避让（2026-09-29）----
    // 单轮上限：本轮真正下到这么多集就主动停。默认关（0），在 compose 里显式打开 ——
    // 这样「同一份镜像在本机和飞牛两处跑」时，行为由部署处决定。
    const maxPerRound = Number(sched.maxPerRound) > 0 ? Math.floor(Number(sched.maxPerRound)) : 0
    // 当日上限：当天累计下到这么多集，就睡到次日 backoffAt。默认关（0）。
    const dailyCap = Number(sched.dailyCap) > 0 ? Math.floor(Number(sched.dailyCap)) : 0
    const albumsFile = sched.albumsFile
        ? path.resolve(projectRoot, sched.albumsFile)
        : path.join(projectRoot, 'albums.txt')
    const once = process.argv.includes('--once')

    log.info('喜马拉雅自动下载调度器 启动')
    log.info(`下载目录：${opts.output}`)
    log.info(`订阅列表：${albumsFile}`)
    log.info(`并发：${opts.slow ? '慢速模式（串行）' : opts.concurrency}　扫描间隔：${intervalHours} 小时` +
        (opts.dryRun ? '　【试运行，不会真的下载】' : ''))
    log.info(`失败重试：${retryMinutes} 分钟一次 × ${maxRetries} 次`
        + (progressRetryMinutes
            ? `；有新增集数但被挡则 ${progressRetryMinutes} 分钟后再来（单轮上限实测约 301 集）`
            : '')
        + (backoffAt
            ? `；一集没捞到才退避到每天 ${backoffAt}（当日上限实测约 990 集，跨整点不恢复）`
            : '，之后回到常规周期'))
    log.info(`主动避让：单轮 ${maxPerRound > 0 ? `${maxPerRound} 集` : '不限制'}，`
        + `当日 ${dailyCap > 0 ? `${dailyCap} 集` : '不限制'}`
        + `　（平台实测单轮约 301 集 / 当日约 990 集；留出余量主动收工，不和它撞）`)

    // 网页控制台放在凭据校验**之前**启动。凭据没配好时恰恰最需要一个能看状态和
    // 日志的页面，而不是让人去翻 docker logs。--once 模式跑完就退，没必要开端口。
    if (!once) {
        registerChildKiller(() => {
            if (currentChild) {
                log.warn(`网页点了「暂停」，中止当前专辑 ${state.albumId} 的下载（已下完的不受影响）`)
                try {
                    currentChild.kill('SIGTERM')
                } catch (e) {
                    // 掐不掉就算了，这一轮结束时会自然停下
                }
            }
        })
        startWebServer()
    }

    // ---- 多账号（2026-09-29）----
    // 账号目录只管凭据（cookie + 设备指纹）；下载进度库是**全账号共用**的一份，
    // 路径由 dbDirPath() 决定（这里显式传给子进程，见 accountEnv）。
    //
    // 名单优先级（v7，2026-09-29 晚）：config/accounts.txt 优先 —— 网页面板能加能删、
    // 运行时生效；XMD_SCHEDULE_ACCOUNTS 降级成**初始默认值**（文件不存在时才用它播种）。
    const dbDir = resolveHome(config.dbDir || config.xmd || '~/.xmd')
    let accountDirs = {}
    let activeAccounts = []
    // 名单/禁用状态变了才打日志，别每轮刷屏
    let accountSignature = ''

    /**
     * 重算「这一轮能上场的账号」。
     *
     * 每轮都调一次，所以网页上**加账号 / 删账号 / 禁用 / 启用**都不用重启容器 ——
     * 用户的原话是「万一账号失效能第一时间增加」，重建容器显然不够快。
     * 只把「有凭据 且 没被禁用」的算进去；被挡下的逐个说明原因，免得用户明明加了
     * 账号却发现轮不到它。
     */
    function refreshAccounts() {
        const names = readAccounts()
        const status = readStatus()
        const dirs = {}
        const notes = []
        for (const name of names) {
            const dir = accountDirFor(name)
            if (findCredential(dir) == null) {
                notes.push(`账号 ${name} 没有登录凭据（找的是 ${dir}），不参与轮转`
                    + ` —— 网页「账号」卡片里点「扫码登录」，或跑 XMD_XMD_DIR=${dir} node login.js`)
                continue
            }
            const rec = status[name]
            if (isDisabled(rec)) {
                notes.push(`账号 ${name} 已被禁用（${disabledReason(rec)}），不参与轮转`
                    + ' —— 网页「账号」卡片里点「启用」即可恢复')
                continue
            }
            dirs[name] = dir
        }
        accountDirs = dirs
        activeAccounts = Object.keys(dirs)
        const sig = names.join(',') + '|' + activeAccounts.join(',') + '|' + notes.join(';')
        if (sig !== accountSignature) {
            accountSignature = sig
            for (const n of notes) log.error(n)
            log.info(`账号名单（${accountsFile()}）：${names.join('、') || '(空)'}`
                + `　→ 能上场 ${activeAccounts.length} 个：${activeAccounts.join('、') || '(无)'}`
                + (activeAccounts.length > 1
                    ? `　交替上阵：每 ${(intervalHours / activeAccounts.length).toFixed(1)} 小时一轮`
                        + `（每个账号自己仍是 ${intervalHours} 小时一轮，日产量 ×${activeAccounts.length}）`
                    : ''))
        }
        return activeAccounts.length
    }

    refreshAccounts()
    if (activeAccounts.length === 0) {
        // 这里以前是 process.exit(2)。现在不能这么干了：网页面板和调度器是同一个进程，
        // 退出等于把「加账号 / 扫码登录」的入口一起关掉 —— 而「一个账号都没有」恰恰是
        // 最需要那个面板的时候。所以改成报错 + 每 5 分钟自动重算，等用户在页面上加。
        if (once) {
            log.error('没有任何可用账号（没凭据，或都被禁用了），单次模式直接退出')
            process.exit(2)
        }
        log.error('没有任何可用账号（没凭据，或都被禁用了）。')
        log.error('  不用重启容器：打开网页控制台的「账号」卡片，加一个账号并点「扫码登录」即可。')
        log.error('  也可以在有屏幕的 Windows 上跑　XMD_XMD_DIR=<账号目录> node login.js　再把目录拷过来。')
    }
    log.info(`进度库（全账号共用，绝不能各记一份）：${dbDir}`)

    if (!fs.existsSync(opts.output)) {
        fs.mkdirSync(opts.output, {recursive: true})
    }

    let round = 0
    let consecutiveFailures = 0

    // ---- 当日预算：按账号各算各的 ----
    function countOf(name) {
        return Number(dailyCounts[name]) || 0
    }

    function totalDaily() {
        let n = 0
        for (const a of activeAccounts) n += countOf(a)
        return n
    }

    function fmtCounts() {
        const parts = Object.entries(dailyCounts)
            .filter(([, v]) => Number(v) > 0)
            .map(([k, v]) => `${k} ${v} 集`)
        return parts.length > 0 ? parts.join('，') : '0 集'
    }

    /** 这个账号今天还能下多少集；没配当日上限就是无限 */
    function remainingOf(name) {
        if (dailyCap <= 0) return Infinity
        return Math.max(0, dailyCap - countOf(name))
    }

    // 轮转游标：指向「下一个该出场的账号」。
    let accountIdx = 0

    // ---- 撞墙冷却（v9，2026-09-30）----
    // 2026-09-29 晚实测：一轮只下了 39 集，两个通道就同时 `ret:1001`
    //（`所有下载方式都受限了，可以一个小时后后再过来试试哦`）。那时候的做法是睡满
    // progressRetryMinutes（60 分钟）再回来 —— 但如果被挡的是**这个账号**而不是这条宽带，
    // 那 60 分钟是白睡的：换另一个账号立刻就能接着下。
    // 所以撞墙的账号记一个「解冻时间」，下一轮优先换人；全都冷着才睡。
    // 换的是 cookie/uid，不是公网 IP —— 所以平台到底按账号算还是按 IP 算，
    // 看切号之后能不能接着下就知道了（日志里会写清是「换账号顶上」还是「都在冷却」）。
    const accountBlockedUntil = new Map()

    /** 这个账号还剩多少毫秒冷却（不在冷却里就是 0） */
    function blockedFor(name, now = Date.now()) {
        const t = accountBlockedUntil.get(name)
        return t && t > now ? t - now : 0
    }

    /** 让它冷却多久（撞墙 / 短试用它） */
    function blockAccount(name, ms) {
        accountBlockedUntil.set(name, Date.now() + ms)
    }

    /** 除 except 之外，还有谁「今天有余额、且不在冷却里」—— 撞墙后立刻换它顶上 */
    function nextAvailableAccount(except) {
        for (const a of activeAccounts) {
            if (a === except) continue
            if (remainingOf(a) <= 0) continue
            if (blockedFor(a) > 0) continue
            return a
        }
        return null
    }

    /**
     * 这一轮轮到哪个账号。
     *
     * 从游标往后找第一个「今天还有余额、又不在撞墙冷却里」的 —— 这就是「交替上阵」：
     * N 个账号轮流来，每个账号自己的周期仍然是 intervalHours，所以日产量 ×N。
     * v9 起多一条「不在冷却里」：刚被平台挡过的账号先别再用（见上面 accountBlockedUntil）。
     *
     * 都在冷却里就返回**最早解冻**的那个（主循环会按它的剩余冷却时间睡）；
     * 都下满了返回 null（上面那道闸门会先拦住，正常走不到这儿）；只有用户手动点
     * 「立即跑一轮」越过当日上限时才 forced=true，那时挑今天下得最少的那个顶上。
     */
    function pickAccount(forced) {
        for (let i = 0; i < activeAccounts.length; i++) {
            const name = activeAccounts[(accountIdx + i) % activeAccounts.length]
            if (remainingOf(name) > 0 && blockedFor(name) <= 0) {
                accountIdx = (accountIdx + i + 1) % activeAccounts.length
                return name
            }
        }
        let soonest = null
        for (const a of activeAccounts) {
            if (remainingOf(a) <= 0) continue
            if (soonest == null || blockedFor(a) < blockedFor(soonest)) soonest = a
        }
        if (soonest != null) return soonest
        if (!forced) return null
        let best = null
        for (const a of activeAccounts) {
            if (best == null || countOf(a) < countOf(best)) best = a
        }
        return best
    }

    // ---- 出场前探测（v7，2026-09-29 晚）----
    // cookie 文件里写的过期时间是 2094 年，但「过期」不是唯一的死法：平台踢下线、
    // 账号被禁、改密码，都会让一整轮白跑（日志里 401 / 渠道不可用，一集都下不来）。
    // 所以轮到某个账号之前先探它一次 —— 开场前就知道，比下到一半才发现划算得多。
    const PROBE_MAX_AGE_MS = 30 * 60 * 1000

    function parseProbeOutput(text) {
        const lines = String(text).split(/\r?\n/)
        for (let i = lines.length - 1; i >= 0; i--) {
            const l = lines[i].trim()
            if (!l.startsWith('XMD_PROBE_RESULT=')) continue
            try {
                return JSON.parse(l.slice('XMD_PROBE_RESULT='.length))
            } catch (e) {
                return null
            }
        }
        return null
    }

    /**
     * 探一个账号（子进程）。超时 / 没结果返回 null —— 那是「探不动」，不是「账号坏了」，
     * 调用方不能据此禁用账号，否则一次网络抖动就把好账号关了。
     */
    function probeAccount(name, timeoutMs = 120000) {
        return new Promise(resolve => {
            let child
            try {
                child = spawn(process.execPath, ['probe-account.js', name], {
                    cwd: projectRoot,
                    env: childEnv({XMD_XMD_DIR: accountDirs[name], XMD_DB_DIR: dbDir}),
                    stdio: ['ignore', 'pipe', 'pipe'],
                })
            } catch (e) {
                log.warn(`账号 ${name} 探测进程起不来：${e.message}`)
                return resolve(null)
            }
            let out = ''
            const onData = chunk => {
                const s = String(chunk)
                out += s
                process.stdout.write(s) // 探测日志也进 docker logs
            }
            child.stdout.on('data', onData)
            child.stderr.on('data', onData)
            const timer = setTimeout(() => {
                log.warn(`账号 ${name} 探测超过 ${Math.round(timeoutMs / 1000)} 秒没回，放弃这次探测`
                    + '（这一轮照常跑，别把网络慢当成账号坏了）')
                try {
                    child.kill('SIGKILL')
                } catch (e) {
                    // 杀不掉就随它去，它自己会超时退出
                }
                resolve(null)
            }, timeoutMs)
            child.on('close', () => {
                clearTimeout(timer)
                resolve(parseProbeOutput(out))
            })
        })
    }

    /** 30 分钟内探过、且结论是「活」就直接复用 —— 别每点一次「立即跑一轮」都去敲一遍接口 */
    async function probeAccountIfStale(name) {
        const rec = readStatus()[name]
        if (rec && rec.alive === true && rec.at && Date.now() - rec.at < PROBE_MAX_AGE_MS) return rec
        state.probing = name
        try {
            const p = await probeAccount(name)
            if (p == null) return null
            const patch = {
                at: p.at || Date.now(),
                alive: p.alive === true,
                reason: p.alive === true ? '' : (p.reason || '探测未通过'),
                uid: p.uid,
                nickname: p.nickname,
                vip: p.vip,
                vipExpire: p.vipExpire,
                robot: p.robot,
                ban: p.ban,
                channels: p.channels,
                fingerprint: p.fingerprint,
            }
            // 探活了就自动解掉「探测判死」那个禁用；用户手动禁用的那个不动（得他自己点启用）
            if (patch.alive) patch.autoDisabled = false
            return updateStatus(name, patch)
        } finally {
            state.probing = null
        }
    }

    // 退避/避让状态挂到 state 上，网页面板 / api 直接读得到（不用 ssh 翻日志）。
    // 顺手把避让那几个数字也带上，页面上就不用猜「今天还剩多少额度」。
    function setSched(stage, extra) {
        state.sched = {
            stage,
            consecutiveFailures,
            maxRetries,
            retryMinutes,
            progressRetryMinutes,
            backoffAt,
            maxPerRound,
            dailyCap,
            // 面板的老字段，含义保持「今天一共下了多少集」：多账号下就是各账号之和
            dailyCount: totalDaily(),
            dailyCounts: {...dailyCounts},
            accounts: activeAccounts.map(a => ({
                name: a,
                dir: accountDirs[a],
                count: countOf(a),
                cap: dailyCap,
                left: dailyCap > 0 ? Math.max(0, dailyCap - countOf(a)) : null,
            })),
            // 撞墙冷却（v9）：谁刚被平台挡过、还剩多少秒 —— 面板/`/api/state` 看得出
            // 「现在睡是因为这个账号在冷却，换个账号本来能接着下」。
            cooldowns: activeAccounts
                .map(a => ({name: a, seconds: Math.ceil(blockedFor(a) / 1000)}))
                .filter(x => x.seconds > 0),
            ...(extra || {}),
        }
    }

    const daily0 = loadDailyState()
    dailyDate = daily0.date
    dailyCounts = daily0.counts
    if (dailyCap > 0 && totalDaily() > 0) {
        log.info(`续上当天计数（${dailyDate}）：${fmtCounts()}`
            + `　每个账号上限 ${dailyCap} 集`
            + `（这份计数落在 ${dailyStateFile}，重建容器也不会忘）`)
    }

    while (true) {
        // 暂停检查放在最前面，且**不占轮次编号** —— 否则每被 waitForWake 唤醒一次
        // 轮次就虚增一下，页面上「第 N 轮」会莫名其妙地涨。
        if (state.paused) {
            state.phase = 'idle'
            state.albumId = null
            state.current = null
            log.info('已暂停自动下载，在网页上点「继续」即恢复')
            await waitForWake()
            continue
        }

        let forcedThisRound = false
        // 跨自然日先把当日计数归零 —— 平台那道墙就是按自然日算的（跨整点不恢复）。
        if (dailyDate !== localDateStr()) {
            log.info(`跨自然日（${dailyDate} → ${localDateStr()}），各账号当日计数归零`
                + `（昨天合计 ${totalDaily()} 集：${fmtCounts()}）`)
            dailyDate = localDateStr()
            dailyCounts = {}
            saveDailyState()
        }
        // 当日预算闸门：**所有账号**都下满才睡到次日。放在轮次编号**之前**，和暂停一样
        // 不占轮次 —— 它是一次「没跑」的等待，不该让页面上的「第 N 轮」虚涨。
        if (dailyCap > 0 && activeAccounts.every(a => remainingOf(a) <= 0)) {
            const w = backoffAt ? msUntilNextDayWindow(backoffAt) : null
            const capWaitMs = w ? w.ms : intervalHours * 60 * 60 * 1000
            const capHuman = capWaitMs >= 3600000
                ? `${(capWaitMs / 3600000).toFixed(1)} 小时`
                : `${Math.round(capWaitMs / 60000)} 分钟`
            state.phase = 'idle'
            state.albumId = null
            state.current = null
            setSched('daily-capped')
            log.info(`今日已下满（每个账号 ${dailyCap} 集封顶 × ${activeAccounts.length} 个账号，`
                + `合计 ${totalDaily()} 集；平台当日那道墙实测约 990 集/账号，主动留了余量），`
                + `休眠 ${capHuman} 后再来`
                + `${w ? ` —— ${w.label} 之后就是新的一天` : ''}`)
            const capHit = await sleepInterruptible(
                capWaitMs,
                `今日额度已满（合计 ${totalDaily()}/${dailyCap * activeAccounts.length} 集），休眠 ${capHuman}`)
            if (!capHit) continue
            // 被「继续 / 立即跑一轮」打断 = 用户明确要求现在跑，放行这一轮
            log.info('休眠被手动打断 —— 越过当日上限跑这一轮（单轮上限仍然生效）')
            forcedThisRound = true
        }

        round++
        state.round = round
        // 每轮都重读，这样往 albums.txt 里加订阅不需要重启容器
        let ids = []
        try {
            if (fs.existsSync(albumsFile)) {
                ids = parseAlbumIds(fs.readFileSync(albumsFile, 'utf-8'))
            } else {
                log.warn(`订阅列表不存在：${albumsFile}`)
            }
        } catch (e) {
            log.error(`读订阅列表失败：${e.message}`)
        }

        // 每轮重算一次账号名单：网页上刚加的账号 / 刚禁用的账号，下一轮就生效，不用重建容器。
        refreshAccounts()

        // 轮到这个账号出场（交替上阵）。放在轮次编号之后，因为它算是「这一轮由谁跑」。
        // 出场前先探一下它还活着没有（见上面 probeAccountIfStale）：
        //   探死了 → 当场自动禁用，换下一个账号（页面会亮红点，日志里写清原因）
        //   探不动（超时）→ 照常跑，不能因为网络抖动把好账号关了
        let account = null
        for (let attempt = 0; attempt < Math.max(1, activeAccounts.length); attempt++) {
            const cand = pickAccount(forcedThisRound)
            if (cand == null) break
            const p = await probeAccountIfStale(cand)
            if (p != null && p.alive !== true) {
                updateStatus(cand, {autoDisabled: true, reason: p.reason || '凭据已失效'})
                log.error(`账号 ${cand} 探测未通过，自动禁用并换下一个：${p.reason || '凭据已失效'}`)
                log.error('  在网页「账号」卡片里点「扫码登录」重新扫一次即可恢复（不用重启容器）')
                refreshAccounts()
                continue
            }
            account = cand
            break
        }
        if (account == null) {
            if (activeAccounts.length === 0) {
                // 没凭据 / 全被禁用：面板还开着，等用户在页面上加一个或启用一个
                log.error('当前没有可用账号，5 分钟后再看一次'
                    + '（在网页「账号」卡片里添加账号并扫码登录，或启用被禁用的账号）')
                state.phase = 'idle'
                setSched('no-account')
                await sleepInterruptible(5 * 60 * 1000, '没有可用账号（等网页上添加 / 启用）')
                continue
            }
            // 兜底：上面那道闸门已经拦过一次，正常走不到这儿 —— 除非当日上限在跑的中途被改小
            log.warn('所有账号今天的额度都用完了，等下一个自然日')
            setSched('daily-capped')
            const w = backoffAt ? msUntilNextDayWindow(backoffAt) : null
            await sleepInterruptible(w ? w.ms : intervalHours * 60 * 60 * 1000, '今日额度已满')
            continue
        }

        // 兜底闸（v9）：所有账号都在撞墙冷却里时，pickAccount 会把最早解冻的那个交出来 ——
        // 那就按它剩余的时间睡一下，别硬撞同一面墙。正常路径下上一轮的失败分支已经睡够了，
        // 走到这儿说明是「用户手动点了立即跑一轮」之类的越限场景。
        const cooldownMs = blockedFor(account)
        if (cooldownMs > 0) {
            const cdHuman = cooldownMs >= 3600000
                ? `${(cooldownMs / 3600000).toFixed(1)} 小时`
                : `${Math.max(1, Math.ceil(cooldownMs / 60000))} 分钟`
            log.info(`账号 ${account} 还在撞墙冷却里（还剩约 ${cdHuman}），先等着，不硬撞`)
            state.phase = 'sleeping'
            setSched('account-cooldown')
            await sleepInterruptible(cooldownMs, `账号 ${account} 冷却中（还剩 ${cdHuman}）`)
            continue
        }

        log.info(`第 ${round} 轮（账号 ${account}），待处理专辑 ${ids.length} 个：${ids.join(', ') || '(空)'}`
            + (dailyCap > 0
                ? `　${account} 今日已下 ${countOf(account)}/${dailyCap} 集`
                    + (activeAccounts.length > 1
                        ? `（全部账号合计 ${totalDaily()}/${dailyCap * activeAccounts.length}）`
                        : '')
                : ''))
        // 这一轮最多下多少集：既受单轮上限管，也要给**这个账号**当天剩下的额度留够。
        // 例：单轮 200、当日 950，某个账号前四轮 200×4 = 800，它的第五轮就只给 150。
        let roundMax = 0
        if (dailyCap > 0) roundMax = Math.max(0, dailyCap - countOf(account))
        if (maxPerRound > 0) roundMax = roundMax > 0 ? Math.min(maxPerRound, roundMax) : maxPerRound
        // 手动越限那一轮里所有账号都已下满，上面算出来是 0 —— 那不代表「不下」，
        // 而是「用户偏要跑」，所以退回单轮上限。（dailyCap 关掉时本来就不会是 0）
        if (roundMax <= 0 && maxPerRound > 0) roundMax = maxPerRound
        // 账号目录 + 共用的进度库，跟着这次 spawn 传下去 —— 多账号能跑起来全靠这两个变量
        const accountEnv = {XMD_XMD_DIR: accountDirs[account], XMD_DB_DIR: dbDir}
        // 顺手照顾「库里已有的书」（2026-09-30）：缺封面/简介/主播的补上，没下完的只提示一句。
        // 放在这里而不是轮次开头，是因为它要借上面这个账号的凭据去请求专辑详情。
        // 队列空着也照跑 —— 已经下完的书重跑一次就能把封面补上，不必等新专辑。
        if (!opts.dryRun) {
            try {
                await refreshLibrary(opts, accountEnv)
            } catch (e) {
                log.warn(`扫下载目录失败（不影响本轮下载）：${e.message}`)
            }
        }
        let failed = 0
        let gotThisRound = 0
        let cappedThisRound = false
        if (ids.length > 0) {
            const result = await runOnce(ids, {...opts, maxPerRound: roundMax, account, accountEnv})
            if (result.aborted) {
                // 刚被暂停打断，回到循环顶部进 waitForWake，别去算休眠时长
                continue
            }
            failed = result.fail
            gotThisRound = Number(result.downloaded) || 0
            cappedThisRound = !!result.capped
            // 只有真跑过一轮才累加当日计数 —— 别去读 state.lastRound，
            // ids 为空时它还是上一轮的残留值，会把同一批集数数两遍。
            if (gotThisRound > 0) {
                dailyCounts[account] = countOf(account) + gotThisRound
                saveDailyState()
            }
        } else {
            log.warn(`订阅列表是空的，往 ${albumsFile} 里一行加一个专辑 ID 或专辑链接即可，无需重启`)
        }

        if (once) {
            log.info('单次模式，退出')
            break
        }

        // 先判主动避让，再判四段式退避：
        //   ⓪ 本轮被单轮上限主动停下 → 常规周期（正常收工，不是失败）
        // 四段式退避（2026-09-28 修订。旧三段式把「当日上限」和「单轮上限」混成了一道，
        // 结果每轮下到 301 集就被当彻底失败、退避到次日，白睡一整天）：
        //   ① 本轮成功            → 常规周期
        //   ② 失败、但有新增集数   → progressRetryMinutes 后再来（撞的是单轮上限，约 1 小时恢复）
        //   ③ 失败、一集没捞到     → retryMinutes 短试（覆盖瞬时 / 小时级风控）
        //   ④ 失败、短试用尽仍 0 集 → 退避到次日 backoffAt（撞的是当日上限，盲试毫无意义）
        //
        // 常规周期要按账号数分摊（2026-09-29 多账号）：每个账号自己仍然是 intervalHours
        // 一轮，所以两轮之间只隔 intervalHours / N —— 2 个账号 = 每 3 小时跑一轮，日产量翻倍。
        // 除数用**本轮结束后还有余额的账号数**，不是账号总数：某个账号下满了，剩下的账号
        // 就该恢复成自己的完整周期，不该继续被分摊（否则它得熬到 12 小时才轮到下一次）。
        // 只有常规周期分摊；重试分支（②③④）不分摊 —— 那是异常路径，该尽快回来看恢复了没有。
        const activeAfter = activeAccounts.filter(a => remainingOf(a) > 0).length
        const normalWaitMs = (intervalHours * 60 * 60 * 1000) / Math.max(1, activeAfter)
        const gapHuman = normalWaitMs >= 3600000
            ? `${(normalWaitMs / 3600000).toFixed(1)} 小时`
            : (normalWaitMs >= 60000
                ? `${Math.round(normalWaitMs / 60000)} 分钟`
                : `${Math.round(normalWaitMs / 1000)} 秒`)
        let waitMs = normalWaitMs
        let note = ''
        let stage = 'normal'
        if (cappedThisRound) {
            // 主动避让的正常收工：本轮的配额下完了。**算成功** —— consecutiveFailures
            // 归零（这一轮确实下到了东西，不是被风控），也不走任何重试分支。
            consecutiveFailures = 0
            stage = 'round-capped'
            note = `【账号 ${account} 本轮下到 ${gotThisRound} 集，达到单轮上限 ${roundMax} 集，`
                + `主动停下（正常收工）；它今日累计 ${countOf(account)}${dailyCap > 0 ? `/${dailyCap}` : ''} 集，`
                + `${gapHuman} 后下一轮】`
        } else if (failed > 0 && gotThisRound > 0 && progressRetryMinutes > 0) {
            // 有进展 = 撞的是单轮配额，不是当日额度。**不动 consecutiveFailures**：
            // 它只数「一集没捞到的连续轮次」，所以这一轮既不加也不清零。
            // （别在这里清零 —— 清零会让当日额度真耗尽时又从 6 次短试从头数起，白转 3 小时。）
            stage = 'progress-retry'
            blockAccount(account, progressRetryMinutes * 60 * 1000)
            waitMs = progressRetryMinutes * 60 * 1000
            // v9：还有别的账号能马上顶上就**不睡** —— 立刻开下一轮去撞另一条命。
            const altP = nextAvailableAccount(account)
            if (altP != null) {
                waitMs = 0
                note = `【账号 ${account} 本轮失败，但新增 ${gotThisRound} 集 → 撞的是单轮上限`
                    + `（实测约 301 集）；${account} 冷却 ${progressRetryMinutes} 分钟，`
                    + `立刻换账号 ${altP} 顶上】`
            } else {
                note = `【账号 ${account} 本轮失败，但新增 ${gotThisRound} 集 → 撞的是单轮上限（实测约 301 集），`
                    + `${progressRetryMinutes} 分钟后就恢复，不退避到次日`
                    + `${activeAccounts.length > 1 ? '；其它账号也在冷却里，只能等' : ''}】`
            }
        } else if (failed > 0 && consecutiveFailures < maxRetries) {
            consecutiveFailures++
            stage = 'short-retry'
            blockAccount(account, retryMinutes * 60 * 1000)
            waitMs = retryMinutes * 60 * 1000
            // 措辞说明（2026-09-27 核查后改）：N 记的是**接下来这次**短试的序号，
            // 不是「刚刚失败的是第 N 次」—— 首次失败时也打 1/6，以前写「第 1/6 次短试」
            // 会被误读成「第 1 次重试」，让人以为计数器从 0 起。
            const altS = nextAvailableAccount(account)
            if (altS != null) {
                waitMs = 0
                note = `【账号 ${account} 本轮一集没捞到 → 让 ${account} 冷却 ${retryMinutes} 分钟，`
                    + `立刻换账号 ${altS} 顶上（换的是 cookie 不是公网 IP，凭据/接口问题照样会失败）】`
            } else {
                note = `【账号 ${account} 本轮失败 → 接下来第 ${consecutiveFailures}/${maxRetries} 次短试】`
            }
        } else if (failed > 0) {
            // 注意 consecutiveFailures **继续累加**，别清零 —— 清零会让它退回去重新短试，
            // 于是每天都要空转 3 小时。只有真的成功了才归零。
            consecutiveFailures++
            stage = 'backoff'
            const w = backoffAt ? msUntilNextDayWindow(backoffAt) : null
            if (w) {
                waitMs = w.ms
                // 把 N 的构成写出来，省得再有人问「为什么是 7 而不是 6」
                note = `【账号 ${account} 已连续 ${consecutiveFailures} 轮一集没捞到`
                    + `（首轮 + ${maxRetries} 次短试已用尽）→ 退避到 ${w.label}】`
                    + ` 当日上限实测约 990 集/账号、跨整点不恢复；届时仍失败请查凭据或接口`
            } else {
                note = `【账号 ${account} 已连续 ${consecutiveFailures} 轮一集没捞到，退回常规周期`
                    + ` —— 请查日志确认不是凭据或接口问题】`
                consecutiveFailures = 0
                stage = 'normal'
                waitMs = normalWaitMs
            }
        } else {
            consecutiveFailures = 0
        }

        setSched(stage)

        // v9：撞墙后换账号顶上的情况 waitMs = 0 —— 不睡，立刻开下一轮（阶段仍是
        // progress-retry / short-retry，面板上看得出这是「撞墙换号」而不是正常周期）。
        if (waitMs <= 0) {
            log.info(`不睡，立刻开始第 ${round + 1} 轮 ${note}`)
            continue
        }

        const human = waitMs >= 3600000
            ? `${(waitMs / 3600000).toFixed(1)} 小时`
            : `${Math.round(waitMs / 60000)} 分钟`
        log.info(`休眠 ${human} 后再来 ${note}`)
        const interrupted = await sleepInterruptible(
            waitMs,
            `休眠 ${human}后进入第 ${round + 1} 轮 ${note}`.trim())
        if (interrupted) {
            log.info('休眠被「继续 / 立即跑一轮」打断，马上开始下一轮')
        }
    }
}

// 容器 stop 时别把子进程甩下不管
process.on('SIGTERM', () => {
    log.info('收到停止信号，结束当前任务后退出')
    if (currentChild) {
        try {
            currentChild.kill('SIGTERM')
        } catch (e) {
            // 忽略
        }
    }
    process.exit(0)
})

main().catch(e => {
    log.error(`调度器异常退出：${e && e.stack || e}`)
    process.exit(1)
})
