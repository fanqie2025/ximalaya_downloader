import crypto from 'crypto'
import zlib from 'zlib'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {iaxios} from '../../common/axioscf.js'
import {config, dbDirPath} from '../../common/config.js'
import {CustomError} from '../../common/error.js'

const REPORT_URL = 'https://hdaa.shuzilm.cn/report?v=1.2.0&e=1&c=1&r='
const REPORT_KEY = 'm9ZtRrz:qujT8@da'

// 采集快照里混着 SDK 自己的 storage 代理和嵌套采集器，真实页面上报时不带这些，
// 原样发出去会被服务端当成采集器对象而不是设备报告
const INTERNAL_KEYS = ['_caddStorage', '_checkdetects', '_checkextensions', '_checkintacts',
    '_cidStorage', '_getmousetest', '_idstor', '_ipfStorage', '_ipflagStorage', '_pkgStorage',
    '_envalue', 'infoCallback', 'url_host']

function aesEncrypt(buffer) {
    const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(REPORT_KEY, 'utf8'), null)
    return Buffer.concat([cipher.update(buffer), cipher.final()])
}

function aesDecrypt(buffer) {
    const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from(REPORT_KEY, 'utf8'), null)
    return Buffer.concat([decipher.update(buffer), decipher.final()])
}

// 设备指纹（device-info.json）是「设备」级的，不是「账号」级的：同一台机器上采出来的本就该是同一份。
// 所以账号目录里没有自己那份时，自动沿用共用目录（XMD_DB_DIR，不配就是根 xmd）那份 ——
// 加账号时就不用再把指纹拷进账号目录了。想给某个账号单独一份，直接放进它自己的目录，这里优先用它。
function deviceInfoPath() {
    const own = path.join(config.xmd.replace('~', os.homedir()), 'device-info.json')
    if (fs.existsSync(own)) {
        return own
    }
    const shared = path.join(dbDirPath(), 'device-info.json')
    if (fs.existsSync(shared)) {
        return shared
    }
    return own
}

function readDeviceInfo() {
    const file = deviceInfoPath()
    if (!fs.existsSync(file)) {
        throw new CustomError(404, `缺少设备指纹文件 ${file}，付费声音无法下载，采集方法见 README`)
    }
    const info = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const key of INTERNAL_KEYS) {
        delete info[key]
    }
    return info
}

function userAgent(deviceInfo) {
    return `Mozilla/${deviceInfo.ew1.yV2}`
}

/**
 * 生成付费声音接口所需的 xm-sign
 *
 * cadd 与 sid 必须取自同一次上报，分开缓存会拼出服务端不认的组合，所以每次都重新上报
 * @returns {Promise<{xmSign: string, userAgent: string}>}
 */
async function getXmSign() {
    const deviceInfo = readDeviceInfo()
    deviceInfo.Zf5 = Date.now()
    const ua = userAgent(deviceInfo)
    const payload = aesEncrypt(zlib.deflateSync(Buffer.from(JSON.stringify(deviceInfo), 'utf8'), {level: 6}))
    const response = await iaxios.post(REPORT_URL + crypto.randomUUID(), payload, {
        headers: {
            'Content-Type': 'application/octet-stream',
            'User-Agent': ua
        }
    })
    if (response.status != 200) {
        throw new Error('设备指纹上报失败')
    }
    const result = JSON.parse(aesDecrypt(Buffer.from(String(response.data), 'base64')))
    if (!result.cadd || !result.sid) {
        throw new Error('设备指纹上报未返回 cadd/sid')
    }
    return {
        xmSign: `${result.cadd}&&${result.sid}`,
        userAgent: ua
    }
}

/**
 * 真校验一份设备指纹（网页面板上那个「真校验」按钮）。
 *
 * 本地看 `GJ2` / `fd2.av1` 只能说明「采过、被服务端注册过」，
 * 但那份快照是不是**现在**还能换来 cadd 才是关键 —— 所以照生产路径真报一次，
 * 把服务端原话（aid / cadd / err）拿回来，而不是只看字段在不在。
 *
 * 与 getXmSign 的区别：这里**不抛异常**（页面要的是结果，不是一个 500），
 * 而且额外回报用了哪个文件、字段数、UA，方便页面直接显示。
 */
async function reportDeviceInfo() {
    const file = deviceInfoPath()
    const result = {path: file, exists: false, fields: 0, ua: null, registered: false, aid: '', cadd: '', sid: '', err: null, http: null, error: null}
    let raw
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
    } catch (e) {
        result.error = `读不到设备指纹文件（${file}）：${e.message}`
        return result
    }
    result.exists = true
    result.fields = Object.keys(raw).length
    // 这两个字段是「当初上报被服务端认了」才会被回填的：形状对但它们是空的 = 没注册过
    result.registered = Boolean(raw.GJ2) && Boolean(raw.fd2 && raw.fd2.av1)
    const info = {...raw}
    for (const key of INTERNAL_KEYS) delete info[key]
    info.Zf5 = Date.now()
    const ua = userAgent(info)
    result.ua = ua
    const payload = aesEncrypt(zlib.deflateSync(Buffer.from(JSON.stringify(info), 'utf8'), {level: 6}))
    try {
        const response = await iaxios.post(REPORT_URL + crypto.randomUUID(), payload, {
            headers: {
                'Content-Type': 'application/octet-stream',
                'User-Agent': ua
            }
        })
        result.http = response.status
        const body = JSON.parse(aesDecrypt(Buffer.from(String(response.data), 'base64')))
        result.aid = body.aid || ''
        result.cadd = body.cadd || ''
        result.sid = body.sid || ''
        result.err = body.err
        // 服务端 err 永远是 "0"（它只收不认），认没认过全看 aid / cadd 给没给
        result.accepted = Boolean(result.aid && result.cadd)
    } catch (e) {
        result.error = e.message
    }
    return result
}

export {
    getXmSign,
    reportDeviceInfo
}
