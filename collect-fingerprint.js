/**
 * 用**真实 Edge**（普通启动 + CDP 连接）采集喜马拉雅风控 SDK 的设备指纹。
 *
 * 为什么这样能和「Playwright/Selenium 会被拒」区分开：
 * 被风控拒的是**自动化标志**，不是指纹内容本身。Playwright `launch()` 会加上
 * `--enable-automation`、注入 `navigator.webdriver`、暴露 `cdc_`/`$wdc_` 之类特征；
 * 而这里浏览器是当普通程序启动的，我们只是事后连上它的调试端口读一个 JS 变量。
 * 指纹里的 canvas/webgl/字体/屏幕/时区这些，本来就只跟「机器 + 浏览器版本」有关。
 *
 * 用法：node collect-fingerprint.js
 * 产出：与脚本同目录的 _device-info.collected.json（不直接覆盖 ~/.xmd/ 下那份，
 *       本机那份是「已生效」的，采集失败时不能把它弄坏）
 */
import {spawn} from 'child_process'
import dns from 'dns'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {fileURLToPath} from 'url'

// 产物跟脚本走，不跟 cwd 走 —— 从别的目录用绝对路径调用时 cwd 是别人的
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(SCRIPT_DIR, '_device-info.collected.json')
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
// 端口可覆盖：9333 被别的调试实例占用时换个端口就行
const PORT = Number(process.env.XMD_CDP_PORT || 9333)

// 用哪个浏览器采：XMD_FP_BROWSER=edge|chrome|完整路径，不设就沿用老规矩（有 Edge 就用 Edge）。
// 这台机器上两个浏览器各采一份 = 两份不一样的指纹（UA、插件那几项会变），
// 多账号时正好一个账号一份（见 SKILL §5 多账号）。
const BROWSER = String(process.env.XMD_FP_BROWSER || '').trim()
function pickExe() {
    const b = BROWSER.toLowerCase()
    if (b === 'edge') return EDGE
    if (b === 'chrome') return CHROME
    if (BROWSER) return BROWSER
    return fs.existsSync(EDGE) ? EDGE : CHROME
}
const exe = pickExe()
const browserKey = /msedge/i.test(exe) ? 'edge' : (/chrome/i.test(exe) ? 'chrome' : 'browser')
// profile 必须按浏览器分开：Edge 和 Chrome 共用一个 user-data-dir 会互相打架
const PROFILE = path.join(os.tmpdir(), `xmd-fp-profile-${browserKey}`)
const TARGET_URL = 'https://www.ximalaya.com'

// 风控上报域在本机被 AdGuardHome 当 tracker 打死了（系统 DNS 回 0.0.0.0 / ::）。
// 后果很隐蔽：页面能开、SDK 能就绪、字段也能填，但 **SDK 自己那次上报发不出去**，
// 于是采到的 GJ2 / fd2 是空的 —— 这种指纹拿去容器里上报，服务端会「收下（err:0）
// 但不给 aid/cadd」，付费接口照样用不了。所以采集时自己解一个真地址，只给这个
// 浏览器窗口加一条 --host-resolver-rules，不动系统 DNS、不动 AdGuardHome。
//   XMD_FP_MAP=off          关掉（想完全按老样子采就设它）
//   XMD_FP_MAP=host=1.2.3.4 手动指定，不管 DNS
const FP_MAP_HOST = process.env.XMD_FP_MAP_HOST || 'hdaa.shuzilm.cn'
const FP_MAP_DNS = String(process.env.XMD_FP_MAP_DNS || '223.5.5.5,119.29.29.29,114.114.114.114')
    .split(',').map(s => s.trim()).filter(Boolean)
const FP_MAP = String(process.env.XMD_FP_MAP || '').trim()

async function resolveWithFallbackDns(host) {
    // 用系统解析器以外的 DNS 自己解，系统那份被 AdGuardHome 污染了
    const resolver = new dns.promises.Resolver()
    resolver.setServers(FP_MAP_DNS)
    const ips = await resolver.resolve4(host)
    if (!ips || !ips.length) throw new Error('没有 A 记录')
    return ips
}

async function buildResolverRule() {
    if (FP_MAP.toLowerCase() === 'off') {
        log('XMD_FP_MAP=off：不绕过本机 DNS（SDK 注册上报可能失败，采出来的指纹可能不可用）')
        return ''
    }
    try {
        let host = FP_MAP_HOST
        let ip = ''
        if (FP_MAP) {
            if (!FP_MAP.includes('=')) throw new Error('格式应为 host=ip 或 off')
            const [h, v] = FP_MAP.split('=')
            host = h.trim()
            ip = v.trim()
        } else {
            const ips = await resolveWithFallbackDns(host)
            ip = ips[0]
            log(`兜底 DNS 解析：${host} -> ${ips.join(', ')}（取 ${ip}，只影响这次采集窗口）`)
        }
        if (!ip) throw new Error('没拿到地址')
        log(`已给采集窗口加 host-resolver-rules：MAP ${host} ${ip}`)
        return `MAP ${host} ${ip}`
    } catch (e) {
        log(`⚠️ 没能为 ${FP_MAP_HOST} 准备旁路地址：${e.message}`)
        log('   继续采，但 SDK 自己那次上报大概率失败 → 采到的指纹会是「没注册过」的，容器里用不了')
        return ''
    }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(...a)

// 与上游 README 同一段逻辑，只是把控制台的 copy() 换成返回字符串
const COLLECT_EXPR = `JSON.stringify((()=>{const s=window.du_web_sdk,c=s._deviceInfoCollector||s._checkextensions._deviceInfoCollector,o={};for(const k of Object.keys(c)){const v=c[k];if(typeof v==='function')continue;try{JSON.stringify(v);o[k]=v}catch(e){}}return o})())`

const PROBE_EXPR = `(()=>{
  const s = window.du_web_sdk
  if (!s) return 'no-sdk'
  const c = s._deviceInfoCollector || (s._checkextensions && s._checkextensions._deviceInfoCollector)
  if (!c) return 'no-collector keys=' + Object.keys(s).slice(0, 12).join(',')
  return 'ok:' + Object.keys(c).length
})()`

// 看清楚数据到底住在哪个采集器上、有没有被填过
const STRUCT_EXPR = `(()=>{
  const s = window.du_web_sdk
  const shape = (c, name) => {
    if (!c) return {name, exists: false}
    const ks = Object.keys(c)
    let ua = null
    try { ua = c.ew1 && c.ew1.yV2 } catch (e) { ua = 'ERR' }
    return {
      name,
      exists: true,
      keyCount: ks.length,
      ua: ua === undefined ? '(no ew1)' : (ua === '' ? '(empty string)' : String(ua).slice(0, 60)),
      sample: ks.slice(0, 14).join(','),
    }
  }
  return JSON.stringify({
    sdkKeys: Object.keys(s).slice(0, 30),
    main: shape(s._deviceInfoCollector, 'main'),
    checkExt: shape(s._checkextensions && s._checkextensions._deviceInfoCollector, 'checkextensions'),
    checkDetects: shape(s._checkdetects && s._checkdetects._deviceInfoCollector, 'checkdetects'),
    prototypes: ['initData', 'buildStaticData', 'updatePV', 'getData', 'setData']
        .filter(k => typeof s[k] === 'function'),
  }, null, 1)
})()`

// 数据是异步填的：SDK 出现时还是空模板，要等它自己填完
const FILLED_EXPR = `(()=>{
  const s = window.du_web_sdk
  const c = s && (s._deviceInfoCollector ||
      (s._checkextensions && s._checkextensions._deviceInfoCollector))
  if (!c) return 'no-collector'
  const ua = c.ew1 && c.ew1.yV2
  if (!ua) return 'empty(keyCount=' + Object.keys(c).length + ')'
  return 'filled:' + String(ua).slice(0, 60)
})()`

// 这份指纹到底「注册」成功没有：服务端认下 SDK 的上报后，才会把 aid/cadd 塞回 fd2、
// 把设备号塞进 GJ2。空着 = 上报压根没发出去（典型原因：本机 DNS 把上报域挡了）。
const REGISTERED_EXPR = `JSON.stringify((()=>{
  const s = window.du_web_sdk
  const c = s && (s._deviceInfoCollector ||
      (s._checkextensions && s._checkextensions._deviceInfoCollector))
  if (!c) return {ok: false, GJ2: '', av1: '', aid: ''}
  return {
    ok: true,
    GJ2: c.GJ2 || '',
    av1: (c.fd2 && c.fd2.av1) || '',
    aid: (c.fd2 && c.fd2.Ja5) || '',
  }
})())`

class CDP {
    constructor(ws) {
        this.ws = ws
        this.seq = 0
        this.pending = new Map()
    }

    static async connect(url) {
        const ws = new WebSocket(url)
        await new Promise((res, rej) => {
            ws.addEventListener('open', res, {once: true})
            ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), {once: true})
        })
        const c = new CDP(ws)
        ws.addEventListener('message', ev => {
            let msg
            try {
                msg = JSON.parse(ev.data)
            } catch (e) {
                return
            }
            if (msg.id && c.pending.has(msg.id)) {
                const {resolve, reject} = c.pending.get(msg.id)
                c.pending.delete(msg.id)
                if (msg.error) reject(new Error(msg.error.message))
                else resolve(msg.result)
            }
        })
        return c
    }

    send(method, params = {}) {
        const id = ++this.seq
        return new Promise((resolve, reject) => {
            this.pending.set(id, {resolve, reject})
            this.ws.send(JSON.stringify({id, method, params}))
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id)
                    reject(new Error(`${method} 超时`))
                }
            }, 60000)
        })
    }

    async eval(expression) {
        const r = await this.send('Runtime.evaluate', {
            expression, returnByValue: true, awaitPromise: true,
        })
        if (r.exceptionDetails) {
            throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description
                || r.exceptionDetails.text)
        }
        return r.result.value
    }
}

async function waitPort(timeoutMs) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
        try {
            const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
            if (r.ok) return await r.json()
        } catch (e) {
            // 还没起来
        }
        await sleep(300)
    }
    throw new Error('CDP 端口一直没起来')
}

async function findPage() {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    const list = await r.json()
    const pages = list.filter(t => t.type === 'page')
    return pages.find(t => /ximalaya\.com/.test(t.url)) || pages[0] || null
}

async function main() {
    if (!fs.existsSync(exe)) {
        throw new Error('没找到要用的浏览器，无法采集。\n' +
            `  XMD_FP_BROWSER=${BROWSER || '(没设，自动挑)'}\n` +
            `  实际要跑的：${exe}\n` +
            `  备用：${EDGE}\n        ${CHROME}`)
    }
    log(`浏览器：${exe}（${browserKey}）`)
    log(`独立 profile：${PROFILE}`)
    log('（会自己开一个浏览器窗口，采完自动关掉，不用管它）')

    const resolverRule = await buildResolverRule()

    const child = spawn(exe, [
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${PROFILE}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        '--window-size=1280,900',
        ...(resolverRule ? [`--host-resolver-rules=${resolverRule}`] : []),
        TARGET_URL,
    ], {stdio: 'ignore'})

    let cdp = null
    try {
        const ver = await waitPort(20000)
        log(`已连上：${ver.Browser}`)

        // 等页面 target 出现
        let page = null
        for (let i = 0; i < 40 && !page; i++) {
            page = await findPage()
            if (!page) await sleep(300)
        }
        if (!page) throw new Error('没找到页面 target')
        log(`页面：${page.url}`)

        cdp = await CDP.connect(page.webSocketDebuggerUrl)
        await cdp.send('Runtime.enable')

        // 顺手确认一下自动化痕迹是否干净
        const marker = await cdp.eval(`JSON.stringify({
          webdriver: navigator.webdriver,
          ua: navigator.userAgent,
          platform: navigator.platform,
          hardwareConcurrency: navigator.hardwareConcurrency,
          langs: navigator.languages,
          cdc: Object.keys(window).filter(k => /^(cdc_|\\$wdc_|__webdriver|__selenium|__phantom|callPhantom|domAutomation)/.test(k)),
        })`)
        log('环境自检：' + marker)

        // 等风控 SDK 就绪
        let state = ''
        for (let i = 0; i < 60; i++) {
            try {
                state = await cdp.eval(PROBE_EXPR)
            } catch (e) {
                state = 'err:' + e.message
            }
            if (String(state).startsWith('ok:')) break
            if (i % 6 === 0) log(`  等待 SDK… ${state}`)
            await sleep(500)
        }
        log(`SDK 状态：${state}`)
        if (!String(state).startsWith('ok:')) {
            throw new Error('SDK 没就绪，无法采集')
        }

        // 结构诊断：数据到底在哪、有没有被填
        log('结构诊断：')
        log(await cdp.eval(STRUCT_EXPR))

        // 采集器是异步填数据的，出现时还是空模板，得等
        let filled = ''
        for (let i = 0; i < 80; i++) {
            try {
                filled = await cdp.eval(FILLED_EXPR)
            } catch (e) {
                filled = 'err:' + e.message
            }
            if (String(filled).startsWith('filled:')) break
            if (i % 8 === 0) log(`  等数据填充… ${filled}`)
            await sleep(500)
        }
        log(`填充状态：${filled}`)

        // 光「字段填好了」还不够，还得等 SDK 自己那次上报被服务端认下来
        let reg = {GJ2: '', av1: '', aid: ''}
        for (let i = 0; i < 40; i++) {
            try {
                reg = JSON.parse(await cdp.eval(REGISTERED_EXPR))
            } catch (e) {
                reg = {GJ2: '', av1: '', err: e.message}
            }
            if (reg.av1) break
            if (i % 8 === 0) log(`  等 SDK 上报落地… GJ2=${reg.GJ2 || '(空)'} av1=${reg.av1 || '(空)'}`)
            await sleep(500)
        }
        log(`上报状态：GJ2=${reg.GJ2 || '(空)'} aid=${reg.aid || '(空)'} cadd=${reg.av1 || '(空)'}`)

        const raw = await cdp.eval(COLLECT_EXPR)
        if (!raw) throw new Error('采集返回空')
        const info = JSON.parse(raw)
        const keys = Object.keys(info)
        log(`采集到 ${keys.length} 个字段`)

        // 能不能用，一眼看这里：没注册成功的指纹，容器上报只拿到 err:0、没有 cadd
        const registered = Boolean(info.GJ2) && Boolean(info.fd2 && info.fd2.av1)
        log(`XMD_FP_REGISTERED=${registered ? 1 : 0}`)
        if (!registered) {
            log('⚠️ 这份指纹是「没注册过」的：GJ2 / fd2.av1 是空的，说明 SDK 自己那次上报没落地。')
            log('   容器拿它上报会被「收下但不给 cadd」，付费接口用不了 —— 别拿它给账号用。')
            log('   先查本机 DNS 有没有把 hdaa.shuzilm.cn 挡掉（AdGuardHome 常把它当 tracker），')
            log('   或直接指定地址重采：XMD_FP_MAP=hdaa.shuzilm.cn=123.56.155.222')
        }

        fs.writeFileSync(OUT, JSON.stringify(info), 'utf8')
        log(`已写入：${OUT}`)
        // 给上层（图形界面 / 脚本）留机器可读的出口，别去猜文件名
        log(`XMD_FP_OUT=${OUT}`)
        log(`XMD_FP_FIELDS=${keys.length}`)

        // 关键字段预览，方便人工判断像不像真的
        const peek = {}
        for (const k of ['ew1', 'b2', 'Zf5', 'Y1', 'b1']) {
            if (info[k] !== undefined) peek[k] = info[k]
        }
        log('关键字段预览：' + JSON.stringify(peek).slice(0, 600))
    } finally {
        try {
            if (cdp) await cdp.send('Browser.close')
        } catch (e) {
            // 关不掉就强杀
            try {
                child.kill()
            } catch (e2) {
            }
        }
        await sleep(800)
    }
}

main().then(
    () => process.exit(0),
    e => {
        console.error('失败：' + (e && e.stack || e))
        process.exit(1)
    },
)
