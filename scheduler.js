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
    log.info(`本轮结束：成功 ${ok} 个，失败 ${fail} 个，耗时 ${mins} 分钟${aborted ? '（被暂停打断）' : ''}`)
    state.lastRound = {ok, fail, minutes: Number(mins), at: Date.now(), aborted}
    return {ok, fail, aborted}
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
    // 失败后的短间隔重试。多为账号级「整点重置」的额度用尽，几十集到几百集就跑满，
    // 睡满 intervalHours 等于白扔好几个窗口，所以先密集重试几轮。
    const retryMinutes = Number(sched.retryMinutes) > 0 ? Number(sched.retryMinutes) : 30
    // 默认 24 次 = 12 小时。别调小：额度是整点重置的，一次跨时段的限流很容易
    // 把 6 次（3 小时）用光，然后就睡满 intervalHours —— 实测这样会白扔一整夜。
    const maxRetries = Number(sched.maxRetries) > 0 ? Number(sched.maxRetries) : 24
    const albumsFile = sched.albumsFile
        ? path.resolve(projectRoot, sched.albumsFile)
        : path.join(projectRoot, 'albums.txt')
    const once = process.argv.includes('--once')

    log.info('喜马拉雅自动下载调度器 启动')
    log.info(`下载目录：${opts.output}`)
    log.info(`订阅列表：${albumsFile}`)
    log.info(`并发：${opts.slow ? '慢速模式（串行）' : opts.concurrency}　扫描间隔：${intervalHours} 小时` +
        (opts.dryRun ? '　【试运行，不会真的下载】' : ''))
    log.info(`失败重试：${retryMinutes} 分钟一次，最多连续 ${maxRetries} 次，之后回到常规周期`)

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

        // 额度是整点重置的，所以失败后先短间隔重试，别一觉睡到大天亮。
        // 连续若干轮都失败说明不是额度问题（凭据失效、平台改接口），
        // 那就回到常规周期，别一直空转刷日志。
        let waitMinutes = intervalHours * 60
        let note = ''
        if (failed > 0 && consecutiveFailures < maxRetries) {
            consecutiveFailures++
            waitMinutes = retryMinutes
            note = `【失败，第 ${consecutiveFailures}/${maxRetries} 次快速重试】`
        } else if (failed > 0) {
            note = `【已连续 ${consecutiveFailures} 轮失败，改回常规周期 —— 请查日志确认不是凭据或接口问题】`
            consecutiveFailures = 0
        } else {
            consecutiveFailures = 0
        }

        const human = waitMinutes >= 60
            ? `${(waitMinutes / 60).toFixed(1)} 小时`
            : `${waitMinutes} 分钟`
        log.info(`休眠 ${human} 后再来 ${note}`)
        const interrupted = await sleepInterruptible(
            waitMinutes * 60 * 1000,
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
