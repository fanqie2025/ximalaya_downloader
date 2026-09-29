#!/usr/bin/env node
/**
 * 子进程日志行解析（common/childlog.js）。
 *
 * 这一层的每个判断都对应一次实打实的错账：
 *   - 把「当前信息>>>>>进度:100%(…)」（专辑已下完时每轮都打）当成下到了一集，
 *     当日集数会虚高（2026-09-27 实测：grep 数出 821，真实 807）；
 *   - 章节列表刷屏行（1589 集）漏过滤，页面日志会被冲掉；
 *   - 进度行里的数字认错，面板「本专辑进度」就一直是错的。
 */
import {parseChildLine, RE_PROGRESS, RE_TARGET, CHAPTER_LIST_MARK, SUCCESS_MARK}
    from '../common/childlog.js'

let pass = 0
let fail = 0
function eq(actual, expected, label) {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    if (a === e || actual === expected) {
        pass++
    } else {
        fail++
        console.log(`FAIL ${label}\n  actual   = ${a}\n  expected = ${e}`)
    }
}

// ---- 空行 / 刷屏行 ----
for (const [s, label] of [['', '空串'], ['   ', '纯空格'], ['\t', '制表符'], ['\r', '回车'],
    [null, 'null'], [undefined, 'undefined']]) {
    const r = parseChildLine(s)
    eq(r.blank, true, `${label} -> blank`)
    eq(r.progress, null, `${label} -> 无进度`)
    eq(r.chapterList, false, `${label} 不算刷屏行`)
}
eq(parseChildLine(`获取章节列中… 12/1589`).chapterList, true, '章节列表行 -> chapterList')
eq(parseChildLine(`获取章节列中… 12/1589`).progress, null, '章节列表行不解析进度')
eq(parseChildLine(`获取章节列中…`).blank, false, '章节列表行不是空行')

// ---- 真进度行（带「下载成功」）----
const ok = parseChildLine('(web)下载成功＞＞＞＞＞进度:12.34%(196/1589)---->/downloads/《书名》主播 作者/0001.mp3')
eq(ok.progress, {pct: 12.34, done: 196, total: 1589}, '成功进度行 -> 进度')
eq(ok.succeeded, true, '成功进度行 -> succeeded')
eq(ok.target, '/downloads/《书名》主播 作者/0001.mp3', '成功进度行 -> 目标路径')
eq(ok.blank, false, '成功进度行不是空行')
eq(ok.chapterList, false, '成功进度行不算刷屏')

// ---- 只能匹配「进度:」但没下到的行（不能算数）----
const idle = parseChildLine('当前信息>>>>>进度:100%(1589/1589)---->/downloads/《书名》/1589.mp3')
eq(idle.progress, {pct: 100, done: 1589, total: 1589}, '已下完的进度行照样解析')
eq(idle.succeeded, false, '没有「下载成功」就不算下到 -> succeeded false')
eq(idle.target, '/downloads/《书名》/1589.mp3', '已下完的进度行也有目标路径')

// ---- 边界：小数、没有目标路径、尾随空格、大集数 ----
eq(parseChildLine('下载成功＞＞＞进度:0.5%(1/2625)').progress, {pct: 0.5, done: 1, total: 2625},
    '没有 --> 路径也要能解析')
eq(parseChildLine('下载成功＞＞＞进度:0.5%(1/2625)').target, null, '没有路径时 target 为 null')
eq(parseChildLine('下载成功>>>>>>进度:99.99%(2625/2625)---->  /downloads/x/2625.m4a  ').target,
    '/downloads/x/2625.m4a', '目标路径去空白')
eq(parseChildLine('下载成功>>>>>>进度:33.3%(883/2625)---->/downloads/《上门龙婿》经致听书/0883.上门龙婿881 勒的喘不过气（新书-傲娇萌宝：父王，娘亲有药.m4a').target,
    '/downloads/《上门龙婿》经致听书/0883.上门龙婿881 勒的喘不过气（新书-傲娇萌宝：父王，娘亲有药.m4a',
    '中文+括号+活动后缀的文件名原样带出')

// ---- 普通日志行：什么都不认 ----
const plain = parseChildLine('开始处理专辑 33476331')
eq(plain.progress, null, '普通行没有进度')
eq(plain.succeeded, false, '普通行不算下到')
eq(plain.target, null, '普通行没有目标')
eq(plain.blank, false, '普通行不是空行')

// 数字不合法的「进度」不算进度
eq(parseChildLine('进度:abc%(1/2)---->x').progress, null, '百分比不是数字 -> 不认')
eq(parseChildLine('进度:12.34%(196)').progress, null, '缺少总数 -> 不认')
eq(parseChildLine('进度:12.34%196/1589').progress, null, '缺少括号 -> 不认')

// 刷屏行优先于进度：一行里两样都占时，按刷屏处理（原来的分支顺序）
const both = parseChildLine('获取章节列中… 进度:1%(1/2)---->x')
eq(both.chapterList, true, '两样都占 -> 刷屏行优先')
eq(both.progress, null, '两样都占 -> 不解析进度')

// 正则无 /g，连调两次结果一致（不能有 lastIndex 状态残留）
eq(parseChildLine(ok.target ? `下载成功＞＞＞进度:12.34%(196/1589)---->${ok.target}` : '').progress,
    parseChildLine(`下载成功＞＞＞进度:12.34%(196/1589)---->${ok.target}`).progress,
    '连续解析同一形状的行，结果一致')

// 常量本身也要对：别被后面的人改宽
eq(RE_PROGRESS.test('进度:1%(1/2)'), true, 'RE_PROGRESS 认得标准进度行')
eq(RE_PROGRESS.test('进度:1%(1/2)'), true, 'RE_PROGRESS 无 /g 状态残留（再测一次）')
eq(RE_TARGET.test('---->a/b.mp3'), true, 'RE_TARGET 认得路径')
eq(CHAPTER_LIST_MARK, '获取章节列', '刷屏行标记')
eq(SUCCESS_MARK, '下载成功', '成功标记')

console.log(fail === 0 ? `ALL PASS (${pass} 项断言)` : `FAILED (${pass} 通过 / ${fail} 失败)`)
process.exit(fail === 0 ? 0 : 1)
