import fs from 'fs'
import path from 'path'
import {trackDB} from '../db/trackdb.js'
import {buildDiskIndex} from './naming.js'
import {ignoreMatches} from './library.js'

/**
 * 进度库（NeDB `track.db`）自愈。
 *
 * 为什么需要这一层：进度库里 `path: null` 的含义是「这集还没下载」，是主循环
 * 唯一的下发条件。而历史遗留让这个字段长期不可信：
 *   - 老库书（实测《全职高手》76941016、《道诡异仙》71301941）**一行记录都没有**：
 *     文件是当年直接放进去的，进度库里没有登记。于是每轮先按 30/页拉一遍章节列表
 *     insert 进来（path 全是 null），再从第 1 集起逐条 walk：找到磁盘上的文件就补路径。
 *     实测 3.7 分钟只推进 56 集，一本 1300 集的专辑要二十多轮才「认完」，而且每轮
 *     都从第 1 集重来 —— 期间日志里的「待下载」数字一直是虚的。
 *   - 同一个集号出现两条记录（实测 33476331 有 58 组重复）：`trackDB.count` 因此比
 *     `album.trackCount` 多，`needFlushTracks` 每轮都判 true，每轮重新拉一遍章节列表。
 *
 * 三件事都不碰音频文件、不删进度、不重下：
 *   1) backfillPaths —— 磁盘上有、库里还记着 null 的，一次性补上真实路径；
 *   2) auditAlbum    —— 出一份「库 vs 磁盘」的对账报告（给面板/命令行看）；
 *   3) dedupeAlbum   —— 同集号的重复记录只留一条，默认只报不改（apply 才动手）。
 */

/** 目录扫描索引（判据与 findExistingTrack 同一套，见 common/naming.js） */
export function diskTrackIndex(targetDir, album) {
    return buildDiskIndex(targetDir, album)
}

/**
 * 磁盘上已经有、进度库里却是 null 的集，一次性补上路径。
 * @returns {{onDisk:number, marked:number, stillMissing:number}}
 */
export async function backfillPaths(albumId, targetDir, album) {
    // 忽略掉的集不参与补齐：它们本来就不该有路径，补上反而会让「已完成」的数字虚高
    const rows = await trackDB.find(pendingQuery(albumId))
    const onDisk = buildDiskIndex(targetDir, album)
    if (rows.length === 0 || onDisk.size === 0) {
        return {onDisk: onDisk.size, marked: 0, stillMissing: rows.length}
    }
    const pending = new Set(rows.map(r => r.num))
    let marked = 0
    for (const [num, name] of onDisk) {
        if (!pending.has(num)) {
            continue
        }
        // 用 updateMulti：同号可能有多条重复记录，只改一条的话剩下的会继续被判成待下载
        await trackDB.updateMulti({albumId: albumId, num: num}, {path: path.join(targetDir, name)})
        marked++
    }
    return {onDisk: onDisk.size, marked: marked, stillMissing: pending.size - marked}
}

/**
 * 主循环「还有什么要下」的查询条件 —— 只有一个定义，下载主循环、目录自愈、
 * 对账三处都从这儿取，免得哪一处漏掉 `skip` 又把用户忽略掉的集下回来。
 */
export function pendingQuery(albumId) {
    return {albumId: albumId, path: null, skip: {$ne: true}}
}

/** 被用户标记忽略的集号（按集号去重，重复记录算一集） */
export async function countSkipped(albumId) {
    const rows = await trackDB.find({albumId: albumId, skip: true})
    return new Set(rows.map(r => r.num)).size
}

/**
 * 把目录里的单集忽略规则（`.xmd-ignore.json`）落到进度库上。
 *
 * 规则是「集号 + 标题正则」，命中才算 —— 所以必须由拿到章节标题的下载器来解析。
 * `resolved` 只记**磁盘上没有的**命中集号：已经在盘上的那几集不该再让面板
 * 从「还差 N 集」里扣一次。
 *
 * @returns {{matched:number[], marked:number, cleared:number, resolved:number[]}}
 */
export async function syncIgnoreMarks(albumId, targetDir, album, spec) {
    const rows = await trackDB.find({albumId: albumId})
    const onDisk = buildDiskIndex(targetDir, album)
    const matched = new Set()
    const hadSkip = new Set()
    for (const r of rows) {
        if (r.skip === true) hadSkip.add(r.num)
        if (ignoreMatches(spec, r.num, r.title)) matched.add(r.num)
    }
    const reason = spec && spec.reason ? String(spec.reason) : ''
    let marked = 0
    let cleared = 0
    for (const num of matched) {
        if (hadSkip.has(num)) continue
        // updateMulti：同集号的重复记录一起打标，否则漏掉的那条又会被当成待下载
        await trackDB.updateMulti({albumId: albumId, num: num},
            {skip: true, skipReason: reason, skipAt: Date.now()})
        marked++
    }
    for (const num of hadSkip) {
        if (matched.has(num)) continue
        // 用 skip:false 而不是删字段：查询一律走 {skip: {$ne: true}}，两种写法都对，
        // 但 NeDB 的 update 只能 $set，删字段得再来一套 $unset。
        await trackDB.updateMulti({albumId: albumId, num: num}, {skip: false, skipReason: null, skipAt: null})
        cleared++
    }
    const resolved = [...matched].filter(n => !onDisk.has(n)).sort((a, b) => a - b)
    return {matched: [...matched].sort((a, b) => a - b), marked: marked, cleared: cleared, resolved: resolved}
}

function hasRealFile(p) {
    return !!p && fs.existsSync(p)
}

/**
 * 对账：这本专辑「进度库记的」和「磁盘上有的」差在哪。
 * 面板的「还差 N 集」到底有多少是真的缺，看这里。
 */
export async function auditAlbum(albumId, targetDir, album) {
    const rows = await trackDB.find({albumId: albumId})
    const onDisk = buildDiskIndex(targetDir, album)
    const byNum = new Map()
    let withPath = 0
    let ghostPaths = 0
    for (const r of rows) {
        if (r.path) {
            withPath++
            if (!fs.existsSync(r.path)) {
                ghostPaths++
            }
        }
        const list = byNum.get(r.num)
        if (list) {
            list.push(r)
        } else {
            byNum.set(r.num, [r])
        }
    }
    let dupGroups = 0
    let dupExtraRows = 0
    for (const list of byNum.values()) {
        if (list.length > 1) {
            dupGroups++
            dupExtraRows += list.length - 1
        }
    }
    // 用户明确标记「这几集不要」的，不算缺 —— 否则面板永远显示「还差 N 集」，
    // 而那 N 集正是他删掉的。
    const skipped = new Set()
    for (const r of rows) {
        if (r.skip === true) {
            skipped.add(r.num)
        }
    }
    const onDiskNotInDb = []
    for (const num of onDisk.keys()) {
        if (!byNum.has(num)) {
            onDiskNotInDb.push(num)
        }
    }
    const missingOnDisk = []
    for (const [num, list] of byNum) {
        if (onDisk.has(num)) {
            continue
        }
        if (skipped.has(num)) {
            continue
        }
        if (list.some(r => hasRealFile(r.path))) {
            continue
        }
        missingOnDisk.push(num)
    }
    return {
        albumId: String(albumId),
        dir: targetDir,
        rows: rows.length,
        distinctNums: byNum.size,
        withPath: withPath,
        nullPath: rows.length - withPath,
        ghostPaths: ghostPaths,
        skipped: skipped.size,
        skippedNums: [...skipped].sort((a, b) => a - b).slice(0, 30),
        dupGroups: dupGroups,
        dupExtraRows: dupExtraRows,
        onDiskFiles: onDisk.size,
        onDiskNotInDb: onDiskNotInDb.length,
        missingOnDisk: missingOnDisk.length,
        missingOnDiskNums: missingOnDisk.sort((a, b) => a - b).slice(0, 30),
    }
}

/**
 * 同一个集号的重复记录只留一条。
 * 保留顺序：磁盘上真有文件的那条 > 有路径的那条 > 先遇到的。
 * @param {{apply?: boolean}} opts apply 为 false（默认）时只统计不删。
 */
export async function dedupeAlbum(albumId, targetDir, album, opts) {
    const apply = !!(opts && opts.apply)
    const rows = await trackDB.find({albumId: albumId})
    const byNum = new Map()
    for (const r of rows) {
        const list = byNum.get(r.num)
        if (list) {
            list.push(r)
        } else {
            byNum.set(r.num, [r])
        }
    }
    // 同档次时按 trackId 定序：NeDB 的 find 是按 _id 索引出来的，而 _id 是随机串，
    // 不定序的话「保留哪一条」每次跑都不一样（本地自测就撞过：这次留 t2、下次留 t2b）。
    const rank = r => (hasRealFile(r.path) ? 0 : (r.path ? 1 : 2))
    const better = (a, b) => rank(a) - rank(b) || String(a.trackId).localeCompare(String(b.trackId))
    let groups = 0
    let removed = 0
    for (const list of byNum.values()) {
        if (list.length < 2) {
            continue
        }
        groups++
        const sorted = list.slice().sort(better)
        for (const r of sorted.slice(1)) {
            if (apply) {
                await trackDB.removeById(r._id)
            }
            removed++
        }
    }
    return {groups: groups, removed: removed, applied: apply}
}

/**
 * 一次跑完「对账前自愈」：补路径 → 去重 → 出报告。
 * 下载主流程与命令行 `--audit` 共用这一段，保证两条路的判断完全一致。
 */
export async function selfHealAlbum(albumId, targetDir, album, opts) {
    const backfill = await backfillPaths(albumId, targetDir, album)
    const dedupe = await dedupeAlbum(albumId, targetDir, album, opts)
    const audit = await auditAlbum(albumId, targetDir, album)
    return {backfill: backfill, dedupe: dedupe, audit: audit}
}
