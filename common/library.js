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

/**
 * 「非本站」标记：这个目录不是喜马拉雅来的（番茄唱听、懒人听书…），永远绑不上专辑。
 * 面板上给它一个收尾动作 —— 在目录里放一个 `.xmd-skip`，扫库时这行就显示成
 * 「非本站 · 已忽略」，不再催用户绑定。**只是个小标记，音频文件一个都不动。**
 */
export const SKIP_NAME = '.xmd-skip'

/** 读标记：没有就返回 null；有就返回 {reason, at}（文件被人手写过非 JSON 也认，整段当 reason） */
export function readSkip(dir) {
    try {
        const p = path.join(dir, SKIP_NAME)
        if (!fs.existsSync(p)) return null
        const raw = String(fs.readFileSync(p, 'utf-8')).trim()
        if (raw === '') return {reason: '', at: null}
        try {
            const o = JSON.parse(raw)
            if (o != null && typeof o === 'object') return o
        } catch (e) {
            // 不是 JSON 就当原因文本
        }
        return {reason: raw, at: null}
    } catch (e) {
        return null
    }
}

/** 写/删标记。on=false 时删文件（取消忽略） */
export function writeSkip(dir, on, reason) {
    if (!dir) return false
    const p = path.join(dir, SKIP_NAME)
    try {
        if (!on) {
            if (fs.existsSync(p)) fs.unlinkSync(p)
            return true
        }
        const data = {skip: true, reason: String(reason == null ? '' : reason), at: Date.now()}
        fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n')
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
            skip: readSkip(full),
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

/** 同一本书的两个目录里，哪条更该当「这本书本体」：下完的优先，其次音频多的 */
function rankOf(r) {
    return (r.complete === true ? 1000000 : 0) + (Number(r.audio) || 0)
}

/**
 * 去重：同一张专辑被下进了两个目录（比如下到一半改了名、或者早先用别的工具下过一份），
 * 面板上就会一本出现在「已完成」、另一本出现在「未完成」——同一本书算了两本。
 *
 * 按专辑身份合并（有 albumId 认 albumId，都没有才拿目录名当身份），
 * 留下最完整的那条代表这本书；其余目录名挂在 dupes 上照实说明，
 * 不隐藏、不删文件 —— 磁盘上确实有两个目录，这事得让用户看见。
 */
export function dedupeIdentified(list) {
    const groups = new Map()
    const order = []
    for (const row of list || []) {
        const key = row.albumId != null && row.albumId !== ''
            ? 'id:' + row.albumId
            : 'name:' + String(row.name == null ? '' : row.name).trim()
        const head = groups.get(key)
        if (head == null) {
            const first = {...row, dupes: []}
            groups.set(key, first)
            order.push(first)
            continue
        }
        const extra = {name: row.name, dir: row.dir, audio: row.audio, complete: row.complete}
        if (rankOf(row) > rankOf(head)) {
            // 新来的这条更完整：它当代表，原来那条退成「另有目录」
            extra.name = head.name
            extra.dir = head.dir
            extra.audio = head.audio
            extra.complete = head.complete
            const kept = head.dupes
            Object.assign(head, row, {dupes: kept.concat([extra])})
        } else {
            head.dupes.push(extra)
        }
    }
    return order
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
    return dedupeIdentified((rows || []).map(row => {
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
        const ignored = row.skip != null
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
            // 标记过「非本站」的书：面板上不再当待办（认不认得出来都一样，用户已经拍过板）
            ignored,
            skipReason: ignored && row.skip.reason ? String(row.skip.reason) : '',
        }
    }))
}
