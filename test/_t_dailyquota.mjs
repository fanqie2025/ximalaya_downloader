#!/usr/bin/env node
/**
 * 当日额度记账（common/dailyquota.js）。
 *
 * 为什么值得单测：这段决定「今天还能下多少集」，算少了顶平台当日的墙
 *（平台回 ret:1001「系统繁忙」，跟单轮上限撞的是同一个码，事后根本分不清），
 * 算多了就是白白少下几百集，而它本来就只是纯算术加一份 JSON 落盘。
 *
 * 覆盖：日期字符串、三种落盘格式（新 / 旧 v5 / 坏内容）、读写往返、写盘失败不抛、
 * 跨天归零、每账号剩余额度、当日总上限。
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
    localDateStr,
    parseDailyState,
    readDailyState,
    writeDailyState,
    rollDay,
    countOf,
    totalOf,
    remainingFor,
    totalCap,
} from '../common/dailyquota.js'

let pass = 0
let fail = 0
function eq(actual, expected, label) {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    if (a === e) {
        pass++
    } else {
        fail++
        console.log(`FAIL ${label}\n  actual   = ${a}\n  expected = ${e}`)
    }
}
function ok(cond, label) {
    if (cond) pass++
    else { fail++; console.log(`FAIL ${label}`) }
}

// ---- 日期字符串 ----
eq(localDateStr(new Date(2026, 8, 30)), '2026-09-30', 'localDateStr 正常')
eq(localDateStr(new Date(2026, 0, 5)), '2026-01-05', 'localDateStr 补零')
const today = localDateStr()

// ---- 解析：新格式 / 旧格式 / 坏内容 ----
eq(parseDailyState('{"date":"2026-09-30","accounts":{"default":39,"bob":366}}', today),
    {date: '2026-09-30', counts: {default: 39, bob: 366}}, '解析新格式')
eq(parseDailyState('{"date":"2026-09-29","count":405}', today),
    {date: '2026-09-29', counts: {default: 405}}, '旧 v5 单账号算 default 的')
eq(parseDailyState('{"date":"2026-09-30"}', today),
    {date: '2026-09-30', counts: {}}, '只认识 date，没有计数')
eq(parseDailyState('{"date":"d","accounts":{"a":"12","b":"x","c":null,"d":-3}}', today),
    {date: 'd', counts: {a: 12, d: -3}}, '计数非数字的丢掉（字符串数字留着）')
eq(parseDailyState('{"date":"d","accounts":[1,2]}', today), {date: 'd', counts: {}}, 'accounts 是数组 -> 当没有')
eq(parseDailyState('{oops', today), {date: today, counts: {}}, '坏 JSON -> 今天 0 集')
eq(parseDailyState('', today), {date: today, counts: {}}, '空串 -> 今天 0 集')
eq(parseDailyState(null, today), {date: today, counts: {}}, 'null -> 今天 0 集')
eq(parseDailyState('[]', today), {date: today, counts: {}}, '不是对象 -> 今天 0 集')

// ---- 读写往返 ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmd-quota-'))
const file = path.join(dir, 'sub', 'daily-state.json')
eq(readDailyState(file), {date: today, counts: {}}, '文件不存在 -> 今天 0 集')
const warns = []
ok(writeDailyState(file, '2026-09-30', {default: 39, bob: 366}, m => warns.push(m)) === true, '写盘成功返回 true')
eq(fs.existsSync(file), true, '写盘顺手建了目录')
eq(readDailyState(file), {date: '2026-09-30', counts: {default: 39, bob: 366}}, '读写往返一致')
eq(warns.length, 0, '成功时不 warn')

// 写盘失败：父目录是个文件 —— 只 warn、不抛，别因为记不住计数就打断整轮下载
const badFile = path.join(dir, 'not-a-dir')
fs.writeFileSync(badFile, 'x')
const warns2 = []
ok(writeDailyState(path.join(badFile, 'daily-state.json'), 'd', {}, m => warns2.push(m)) === false, '写盘失败返回 false')
eq(warns2.length, 1, '失败时 warn 一次')
ok(String(warns2[0]).includes('当日计数写盘失败'), 'warn 文案可辨认')

// ---- 跨天归零 ----
const counts = {default: 39, bob: 366}
const same = rollDay(today, counts, today)
eq(same, {date: today, counts, rolled: false}, '同一天不归零')
const rolled = rollDay('2026-09-29', counts, '2026-09-30')
eq(rolled, {date: '2026-09-30', counts: {}, rolled: true}, '跨天归零')
eq(counts, {default: 39, bob: 366}, '归零不改原对象（调用方还要拿来打日志）')

// ---- 每账号计数 / 剩余额度 ----
eq(countOf({default: 39, bob: '366'}, 'bob'), 366, '字符串计数也认')
eq(countOf({default: 39}, 'bob'), 0, '没有这个账号 -> 0')
eq(countOf(null, 'bob'), 0, '空计数 -> 0')
eq(totalOf({default: 39, bob: 366}), 405, '合计')
eq(totalOf({}), 0, '空合计')
eq(remainingFor({default: 39}, 'default', 950), 911, '剩余额度')
eq(remainingFor({default: 950}, 'default', 950), 0, '刚好下满 -> 0')
eq(remainingFor({default: 1200}, 'default', 950), 0, '超了不返回负数')
eq(remainingFor({}, 'default', 0), Infinity, '没配上限 -> 无限')
eq(remainingFor({}, 'default', -1), Infinity, '上限为负也当不限')

// ---- 当日总上限 ----
eq(totalCap(950, 2), 1900, '950 × 2 个账号')
eq(totalCap(950, 0), 0, '没有账号 -> 0')
eq(totalCap(0, 3), 0, '不限量 -> 0')
eq(totalCap(-5, 2), 0, '负数当不限量')

fs.rmSync(dir, {recursive: true, force: true})
console.log(fail === 0 ? `ALL PASS (${pass} 项断言)` : `FAILED (${pass} 通过 / ${fail} 失败)`)
process.exit(fail === 0 ? 0 : 1)
