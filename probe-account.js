/**
 * 探测一个账号还活着没有 —— 网页面板上「探测」和调度器每轮开跑前都用它。
 *
 * 为什么必须是**子进程**：`config.xmd` 是进程启动时定死的，`AbstractDownloader`
 * 的 cookiePath / qrCodePath 都从它算出来。想在同一个进程里探第二个账号，
 * 得把所有模块重新 import 一遍 —— 换个进程（XMD_XMD_DIR 指过去）反而最干净。
 *
 * 用法：
 *   XMD_XMD_DIR=<账号目录> XMD_DB_DIR=<共用目录> node probe-account.js <账号名> [--fingerprint-only]
 *
 * 输出：人看的日志走 log4js（父进程会转发进 app.log），最后一行是机器可读的
 *   XMD_PROBE_RESULT={...}
 *
 * 注意这里**绝不调 factory.getDownloader()** —— 那个在 isLogin() 为假时会去走扫码登录，
 * 在没屏幕的容器里就一直挂着。这里只读 cookie + 查当前用户，不触发任何登录。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {config} from './common/config.js'
import {log} from './common/log4jscf.js'
import {WebSiteDownloader} from './handler/webSiteDownloader.js'
import {DarwinDownloader} from './handler/darwinDownloader.js'
import {reportDeviceInfo} from './handler/core/xm-sign.js'

const name = process.argv[2] || 'default'
const fingerprintOnly = process.argv.includes('--fingerprint-only')
const dir = String(config.xmd || '~/.xmd').replace('~', os.homedir())

function readCookieFile(file) {
    try {
        const arr = JSON.parse(fs.readFileSync(file, 'utf-8'))
        return Array.isArray(arr) && arr.length > 0 ? arr : null
    } catch (e) {
        return null
    }
}

/** 从 cookie 数组里抠出 1&_token 的值（形如 "<uid>&remember_me..."），拿 uid 做兜底 */
function uidFromCookies(file) {
    const arr = readCookieFile(file)
    if (arr == null) return null
    for (const c of arr) {
        const key = c && (c.name != null ? c.name : c.key)
        if (String(key) !== '1&_token') continue
        const m = String(c.value == null ? '' : c.value).match(/^(\d+)/)
        if (m) return m[1]
    }
    return null
}

function pickUid(user) {
    for (const k of ['uid', 'id', 'userId', 'user_id']) {
        if (user && user[k] != null && String(user[k]) !== '') return String(user[k])
    }
    return null
}

/**
 * 探一条通道。**不调 isLogin()** —— 它只回 true/false，页面要的是
 * 「哪个通道死了、为什么死、这个账号还是不是 VIP」，所以直接读当前用户。
 */
async function probeChannel(Downloader, type) {
    const out = {type, ok: false, msg: '', uid: null, nickname: null, vip: false, vipExpire: null, robot: false, ban: false}
    if (readCookieFile(path.join(dir, `${type}-cookies.json`)) == null) {
        out.msg = `没有 ${type}-cookies.json（这个通道没登录过）`
        return out
    }
    try {
        const downloader = new Downloader()
        const user = await downloader._getCurrentUser()
        if (user == null) {
            // _getCurrentUser 里 401 已经打过日志了
            out.msg = '凭据已失效（接口返回 401，需要重新扫码登录）'
            return out
        }
        out.ok = true
        out.msg = '正常'
        out.uid = pickUid(user)
        out.nickname = user.nickname != null ? String(user.nickname) : null
        out.vip = user.isVip === true
        out.vipExpire = user.vipExpireTime != null ? user.vipExpireTime : null
        out.robot = user.isRobot === true
        out.ban = user.isLoginBan === true
    } catch (e) {
        out.msg = (e && e.message) ? e.message : String(e)
    }
    return out
}

const result = {
    name,
    dir,
    at: Date.now(),
    alive: false,
    reason: '',
    uid: null,
    nickname: null,
    vip: false,
    vipExpire: null,
    robot: false,
    ban: false,
    channels: {},
    fingerprint: null,
}

try {
    log.info(`[探测] 账号 ${name}，目录 ${dir}`)

    if (!fingerprintOnly) {
        result.channels.www2 = await probeChannel(WebSiteDownloader, 'www2')
        result.channels.mac = await probeChannel(DarwinDownloader, 'mac')
        const live = Object.values(result.channels).filter(c => c.ok)
        result.alive = live.length > 0
        const best = live.find(c => c.uid) || live[0] || null
        if (best) {
            result.uid = best.uid || uidFromCookies(path.join(dir, 'www2-cookies.json'))
            result.nickname = best.nickname
            result.vip = live.some(c => c.vip)
            result.vipExpire = live.map(c => c.vipExpire).find(v => v != null) || null
            result.robot = live.some(c => c.robot)
            result.ban = live.some(c => c.ban)
        }
        if (!result.alive) {
            result.reason = Object.values(result.channels).map(c => `${c.type}：${c.msg}`).join('；')
            log.error(`[探测] 账号 ${name} 不可用 —— ${result.reason}`)
        } else {
            log.info(`[探测] 账号 ${name} 可用：${result.nickname || result.uid || '（未取到昵称）'}`
                + `　VIP ${result.vip ? '是' : '否'}${result.vipExpire != null ? `（剩 ${result.vipExpire} 天）` : ''}`
                + `　通道 ${Object.values(result.channels).filter(c => c.ok).map(c => c.type).join('+')}`)
            for (const c of Object.values(result.channels)) {
                if (!c.ok) log.warn(`[探测] 账号 ${name} 的 ${c.type} 通道不可用：${c.msg}`)
            }
            if (result.ban) log.warn(`[探测] 账号 ${name} 被禁止登录`)
            if (result.robot) log.warn(`[探测] 账号 ${name} 被系统检测为机器人`)
        }
    }

    // 指纹：报一次拿服务端原话。和登录无关，所以单独 try，坏了不影响登录判定
    try {
        const fp = await reportDeviceInfo()
        result.fingerprint = {
            path: fp.path,
            exists: fp.exists,
            fields: fp.fields,
            ua: fp.ua,
            registered: fp.registered,
            accepted: fp.accepted === true,
            aid: fp.aid,
            err: fp.err,
            http: fp.http,
            error: fp.error,
        }
        if (!fp.exists) {
            log.warn(`[探测] 账号 ${name} 没有设备指纹文件（${fp.path}）—— 免费集能下，付费集会直接失败`)
        } else if (fp.accepted === true) {
            log.info(`[探测] 账号 ${name} 设备指纹可用：设备 ${fp.aid}　字段 ${fp.fields} 个`)
        } else {
            log.error(`[探测] 账号 ${name} 的设备指纹**服务端不认**（${fp.path}）：`
                + `${fp.error || `aid/cadd 为空，err=${fp.err}`}　付费声音会下载失败，得重新采一份`)
        }
    } catch (e) {
        result.fingerprint = {error: e.message}
        log.error(`[探测] 账号 ${name} 指纹校验异常：${e.message}`)
    }
} catch (e) {
    result.reason = result.reason || ('探测异常：' + e.message)
    log.error(`[探测] 账号 ${name} 探测异常：${e.stack || e.message}`)
}

// 最后一行给父进程（网页 / 调度器）解析。前面的人话日志父进程直接转发。
console.log('XMD_PROBE_RESULT=' + JSON.stringify(result))
