import dns from 'dns'
import net from 'net'
import http from 'http'
import https from 'https'
import {config} from './config.js'
import {log} from './log4jscf.js'

/**
 * DNS 兜底解析。
 *
 * 为什么需要：数盟（设备指纹风控）的上报域名 hdaa.shuzilm.cn 名字里带 "shuzi"、
 * 又挂在广告位的 CNAME 上，很容易被 AdGuardHome / mosdns 一类的拦截规则当成
 * tracker 打成 0.0.0.0 或 ::。本机与飞牛容器都走同一个上游 DNS，于是两边同时挂，
 * 报错样子是 `getaddrinfo ENOENT hdaa.shuzilm.cn`，看着像网络不通，其实是解析被改。
 *
 * 策略：先按系统解析（尊重 hosts、内网域名、公司 DNS 等），只有当系统返回空、
 * 报错、或返回 0.0.0.0 / :: 这类黑洞地址时，才用公共 DNS 重解析一次。
 * 纯增量，不改变任何本来能正常解析的域名。
 */

const PROXY_VARS = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']

/**
 * 清掉进程里从 shell 继承来的代理设置。
 *
 * 这个坑踩过两次了：本机 shell（含 WorkBuddy 自带的 127.0.0.1 内部代理）和早期容器
 * 环境里都带着 http_proxy，而这类代理只认 CONNECT，axios 走它会退化成「明文 HTTP
 * 发到 443」，服务端回一句 `The plain http request was sent to https port` 加 400 ——
 * 看起来像接口报错或风控，实际是代理在中间搅。
 *
 * 喜马拉雅是境内站，直连又快又稳，所以默认清掉。真要保留代理，设 XMD_KEEP_PROXY=1。
 */
export function stripProxyEnv() {
    if (String(process.env.XMD_KEEP_PROXY || '') === '1') return []
    const stripped = []
    for (const key of PROXY_VARS) {
        if (process.env[key] != null) {
            delete process.env[key]
            stripped.push(key)
        }
    }
    return stripped
}

const BLACKHOLE = new Set(['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '127.0.0.1', '::1'])
const DEFAULT_SERVERS = ['223.5.5.5', '119.29.29.29', '114.114.114.114']
const DEFAULT_TTL_MS = 5 * 60 * 1000

const warned = new Set()
const cache = new Map()

function normalizeServers(raw) {
    if (raw == null || raw === '') return DEFAULT_SERVERS.slice()
    const list = Array.isArray(raw) ? raw : String(raw).split(/[,;\s]+/)
    const out = list.map(s => String(s).trim()).filter(s => net.isIP(s))
    return out.length ? out : DEFAULT_SERVERS.slice()
}

function dnsCfg() {
    const c = (config && config.dns) || {}
    const ttl = Number(c.ttlSeconds)
    return {
        enabled: c.enabled !== false,
        servers: normalizeServers(c.servers),
        pin: c.pin && typeof c.pin === 'object' ? c.pin : {},
        ttlMs: Number.isFinite(ttl) && ttl > 0 ? ttl * 1000 : DEFAULT_TTL_MS
    }
}

function resolveVia(server, hostname) {
    return new Promise((resolve, reject) => {
        const resolver = new dns.Resolver()
        resolver.setServers([server])
        resolver.resolve4(hostname, (err, addresses) => {
            if (err) return reject(err)
            resolve(Array.isArray(addresses) ? addresses : [])
        })
    })
}

async function resolveFallback(hostname, cfg) {
    const hit = cache.get(hostname)
    if (hit && Date.now() - hit.at < cfg.ttlMs) return hit.ips
    let lastError = null
    for (const server of cfg.servers) {
        try {
            const ips = (await resolveVia(server, hostname)).filter(ip => !BLACKHOLE.has(ip))
            if (ips.length) {
                cache.set(hostname, {ips, at: Date.now()})
                return ips
            }
        } catch (e) {
            lastError = e
        }
    }
    if (lastError) log.debug(`公共 DNS 解析 ${hostname} 失败：${lastError.code || lastError.message}`)
    return []
}

function notFound(hostname, cause) {
    const error = new Error(`无法解析 ${hostname}${cause ? `（${cause}）` : ''}`)
    error.code = 'ENOTFOUND'
    error.hostname = hostname
    return error
}

/**
 * 兼容 http/https 的 lookup 签名。
 *
 * 注意 options.all：Node 的 net 模块内部调 lookup 时传的是 { all: true }，
 * 此时回调必须给数组，给单个字符串会直接抛 ERR_INVALID_IP_ADDRESS —— 这个坑
 * 不看 Node 源码基本想不到，第一版就是这么踩的。
 */
export function fallbackLookup(hostname, options, callback) {
    if (typeof options === 'function') {
        callback = options
        options = {}
    }
    const wantAll = !!(options && options.all)

    // 传进来的已经是 IP 字面量，直接用，别去解析也别过滤
    if (net.isIP(hostname)) {
        return wantAll
            ? callback(null, [{address: hostname, family: net.isIP(hostname)}])
            : callback(null, hostname, net.isIP(hostname))
    }

    const cfg = dnsCfg()
    const pinned = cfg.pin[hostname]
    if (pinned != null && String(pinned) !== '') {
        const list = (Array.isArray(pinned) ? pinned : [pinned])
            .map(ip => String(ip).trim()).filter(ip => net.isIP(ip))
            .map(ip => ({address: ip, family: net.isIP(ip)}))
        if (list.length) {
            log.debug(`DNS 固定解析 ${hostname} -> ${list.map(x => x.address).join(',')}`)
            return wantAll ? callback(null, list) : callback(null, list[0].address, list[0].family)
        }
    }

    dns.lookup(hostname, options, (err, address, family) => {
        const list = Array.isArray(address) ? address : (address ? [{address, family}] : [])
        const usable = list.filter(item => item && item.address && !BLACKHOLE.has(String(item.address)))
        if (!err && usable.length) {
            return wantAll
                ? callback(null, usable)
                : callback(null, usable[0].address, usable[0].family)
        }
        if (!cfg.enabled) {
            return callback(err || notFound(hostname, 'DNS 兜底已关闭'))
        }
        const cause = err ? err.code || err.message : `系统返回 ${list.map(x => x.address).join(',') || '空'}`
        resolveFallback(hostname, cfg).then(ips => {
            if (!ips.length) return callback(err || notFound(hostname, cause))
            if (!warned.has(hostname)) {
                warned.add(hostname)
                log.warn(`本机 DNS 未给出 ${hostname} 的可用地址（${cause}），已自动改用 ${cfg.servers.join('/')} 解析`)
            }
            const resolved = ips.map(ip => ({address: ip, family: 4}))
            return wantAll
                ? callback(null, resolved)
                : callback(null, resolved[0].address, 4)
        }).catch(e => callback(e))
    })
}

let _httpAgent = null
let _httpsAgent = null

export function httpAgent() {
    if (!_httpAgent) _httpAgent = new http.Agent({keepAlive: true, lookup: fallbackLookup})
    return _httpAgent
}

export function httpsAgent() {
    if (!_httpsAgent) _httpsAgent = new https.Agent({keepAlive: true, lookup: fallbackLookup})
    return _httpsAgent
}
