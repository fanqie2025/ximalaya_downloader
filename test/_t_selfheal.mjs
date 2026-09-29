/**
 * 进度库自愈 + 目录复用 的本地自测（不碰线上库：DB 与下载目录都指向临时目录）。
 * 跑法：node _t_selfheal.mjs
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import util from 'util'

// nedb 是 2016 年的库：用 util.isDate / util.isArray 判断类型，
// 而这两个 API 在 Node 23+ 已经删掉了（容器里跑的是 node:22-slim，还在）。
// 只是为了让本地自测能跑起来，补几个垫片 —— 线上代码不动。
for (const [name, impl] of [['isDate', d => d instanceof Date], ['isArray', Array.isArray],
    ['isRegExp', r => r instanceof RegExp], ['isError', e => e instanceof Error]]) {
    if (typeof util[name] !== 'function') util[name] = impl
}

// 临时目录必须避开 os.tmpdir()：Windows 的 8.3 短名（`ADMINI~1`）里带波浪号，
// 而 config 的 `~` 展开是老式的 `replace('~', homedir)`，会把路径拼成一团乱码。
const tmp = fs.mkdtempSync(path.join(process.cwd(), '_t_tmp_'))
const dbDir = path.join(tmp, 'db')
const outRoot = path.join(tmp, 'out')
process.env.XMD_DB_DIR = dbDir
process.env.XMD_ARCHIVES = outRoot
fs.mkdirSync(path.join(dbDir, 'db', 'file'), {recursive: true})
fs.mkdirSync(outRoot, {recursive: true})

const {trackDB} = await import('../db/trackdb.js')
const {backfillPaths, dedupeAlbum, auditAlbum, diskTrackIndex} = await import('../common/dbselfheal.js')
const {albumDirName, buildDiskIndex} = await import('../common/naming.js')
const {resolveAlbumDir, writeSidecar} = await import('../common/library.js')

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

const albumId = '9990001'
const album = {albumId: albumId, albumTitle: '测试书', anchorName: '测试主播', trackCount: 6}
const dir = path.join(outRoot, '《测试书》测试主播')
fs.mkdirSync(dir, {recursive: true})
for (const f of ['0001.m4a', '0002.标题.m4a', '0003.mp4', '4第五集标题.m4a', '0005.m4a.part', 'cover.jpg', 'desc.txt']) {
    fs.writeFileSync(path.join(dir, f), 'x')
}

// ① 扫一次目录的索引：只认音频、不认半成品/封面，宽松写法也认
const index = buildDiskIndex(dir, album)
eq([...index.keys()].sort((a, b) => a - b), [1, 2, 3, 4], 'buildDiskIndex 认出的集号')
eq(diskTrackIndex(dir, album).size, 4, 'diskTrackIndex 与 buildDiskIndex 一致')

// ② 进度库：1..5 全记 path:null（老库书的样子），6 记一条幽灵路径，2 再来一条重复记录
for (const num of [1, 2, 3, 4, 5]) {
    await trackDB.insert({trackId: `t${num}`, title: `第${num}集`, albumId: albumId, num: num, path: null})
}
await trackDB.insert({trackId: 't6', title: '第6集', albumId: albumId, num: 6, path: path.join(dir, '0006.m4a')})
await trackDB.insert({trackId: 't2b', title: '第2集(旧)', albumId: albumId, num: 2, path: null})
eq(await trackDB.count({albumId: albumId}), 7, '插入了 7 条记录（6 集号 + 1 条重复）')

// ③ 补路径：磁盘上真有的 1/2/3/4 一次补齐，5 还是缺（半成品不算）
const bf = await backfillPaths(albumId, dir, album)
eq({onDisk: bf.onDisk, marked: bf.marked, stillMissing: bf.stillMissing}, {onDisk: 4, marked: 4, stillMissing: 1}, 'backfillPaths 结果')
eq(await trackDB.count({albumId: albumId, path: null}), 1, '补完后 path:null 只剩 1 条')
const dupRow = await trackDB.findOne({trackId: 't2b'})
eq(!!dupRow.path && dupRow.path.endsWith('0002.标题.m4a'), true, 'updateMulti 把重复记录也补上了（不是只改一条）')

// ④ 对账：真缺是 5（磁盘上没有）和 6（记的那条路径是幽灵路径、文件其实不在）
const audit = await auditAlbum(albumId, dir, album)
eq({
    rows: audit.rows, distinctNums: audit.distinctNums, withPath: audit.withPath,
    nullPath: audit.nullPath, ghostPaths: audit.ghostPaths, dupGroups: audit.dupGroups,
    dupExtraRows: audit.dupExtraRows, onDiskFiles: audit.onDiskFiles,
    missingOnDisk: audit.missingOnDisk, missingOnDiskNums: audit.missingOnDiskNums,
}, {
    rows: 7, distinctNums: 6, withPath: 6, nullPath: 1, ghostPaths: 1, dupGroups: 1,
    dupExtraRows: 1, onDiskFiles: 4, missingOnDisk: 2, missingOnDiskNums: [5, 6],
}, 'auditAlbum 对账')

// ⑤ 去重：默认只报不改
const dry = await dedupeAlbum(albumId, dir, album, {apply: false})
eq({groups: dry.groups, removed: dry.removed, applied: dry.applied}, {groups: 1, removed: 1, applied: false}, 'dedupeAlbum 试运行只报不改')
eq(await trackDB.count({albumId: albumId}), 7, '试运行后记录数不变')
const wet = await dedupeAlbum(albumId, dir, album, {apply: true})
eq({groups: wet.groups, removed: wet.removed, applied: wet.applied}, {groups: 1, removed: 1, applied: true}, 'dedupeAlbum 实际执行')
eq(await trackDB.count({albumId: albumId}), 6, '去重后剩 6 条')
const kept = await trackDB.findOne({albumId: albumId, num: 2})
eq(kept.trackId, 't2', '去重保留「磁盘上真有文件」的那条')

// ⑥ 目录复用：算出来的目录名和磁盘上那个对不上时，沿用磁盘上已有的
const renamed = path.join(outRoot, '《测试书》手工改过的名字')
fs.mkdirSync(renamed, {recursive: true})
writeSidecar(renamed, album)
for (const f of ['0001.m4a', '0002.标题.m4a', '0003.mp4']) fs.writeFileSync(path.join(renamed, f), 'x')
const pickA = resolveAlbumDir(outRoot, album, {})
eq({reused: pickA.reused, name: pickA.name}, {reused: true, name: '《测试书》手工改过的名字'}, '只有改名目录时沿用改名目录')

const canonicalName = albumDirName(album, {})
const canonicalDir = path.join(outRoot, canonicalName)
fs.mkdirSync(canonicalDir, {recursive: true})
writeSidecar(canonicalDir, album)
for (const f of ['0001.m4a', '0002.m4a', '0003.m4a', '0004.m4a', '0005.m4a']) fs.writeFileSync(path.join(canonicalDir, f), 'x')
const pickB = resolveAlbumDir(outRoot, album, {})
eq({reused: pickB.reused, name: pickB.name}, {reused: false, name: canonicalName}, '算出来的目录集数更多时用它')

console.log(`\n${process.exitCode ? 'FAILED' : `ALL PASS (${pass} 项断言)`}`)
fs.rmSync(tmp, {recursive: true, force: true})
