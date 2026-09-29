/**
 * 单集忽略（workstream ③）的本地自测：不碰线上库，DB 与下载目录都指向临时目录。
 * 跑法：node _t_skip.mjs
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import util from 'util'

// nedb 是 2016 年的库，用 util.isDate / util.isArray 判类型，而这两个 API 在 Node 23+ 已删
// （容器里是 node:22-slim，还在）。只为本地自测能跑，补垫片 —— 线上代码不动。
for (const [name, impl] of [['isDate', d => d instanceof Date], ['isArray', Array.isArray],
    ['isRegExp', r => r instanceof RegExp], ['isError', e => e instanceof Error]]) {
    if (typeof util[name] !== 'function') util[name] = impl
}

// 临时目录避开 os.tmpdir()：Windows 8.3 短名（ADMINI~1）里的波浪号会被 config 朴素的
// `replace('~', homedir)` 拼坏。
const tmp = fs.mkdtempSync(path.join(process.cwd(), '_t_tmp_'))
const dbDir = path.join(tmp, 'db')
const outRoot = path.join(tmp, 'out')
process.env.XMD_DB_DIR = dbDir
process.env.XMD_ARCHIVES = outRoot
fs.mkdirSync(path.join(dbDir, 'db', 'file'), {recursive: true})
fs.mkdirSync(outRoot, {recursive: true})

const {trackDB} = await import('../db/trackdb.js')
const {auditAlbum, backfillPaths, pendingQuery, syncIgnoreMarks} = await import('../common/dbselfheal.js')
const {identifyLibrary, invalidateLibraryCache, parseNumSpec, readIgnore, scanLibrary, writeIgnore, ignoreMatches, writeSidecar}
    = await import('../common/library.js')

let pass = 0
function eq(actual, expected, what) {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    if (a !== e) {
        console.log(`FAIL ${what}\n  actual   = ${a}\n  expected = ${e}`)
        process.exitCode = 1
        return
    }
    pass++
    console.log(`ok   ${what} = ${a}`)
}

const albumId = '9990002'
const album = {albumId: albumId, albumTitle: '测试书', anchorName: '测试主播', trackCount: 8}
const dir = path.join(outRoot, '《测试书》测试主播')
fs.mkdirSync(dir, {recursive: true})
// 磁盘上真的有 1、2、5 三集（5 是「已经下下来了、但用户不想要」的那种）
for (const f of ['0001.第1集.m4a', '0002.第2集.m4a', '0005.第5集.m4a', 'cover.jpg']) {
    fs.writeFileSync(path.join(dir, f), 'x')
}
writeSidecar(dir, album)

// 进度库：8 集都还没记路径；第 8 集的标题里带「活动」，用来试标题正则
for (const num of [1, 2, 3, 4, 5, 6, 7, 8]) {
    await trackDB.insert({
        trackId: `t${num}`,
        title: num === 8 ? '第8集 爆更活动又来了' : `第${num}集`,
        albumId: albumId, num: num, path: null,
    })
}

// ① 集号解析
eq(parseNumSpec('651,656-660'), [651, 656, 657, 658, 659, 660], 'parseNumSpec 逗号+区间')
eq(parseNumSpec('12，15～17'), [12, 15, 16, 17], 'parseNumSpec 中文逗号+波浪号')

// ② 规则读写：集号 + 标题正则 + 理由
eq(writeIgnore(dir, {nums: [5, 6, 7], patterns: ['活动'], reason: '活动后缀不要'}), true, 'writeIgnore 写入')
const spec = readIgnore(dir)
eq({nums: spec.nums, patterns: spec.patterns, reason: spec.reason}, {nums: [5, 6, 7], patterns: ['活动'], reason: '活动后缀不要'}, 'readIgnore 读回')
eq(ignoreMatches(spec, 6, '随便什么标题'), true, '集号命中')
eq(ignoreMatches(spec, 8, '第8集 爆更活动又来了'), true, '标题正则命中')
eq(ignoreMatches(spec, 3, '第3集'), false, '没命中的不忽略')
eq(ignoreMatches({nums: [], patterns: ['[']}, 9, '标题里有 [ 括号'), true, '坏正则退化成子串匹配（不让写错的规则卡住整本）')
eq(ignoreMatches(null, 1, '第1集'), false, '没有规则时谁都不忽略')

// ③ 落到进度库：命中 5/6/7/8；磁盘上没有的只有 6/7/8（5 还在盘上，不该让面板重复扣）
const sync = await syncIgnoreMarks(albumId, dir, album, spec)
eq({matched: sync.matched, marked: sync.marked, cleared: sync.cleared, resolved: sync.resolved},
    {matched: [5, 6, 7, 8], marked: 4, cleared: 0, resolved: [6, 7, 8]}, 'syncIgnoreMarks 打标结果')

// ④ 待下载集合：被忽略的集不在里面（删了也不会自己回来）
const pendingRows = await trackDB.find(pendingQuery(albumId))
eq(pendingRows.map(r => r.num).sort((a, b) => a - b), [1, 2, 3, 4], 'pendingQuery 排除了被忽略的 5/6/7/8')

// ⑤ 补路径不碰被忽略的集
const bf = await backfillPaths(albumId, dir, album)
eq({onDisk: bf.onDisk, marked: bf.marked, stillMissing: bf.stillMissing}, {onDisk: 3, marked: 2, stillMissing: 2}, 'backfillPaths 只补 1/2')

// ⑥ 对账：忽略的集不算缺
const audit = await auditAlbum(albumId, dir, album)
eq({
    rows: audit.rows, distinctNums: audit.distinctNums, withPath: audit.withPath,
    skipped: audit.skipped, missingOnDisk: audit.missingOnDisk, missingOnDiskNums: audit.missingOnDiskNums,
}, {rows: 8, distinctNums: 8, withPath: 2, skipped: 4, missingOnDisk: 2, missingOnDiskNums: [3, 4]}, 'auditAlbum 不含被忽略的集')

// ⑦ 面板显示：诊断库把 resolved 写回后，「还差」要扣掉忽略的集
writeIgnore(dir, {nums: [5, 6, 7], patterns: ['活动'], reason: '活动后缀不要', resolved: sync.resolved})
invalidateLibraryCache()
const rows = identifyLibrary(scanLibrary(outRoot), [album], {})
const row = rows.find(r => r.name === '《测试书》测试主播')
eq({audio: row.audio, total: row.total, skipped: row.skipped, remaining: row.remaining, complete: row.complete},
    {audio: 3, total: 8, skipped: 3, remaining: 2, complete: false}, '面板：8-3(盘上)-3(忽略)=还差 2 集')

// ⑧ 规则刚写完、下载器还没解析时不许假装下完了
writeIgnore(dir, {nums: [6, 7], patterns: [], reason: ''})
invalidateLibraryCache()
const row2 = identifyLibrary(scanLibrary(outRoot), [album], {}).find(r => r.name === '《测试书》测试主播')
eq({skipped: row2.skipped, ignoredPending: row2.ignoredPending, remaining: row2.remaining},
    {skipped: 0, ignoredPending: true, remaining: 5}, '规则未解析时照实报「还差 5 集」')

// ⑨ 取消忽略：标记要撤掉，缺的集重新变成待办
eq(writeIgnore(dir, {nums: [], patterns: []}), true, 'writeIgnore 清空规则')
eq(readIgnore(dir), null, '清空后规则文件被删掉')
const cleared = await syncIgnoreMarks(albumId, dir, album, readIgnore(dir))
eq({marked: cleared.marked, cleared: cleared.cleared}, {marked: 0, cleared: 4}, 'syncIgnoreMarks 撤销 4 集标记')
const audit2 = await auditAlbum(albumId, dir, album)
eq({skipped: audit2.skipped, missingOnDisk: audit2.missingOnDisk, missingOnDiskNums: audit2.missingOnDiskNums},
    {skipped: 0, missingOnDisk: 5, missingOnDiskNums: [3, 4, 6, 7, 8]}, '取消后那几集又算缺了')

console.log(`\n${process.exitCode ? 'FAILED' : `ALL PASS (${pass} 项断言)`}`)
fs.rmSync(tmp, {recursive: true, force: true})
