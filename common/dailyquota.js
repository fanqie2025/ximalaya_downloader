/**
 * 当日额度记账 —— 从 scheduler.js 里抽出来的（2026-09-30，④ 代码卫生）。
 *
 * 为什么要单独一份：这段逻辑是「今天每个账号各下了多少集」的唯一真相，
 * 一旦算错，要么顶到平台的当日墙上（平台回的是 ret:1001「系统繁忙」，
 * 跟单轮上限撞的是同一个码，蒙不出来），要么白白少下几百集。
 * 它又是纯算术 + 一份 JSON 落盘，跟子进程调度没有关系，所以拆出来单测。
 *
 * 落盘格式（新）：{"date":"2026-09-30","accounts":{"default":39,"bob":366}}
 * 兼容旧格式（v9.1 前的单账号）：{"date":"2026-09-30","count":405}
 *   —— 那份计数就是 default 账号的（当时只有一个账号）。
 */
import fs from 'fs'
import path from 'path'

/** 本地日期 YYYY-MM-DD。按机器本地时区算，不用 UTC：平台的「今天」是人所在的那一天。 */
export function localDateStr(d = new Date()) {
    const p = n => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 解析当日计数文件的内容（纯函数，便于单测）。
 * 文件缺失、内容坏了、格式不认识 —— 一律从「今天 0 集」开始，绝不抛。
 */
export function parseDailyState(raw, today = localDateStr()) {
    let j
    try {
        j = JSON.parse(String(raw == null ? '' : raw))
    } catch (e) {
        return {date: today, counts: {}}
    }
    if (!j || typeof j !== 'object' || typeof j.date !== 'string') return {date: today, counts: {}}
    if (j.accounts && typeof j.accounts === 'object' && !Array.isArray(j.accounts)) {
        const counts = {}
        for (const [k, v] of Object.entries(j.accounts)) {
            // 注意别用 Number(v) 直接判：Number(null) 是 0、Number('') 也是 0，
            // 会把「没记过」的账号写成 0 集。只认真正的数字/数字字符串。
            if (v === null || v === undefined || v === '') continue
            if (Number.isFinite(Number(v))) counts[k] = Number(v)
        }
        return {date: j.date, counts}
    }
    // 旧格式（v5 单账号）：{date, count} —— 那份计数就是 default 账号的
    if (Number.isFinite(Number(j.count))) {
        return {date: j.date, counts: {default: Number(j.count)}}
    }
    return {date: j.date, counts: {}}
}

/** 读当日计数。第一次跑 / 文件没生成 / 内容坏了：都是「今天 0 集」。 */
export function readDailyState(file) {
    try {
        return parseDailyState(fs.readFileSync(file, 'utf-8'))
    } catch (e) {
        return {date: localDateStr(), counts: {}}
    }
}

/**
 * 写当日计数。失败只 warn、不抛 —— 记不住计数只影响「重建容器后还记不记得」，
 * 不该因此打断整轮下载。
 */
export function writeDailyState(file, date, counts, warn = () => {}) {
    try {
        fs.mkdirSync(path.dirname(file), {recursive: true})
        fs.writeFileSync(file, JSON.stringify({date, accounts: counts}) + '\n')
        return true
    } catch (e) {
        warn(`当日计数写盘失败（不影响本轮）：${e.message}`)
        return false
    }
}

/**
 * 跨自然日归零（纯函数）。返回 {date, counts, rolled}：
 * rolled=true 表示确实翻了天、计数被清空 —— 调用方据此决定要不要打日志。
 */
export function rollDay(date, counts, today = localDateStr()) {
    if (date === today) return {date, counts, rolled: false}
    return {date: today, counts: {}, rolled: true}
}

/** 某个账号今天已下多少集。 */
export function countOf(counts, account) {
    return Number(counts && counts[account]) || 0
}

/** 全部账号合计已下多少集。 */
export function totalOf(counts) {
    return Object.values(counts || {}).reduce((a, b) => a + (Number(b) || 0), 0)
}

/**
 * 某个账号今天还剩多少（dailyCap <= 0 表示不限量 → Infinity）。
 * 平台那道当日墙是**按账号**算的，所以这里只看这个账号自己的计数。
 */
export function remainingFor(counts, account, dailyCap) {
    if (!(dailyCap > 0)) return Infinity
    return Math.max(0, dailyCap - countOf(counts, account))
}

/** 当日总上限 = 每账号上限 × 账号数（0/负数 = 不限量 → 0，调用方按 0 处理）。 */
export function totalCap(dailyCap, accountCount) {
    if (!(dailyCap > 0)) return 0
    return dailyCap * Math.max(0, Number(accountCount) || 0)
}
