/**
 * 账号名单 + 健康状态的**共享存储**（调度器和网页读同一份）。
 *
 * 为什么要有这一层：
 *   1) 账号从「compose 里的 env 字符串」升级成「网页上能加能删的列表」——
 *      环境变量运行时改不了，而用户要的是「万一账号失效能第一时间增加」。
 *      env 降级成**初始默认值**：config/accounts.txt 不存在时用它播种。
 *   2) 失效状态必须落盘。探测跑在子进程，网页和调度器跑在父进程，
 *      三边要看同一份 —— 所以放 logs/account-status.json，而不是内存变量。
 *
 * 账号目录规则（和 scheduler.js 必须一致，别各写一套）：
 *   default → 根 xmd 目录（2026-09-29 之前唯一那份凭据在那儿，不用搬文件）
 *   其它    → <xmd>/accounts/<名字>
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {config} from './config.js'
import {projectRoot} from '../settings.js'

/** 账号名会拼进路径，所以必须卡死：字母数字开头，只允许字母数字下划线中划线，最长 32 */
const RE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

/** 容器里以 root 跑，写出来的文件属主要拉回宿主机用户，否则以后不好直接编辑 */
const OWNER = {uid: 1000, gid: 1001}

function chownBack(file) {
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) return
    try {
        fs.chownSync(file, OWNER.uid, OWNER.gid)
    } catch (e) {
        // 宿主机上没这个 uid / 没权限就算了，不影响功能
    }
}

export function accountsFile() {
    const sched = config.schedule || {}
    return sched.accountsFile
        ? path.resolve(projectRoot, sched.accountsFile)
        : path.join(projectRoot, 'config', 'accounts.txt')
}

export function statusFile() {
    return path.join(projectRoot, 'logs', 'account-status.json')
}

export function xmdDir() {
    return String(config.xmd || '~/.xmd').replace('~', os.homedir())
}

export function dbDir() {
    return String(config.dbDir || config.xmd || '~/.xmd').replace('~', os.homedir())
}

/** 账号目录：default 是根 xmd 目录（老部署），其它落在 accounts/ 下 */
export function accountDirFor(name) {
    const root = xmdDir()
    return name === 'default' ? root : path.join(root, 'accounts', name)
}

/** 找一份可用的登录凭据（cookie 必须是非空 JSON 数组，半截文件不算） */
export function findCredential(dir) {
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

export function hasCredential(name) {
    return findCredential(accountDirFor(name)) != null
}

/** 把名字洗干净；不合法返回 null（调用方负责 400） */
export function normalizeName(raw) {
    const s = String(raw == null ? '' : raw).trim()
    return RE_NAME.test(s) ? s : null
}

/** env 里的初始名单（和 scheduler.parseAccounts 同样的规则，保持行为一致） */
export function defaultAccountNames() {
    const raw = (config.schedule || {}).accounts
    const list = String(raw == null ? '' : raw)
        .split(',')
        .map(s => s.trim())
        .filter(s => s !== '')
    return list.length > 0 ? [...new Set(list)] : ['default']
}

/**
 * 有效账号名单：config/accounts.txt 优先，文件不存在就用 env 默认值。
 * 只读，不落盘 —— 网页在「添加账号」时才创建这个文件。
 */
export function readAccounts() {
    const file = accountsFile()
    try {
        if (fs.existsSync(file)) {
            const list = []
            for (const rawLine of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
                const line = rawLine.split('#')[0].trim()
                if (line === '') continue
                const name = normalizeName(line)
                if (name != null && !list.includes(name)) list.push(name)
            }
            if (list.length > 0) return list
        }
    } catch (e) {
        // 读坏了就退回 env 默认，总比整个调度器起不来强
    }
    return defaultAccountNames()
}

export function writeAccounts(list) {
    const names = [...new Set(list.map(normalizeName).filter(n => n != null))]
    const file = accountsFile()
    fs.mkdirSync(path.dirname(file), {recursive: true})
    const body = '# 账号名单：一行一个。写在这里的名字，用 <xmd>/accounts/<名字>/ 里的凭据。\n'
        + '# default 是保留名，指根 xmd 目录（老部署那份凭据就在那儿）。\n'
        + '# 这个文件由网页面板的「账号」卡片维护，手改也行（改完不用重启容器）。\n'
        + names.join('\n') + '\n'
    fs.writeFileSync(file, body, 'utf-8')
    chownBack(file)
    return names
}

export function addAccount(name) {
    const n = normalizeName(name)
    if (n == null) return {ok: false, msg: '账号名只能是字母、数字、下划线、中划线，且以字母或数字开头（最长 32 位）'}
    const list = readAccounts()
    if (list.includes(n)) return {ok: false, msg: `账号 ${n} 已经在名单里了`}
    list.push(n)
    writeAccounts(list)
    // 目录先建出来，页面上的路径提示就是真的（凭据还得扫码才有）
    const dir = accountDirFor(n)
    fs.mkdirSync(dir, {recursive: true})
    chownBack(dir)
    return {ok: true, name: n, dir}
}

export function removeAccount(name) {
    const n = normalizeName(name)
    const list = readAccounts()
    if (n == null || !list.includes(n)) return {ok: false, msg: '名单里没有这个账号'}
    writeAccounts(list.filter(x => x !== n))
    // 凭据留在磁盘上（跟「移除订阅」一个态度：不删用户数据），只是不再参与轮转
    return {ok: true, name: n}
}

/** 全部账号的状态记录：{名字: {...}} */
export function readStatus() {
    try {
        const obj = JSON.parse(fs.readFileSync(statusFile(), 'utf-8'))
        return obj && typeof obj === 'object' ? obj : {}
    } catch (e) {
        return {}
    }
}

export function writeStatus(map) {
    const file = statusFile()
    fs.mkdirSync(path.dirname(file), {recursive: true})
    // 先写临时文件再改名：调度器可能恰好在读，别让它读到半截 JSON
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf-8')
    fs.renameSync(tmp, file)
    chownBack(file)
}

export function updateStatus(name, patch) {
    const all = readStatus()
    all[name] = {...(all[name] || {}), ...patch, name}
    writeStatus(all)
    return all[name]
}

/**
 * 这个账号是不是「不该再上场」。
 *   disabled     —— 用户在网页上手动禁用（探测成功也不会自动解开，得用户点启用）
 *   autoDisabled —— 探测判定凭据已死，自动禁掉；下次探测正常会自动解开
 */
export function isDisabled(rec) {
    return Boolean(rec && (rec.disabled === true || rec.autoDisabled === true))
}

export function disabledReason(rec) {
    if (!rec) return ''
    if (rec.disabled === true) return rec.reason || '手动禁用'
    if (rec.autoDisabled === true) return rec.reason || '探测未通过'
    return ''
}

/** 状态徽章用的一句话摘要 */
export function summarize(rec) {
    if (!rec) return '未探测'
    if (rec.disabled === true) return '已禁用（手动）'
    if (rec.autoDisabled === true) return '已禁用（' + (rec.reason || '失效') + '）'
    if (rec.alive !== true) return '失效（' + (rec.reason || '探测未通过') + '）'
    return '正常'
}
