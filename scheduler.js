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

const PROXY_KEYS = ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']

/**
 * 子进程环境：清掉代理变量。
 *
 * 踩过的坑：http_proxy 指向一个 HTTP 代理时，axios 处理 https:// 请求会把
 * 明文发到 443，服务端回 "The plain http request was sent to https port"，
 * 表现成莫名其妙的 400。容器里一般没代理，但这个变量从宿主机漏进来就麻烦了。
 */
function childEnv() {
    const env = {...process.env}
    for (const k of PROXY_KEYS) delete env[k]
    return env
}

let currentChild = null

// 本轮**真正下到**的集数。
// 必须认「下载成功」这三个字：日志里还有「当前信息>>>>>进度:」这类同样能匹配
// RE_PROGRESS 的行（专辑已下完时每轮都会打一行），只按 RE_PROGRESS 数会虚高 ——
// 2026-09-27 核查时踩到：`grep '进度:'` 数出 821，真实只有 807。
let roundDownloaded = 0

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
        if (line.includes('下载成功')) roundDownloaded++
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
            env: childEnv(),
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
    let ok = 0
    let fail = 0
    let aborted = false
    for (const id of ids) {
        if (state.paused) {
            aborted = true
            break
        }
        const code = await runAlbum(id, opts)
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
    const quickFail = fail > 0 && Number(mins) < 1
    log.info(`本轮结束：成功 ${ok} 个，失败 ${fail} 个，新增 ${got} 集，耗时 ${mins} 分钟`
        + `${aborted ? '（被暂停打断）' : ''}`
        + `${quickFail ? '　← 秒级失败：第一集就被挡，通常是限流/额度耗尽，不是凭据问题' : ''}`)
    state.lastRound = {ok, fail, minutes: Number(mins), at: Date.now(), aborted, downloaded: got}
    return {ok, fail, aborted}
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

/**
 * 找一份可用的登录凭据。
 * @returns {string|null} 凭据文件路径，找不到返回 null
 */
function findCredential() {
    const dir = xmdDir()
    for (const f of ['www2-cookies.json', 'mac-cookies.json']) {
        const p = path.join(dir, f)
        try {
            const arr = JSON.parse(fs.readFileSync(p, 'utf-8'))
            if (Array.isArray(arr) && arr.length > 0) return p
        } catch (e) {
            // 不存在或不是合法 JSON，看下一个
        }
    }
    return null
}

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

    const cred = findCredential()
    if (cred == null) {
        log.error(`没有找到登录凭据（找的是 ${xmdDir()}），无法在无人值守下登录。`)
        log.error('服务端没有屏幕，扫码登录走不通。请这样做：')
        log.error('  1) 在有屏幕的 Windows 上跑一次：node login.js')
        log.error('  2) 把这个目录整个拷到宿主机的映射目录：C:\\Users\\<你>\\.xmd')
        log.error('  3) 重启本容器')
        process.exit(2)
    }
    log.info(`登录凭据：${cred}`)

    if (!fs.existsSync(opts.output)) {
        fs.mkdirSync(opts.output, {recursive: true})
    }

    let round = 0
    let consecutiveFailures = 0
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

        log.info(`第 ${round} 轮，待处理专辑 ${ids.length} 个：${ids.join(', ') || '(空)'}`)
        let failed = 0
        if (ids.length > 0) {
            const result = await runOnce(ids, opts)
            if (result.aborted) {
                // 刚被暂停打断，回到循环顶部进 waitForWake，别去算休眠时长
                continue
            }
            failed = result.fail
        } else {
            log.warn(`订阅列表是空的，往 ${albumsFile} 里一行加一个专辑 ID 或专辑链接即可，无需重启`)
        }

        if (once) {
            log.info('单次模式，退出')
            break
        }

        // 四段式退避（2026-09-28 修订。旧三段式把「当日上限」和「单轮上限」混成了一道，
        // 结果每轮下到 301 集就被当彻底失败、退避到次日，白睡一整天）：
        //   ① 本轮成功            → intervalHours 常规周期
        //   ② 失败、但有新增集数   → progressRetryMinutes 后再来（撞的是单轮上限，约 1 小时恢复）
        //   ③ 失败、一集没捞到     → retryMinutes 短试（覆盖瞬时 / 小时级风控）
        //   ④ 失败、短试用尽仍 0 集 → 退避到次日 backoffAt（撞的是当日上限，盲试毫无意义）
        let waitMs = intervalHours * 60 * 60 * 1000
        let note = ''
        let stage = 'normal'
        // 这一轮到底下到东西没有。runOnce 每轮都会写 state.lastRound，failed > 0 时它必是本轮的数。
        const gotThisRound = (state.lastRound && Number(state.lastRound.downloaded)) || 0
        if (failed > 0 && gotThisRound > 0 && progressRetryMinutes > 0) {
            // 有进展 = 撞的是单轮配额，不是当日额度。**不动 consecutiveFailures**：
            // 它只数「一集没捞到的连续轮次」，所以这一轮既不加也不清零。
            // （别在这里清零 —— 清零会让当日额度真耗尽时又从 6 次短试从头数起，白转 3 小时。）
            stage = 'progress-retry'
            waitMs = progressRetryMinutes * 60 * 1000
            note = `【本轮失败，但新增 ${gotThisRound} 集 → 撞的是单轮上限（实测约 301 集），`
                + `${progressRetryMinutes} 分钟后就恢复，不退避到次日】`
        } else if (failed > 0 && consecutiveFailures < maxRetries) {
            consecutiveFailures++
            stage = 'short-retry'
            waitMs = retryMinutes * 60 * 1000
            // 措辞说明（2026-09-27 核查后改）：N 记的是**接下来这次**短试的序号，
            // 不是「刚刚失败的是第 N 次」—— 首次失败时也打 1/6，以前写「第 1/6 次短试」
            // 会被误读成「第 1 次重试」，让人以为计数器从 0 起。
            note = `【本轮失败 → 接下来第 ${consecutiveFailures}/${maxRetries} 次短试】`
        } else if (failed > 0) {
            // 注意 consecutiveFailures **继续累加**，别清零 —— 清零会让它退回去重新短试，
            // 于是每天都要空转 3 小时。只有真的成功了才归零。
            consecutiveFailures++
            stage = 'backoff'
            const w = backoffAt ? msUntilNextDayWindow(backoffAt) : null
            if (w) {
                waitMs = w.ms
                // 把 N 的构成写出来，省得再有人问「为什么是 7 而不是 6」
                note = `【已连续 ${consecutiveFailures} 轮一集没捞到（首轮 + ${maxRetries} 次短试已用尽）→ 退避到 ${w.label}】`
                    + ` 当日上限实测约 990 集、跨整点不恢复；届时仍失败请查凭据或接口`
            } else {
                note = `【已连续 ${consecutiveFailures} 轮一集没捞到，退回常规周期 —— 请查日志确认不是凭据或接口问题】`
                consecutiveFailures = 0
                stage = 'normal'
            }
        } else {
            consecutiveFailures = 0
        }

        // 退避状态挂到 state 上，网页面板 / api 直接读得到（不用 ssh 翻日志）
        state.sched = {stage, consecutiveFailures, maxRetries, retryMinutes, progressRetryMinutes, backoffAt}

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
