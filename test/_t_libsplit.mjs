#!/usr/bin/env node
/**
 * panel/libsplit.js 的单测。
 *
 * 为什么需要：「库中已有书籍」和「订阅列表」原来会把同一本书各显示一遍（上门龙婿
 * 在两处都有卡片）。去重规则是「订阅列表里已经有的，库里不再重复列」——这条规则要是
 * 写错，要么同一本书还是出现两次，要么把该显示的书吞掉、连「继续下载」按钮都找不着。
 * 分组放在纯函数里就是为了能在 node 里这样直接测（不碰 DOM）。
 *
 * 这里还盯着一个容易踩的点：返回的 i 必须是这一行在原始 rows 里的下标 —— 面板的
 * 继续下载/绑定专辑/单集忽略按钮都拿这个下标回调服务端，分组不能打乱它。
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import {fileURLToPath} from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, '..', 'panel', 'libsplit.js'), 'utf-8')

const ctx = {}
vm.runInNewContext(src, ctx, {filename: 'panel/libsplit.js'})
const splitLibRows = ctx.splitLibRows

let pass = 0
let fail = 0
function ok(cond, label, extra) {
    if (cond) {
        pass++
    } else {
        fail++
        console.log(`FAIL ${label}${extra ? '\n  ' + extra : ''}`)
    }
}

ok(typeof splitLibRows === 'function', 'libsplit.js 在浏览器/脚本环境里挂出 splitLibRows')

// 一行道具：r 只带分组关心的字段
const row = (name, extra) => Object.assign({name: name, albumId: null, complete: false, ignored: false}, extra || {})
const names = list => list.map(it => it.r.name).join(',')
const idxs = list => list.map(it => it.i).join(',')

// ---- 1. 订阅中的书不在这里重复出现 --------------------------------
{
    const rows = [
        row('订阅中', {albumId: 33476331, complete: false}),
        row('没订阅', {albumId: null, complete: false}),
        row('下完了', {albumId: null, complete: true}),
    ]
    const g = splitLibRows(rows, {33476331: true})
    ok(names(g.subscribed) === '订阅中', '订阅中的一本被挑进 subscribed', names(g.subscribed))
    ok(names(g.pending) === '没订阅', '未完成里只剩没订阅的', names(g.pending))
    ok(names(g.done) === '下完了', '已完成的照旧', names(g.done))
    ok(idxs(g.subscribed) === '0' && idxs(g.pending) === '1' && idxs(g.done) === '2',
        '返回的下标是原始 rows 的下标（按钮回调用）', `${idxs(g.subscribed)} / ${idxs(g.pending)} / ${idxs(g.done)}`)
}

// ---- 2. 订阅里的书即使下完了也归订阅列表管（不在这里重复一张卡）----
{
    const rows = [row('订阅且下完', {albumId: '86991161', complete: true})]
    const g = splitLibRows(rows, {86991161: true})
    ok(names(g.subscribed) === '订阅且下完' && g.done.length === 0,
        '订阅的书下完了也不在「已完成」里重复出现', JSON.stringify(g))
}

// ---- 3. 数字 id 与字符串 key 要能对上 -----------------------------
{
    const rows = [row('数字 id', {albumId: 76941016, complete: false})]
    const g = splitLibRows(rows, {'76941016': true})
    ok(g.subscribed.length === 1, 'albumId 是数字、subs 的 key 是字符串也能匹配')
    const g2 = splitLibRows([row('字符串 id', {albumId: '76941016'})], {76941016: true})
    ok(g2.subscribed.length === 1, '反过来（字符串 id / 数字 key）也能匹配')
}

// ---- 4. 标了「非本站·忽略」的留在库里，不按订阅吞掉 ---------------
{
    const rows = [row('非本站', {albumId: 33476331, ignored: true, complete: null})]
    const g = splitLibRows(rows, {33476331: true})
    ok(g.subscribed.length === 0 && names(g.done) === '非本站',
        'ignored 的行不被订阅去重吞掉（用户在这边的决定优先）', JSON.stringify(g))
}

// ---- 5. 认不出专辑的行永远不参与去重 ------------------------------
{
    const rows = [row('认不出', {albumId: null, complete: null})]
    const g = splitLibRows(rows, {33476331: true, null: true})
    ok(g.pending.length === 1 && g.pending[0].r.complete === null,
        'albumId 为 null 的走「未完成」等人绑定，不会被 subs 里的 null 键误伤')
    const g2 = splitLibRows([row('未绑定', {albumId: undefined})], {undefined: true})
    ok(g2.pending.length === 1, 'albumId 是 undefined 同理')
}

// ---- 6. complete === null 的进「未完成」，不做「已下完」------------
{
    const rows = [row('未识别', {complete: null}), row('半截', {complete: false}), row('好了', {complete: true})]
    const g = splitLibRows(rows, {})
    ok(names(g.pending) === '未识别,半截', '未识别与半截都进未完成', names(g.pending))
    ok(names(g.done) === '好了', '只有 complete===true 进已完成', names(g.done))
}

// ---- 7. 边界：没有行、没有订阅表、参数缺省 ------------------------
{
    const g = splitLibRows([], {})
    ok(g.pending.length === 0 && g.done.length === 0 && g.subscribed.length === 0, '空 rows 返回三组空数组')
    const g2 = splitLibRows([row('没订阅表', {complete: true})])
    ok(g2.done.length === 1, 'subs 缺省时按「都没订阅」处理')
    const g3 = splitLibRows(null, null)
    ok(g3.pending.length === 0 && g3.done.length === 0, 'rows 为 null 不炸')
}

// ---- 8. 分组不打乱顺序、不改原数组 --------------------------------
{
    const rows = [
        row('甲', {complete: false}),
        row('乙', {complete: true}),
        row('丙', {complete: false}),
    ]
    const before = rows.map(r => r.name).join(',')
    const g = splitLibRows(rows, {})
    ok(names(g.pending) === '甲,丙' && names(g.done) === '乙', '各自保持原顺序', `${names(g.pending)} / ${names(g.done)}`)
    ok(rows.map(r => r.name).join(',') === before && rows.length === 3, '不改动传进来的 rows')
}

console.log(fail === 0 ? `ALL PASS (${pass} 项断言)` : `FAILED (${pass} 通过 / ${fail} 失败)`)
process.exit(fail === 0 ? 0 : 1)
