/**
 * 「库里已有的书」——扫下载目录，整理出磁盘上的事实。
 *
 * 为什么必须扫盘、而不是只问进度库：库里有些书是早先用别的工具下的，进度库里
 * 压根没有它们的记录（实测 6 本里 3 本对不上），只看 DB 会把它们当成不存在。
 * 反过来，进度库能告诉我们「这张专辑平台一共多少集」，所以两边都要用：
 * 认得出专辑的书才能算出下没下完。
 *
 * 认专辑的两条路，按可靠程度排序：
 *   1) sidecar（`.xmd-album.json`）—— 本工具下载时自己写的，绝对准；
 *   2) 目录名与 albumDirName(专辑) 完全一致 —— 命名规则是同一个函数算出来的，
 *      老书对得上（实测 3 本对得上）；对不上的就是「未识别」，面板上让用户手工绑定。
 */
import fs from 'fs'
import path from 'path'
import {albumDirName} from './naming.js'

const AUDIO_RE = /\.(m4a|mp3|m4b|aac|flac|ogg|opus|wav|wma)$/i
const IMAGE_RE = /\.(jpg|jpeg|png|webp|gif|bmp)$/i

/** 专辑身份的小抄，写进专辑目录里；点开目录一眼就知道这是哪张专辑 */
export const SIDECAR_NAME = '.xmd-album.json'

export function readSidecar(dir) {
    try {
        const p = path.join(dir, SIDECAR_NAME)
        if (!fs.existsSync(p)) return null
        const o = JSON.parse(String(fs.readFileSync(p, 'utf-8')))
        if (o == null || typeof o !== 'object') return null
        const id = o.albumId == null ? '' : String(o.albumId).trim()
        return id === '' ? null : {...o, albumId: id}
    } catch (e) {
        return null
    }
}

/** 内容没变就不重写，免得每次扫库都把 mtime 搅一遍 */
export function writeSidecar(dir, album) {
    if (!dir || !album || album.albumId == null) return false
    const data = {
        albumId: String(album.albumId),
        albumTitle: album.albumTitle == null ? '' : String(album.albumTitle),
        anchorName: album.anchorName == null ? '' : String(album.anchorName),
        trackCount: album.trackCount == null ? null : Number(album.trackCount),
        isFinished: album.isFinished == null ? null : album.isFinished,
    }
    const p = path.join(dir, SIDECAR_NAME)
    try {
        const old = fs.existsSync(p) ? String(fs.readFileSync(p, 'utf-8')) : null
        const text = JSON.stringify(data, null, 2) + '\n'
        if (old === text) return false
        fs.mkdirSync(dir, {recursive: true})
        fs.writeFileSync(p, text)
        return true
    } catch (e) {
        return false
    }
}

let cache = {root: '', at: 0, rows: []}

/**
 * 扫库目录，每本书（子目录）一行。
 *
 * 带缓存：面板每隔几秒就拉一次 state，而库里几千个文件名每次全读一遍太浪费。
 * @param root 库根目录（容器里是 /downloads）
 * @param force 面板上点「刷新」时用
 */
export function scanLibrary(root, opts = {}) {
    const dir = String(root == null ? '' : root)
    const maxAgeMs = opts.maxAgeMs == null ? 60000 : opts.maxAgeMs
    const now = Date.now()
    if (!opts.force && cache.root === dir && now - cache.at < maxAgeMs) {
        return cache.rows
    }
    const rows = []
    let entries = []
    try {
        entries = fs.readdirSync(dir, {withFileTypes: true})
    } catch (e) {
        cache = {root: dir, at: now, rows: []}
        return rows
    }
    for (const ent of entries) {
        if (!ent.isDirectory()) continue
        if (ent.name.startsWith('.')) continue
        const full = path.join(dir, ent.name)
        let files = []
        try {
            files = fs.readdirSync(full, {withFileTypes: true})
        } catch (e) {
            continue
        }
        let audio = 0
        let files_ = 0
        let images = 0
        let hasCover = false
        let hasDesc = false
        let hasReader = false
        let mtimeMs = 0
        for (const f of files) {
            if (f.isDirectory()) continue
            files_++
            if (AUDIO_RE.test(f.name)) audio++
            if (IMAGE_RE.test(f.name)) images++
            const lower = f.name.toLowerCase()
            if (lower === 'cover.jpg' || lower === 'folder.jpg' || lower === 'poster.jpg') hasCover = true
            if (lower === 'desc.txt') hasDesc = true
            if (lower === 'reader.txt') hasReader = true
        }
        try {
            mtimeMs = fs.statSync(full).mtimeMs
        } catch (e) {
            // 没 mtime 就算了，不影响
        }
        rows.push({
            name: ent.name,
            dir: full,
            audio, files: files_, images, hasCover, hasDesc, hasReader, mtimeMs,
            sidecar: readSidecar(full),
        })
    }
    rows.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name, 'zh'))
    cache = {root: dir, at: now, rows}
    return rows
}

/** 面板「刷新」用：下次一定重扫 */
export function invalidateLibraryCache() {
    cache = {root: '', at: 0, rows: []}
}

/**
 * 把磁盘上的书对到专辑上，算出完成度。
 *
 * @param rows scanLibrary() 的结果
 * @param albums 专辑记录（albumDB），字段 albumId/albumTitle/anchorName/trackCount
 * @param meta albums.meta.json（手工登记的作者），只为了目录名算得准
 * @returns 每行追加：albumId / albumTitle / anchorName / total / remaining / complete / matchedBy
 */
export function identifyLibrary(rows, albums, meta) {
    const byId = new Map()
    const byName = new Map()
    for (const a of albums || []) {
        if (a == null || a.albumId == null) continue
        const id = String(a.albumId)
        byId.set(id, a)
        let name = ''
        try {
            name = albumDirName(a, meta)
        } catch (e) {
            name = ''
        }
        if (name !== '' && !byName.has(name)) byName.set(name, a)
    }
    return (rows || []).map(row => {
        let album = null
        let matchedBy = null
        if (row.sidecar && byId.has(row.sidecar.albumId)) {
            album = byId.get(row.sidecar.albumId)
            matchedBy = 'sidecar'
        } else if (byName.has(row.name)) {
            album = byName.get(row.name)
            matchedBy = 'name'
        }
        if (matchedBy == null && row.sidecar) {
            // sidecar 有、库里却没有这张专辑的记录：照样认这个 albumId（平台上的信息还能查）
            album = {...row.sidecar}
            matchedBy = 'sidecar'
        }
        const albumId = album && album.albumId != null ? String(album.albumId) : null
        const total = album && Number(album.trackCount) > 0 ? Number(album.trackCount) : null
        const remaining = total == null ? null : Math.max(0, total - row.audio)
        return {
            ...row,
            albumId,
            albumTitle: album && album.albumTitle ? String(album.albumTitle) : '',
            anchorName: album && album.anchorName ? String(album.anchorName) : '',
            total,
            remaining,
            // 认不出专辑的书没法判断下没下完 —— complete 给 null，面板上按「未识别」显示
            complete: total == null ? null : row.audio >= total,
            matchedBy,
        }
    })
}
