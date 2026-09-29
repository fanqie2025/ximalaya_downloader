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
import {albumDirName, isAudioFileName} from './naming.js'

// 音频判据统一放在 naming.js（isAudioFileName / AUDIO_EXT_RE）：
// 这里原来自己写了一份更窄的名单，漏了 .mp4，而下载跳过那一侧按前缀命中任意扩展名 ——
// 两套判据不一致的直接后果是《道诡异仙》42 集被算成欠集。
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
 * 这本专辑现在该写进哪个目录。
 *
 * 为什么不能只算 albumDirName：用户可能手工改过目录名（实测《道诡异仙》被改成
 * `《道诡异仙》主播：传说中的方片K 1303集完`），平台也可能改了主播名。名称一变，
 * 算出来的目录就和磁盘上那个对不上了 —— 老实现会另建一个新名字的空目录，
 * 把这本 1300 集的专辑从头下一遍（实测第 3 轮就这么往新目录里重下了 56 集）。
 *
 * 所以先找「带同一 albumId sidecar 的兄弟目录」：集数最多的那个就沿用，
 * 只有算出来的名字确实更完整（或没有别的候选）时才用它。
 */
export function resolveAlbumDir(outputRoot, album, albumMeta) {
    const canonicalName = albumDirName(album, albumMeta)
    const canonicalDir = path.join(outputRoot, canonicalName)
    const albumId = album && album.albumId != null ? String(album.albumId) : ''
    const candidates = []
    if (albumId !== '' && fs.existsSync(outputRoot)) {
        let names = []
        try {
            names = fs.readdirSync(outputRoot)
        } catch (e) {
            names = []
        }
        for (const name of names) {
            const dir = path.join(outputRoot, name)
            try {
                if (!fs.statSync(dir).isDirectory()) continue
            } catch (e) {
                continue
            }
            const sidecar = readSidecar(dir)
            if (sidecar == null || String(sidecar.albumId) !== albumId) continue
            candidates.push({name: name, dir: dir, audio: countAudioIn(dir)})
        }
    }
    const canonicalHit = candidates.find(c => c.dir === canonicalDir)
    const bestOther = candidates
        .filter(c => c.dir !== canonicalDir)
        .sort((a, b) => b.audio - a.audio || (a.name < b.name ? -1 : 1))[0]
    if (bestOther && (!canonicalHit || bestOther.audio > canonicalHit.audio)) {
        return {
            dir: bestOther.dir,
            name: bestOther.name,
            reused: true,
            audio: bestOther.audio,
            canonicalName: canonicalName,
        }
    }
    return {dir: canonicalDir, name: canonicalName, reused: false}
}

/** 数目录里的音频文件（判据与下载/扫库同一套） */
function countAudioIn(dir) {
    try {
        return fs.readdirSync(dir).filter(f => isAudioFileName(f)).length
    } catch (e) {
        return 0
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

/**
 * 单集忽略：一本里「这几集我不要」。
 *
 * 为什么需要：专辑级的 `.xmd-skip` 只能整本放过，管不到单集。而单集一旦被删，
 * 进度库里那条记录不是 `path: null`（就是文件被删后由 clearStalePaths 置回 null），
 * 下一轮就**又下回来了** —— 想删的那几集永远删不掉。
 *
 * 规则落在专辑目录里的 `.xmd-ignore.json`，跟着书走（换机器、换库、换账号都在）：
 *   - 面板写 `nums`（集号，支持 `651,656-660`）与 `patterns`（标题正则）；
 *   - 下载器用同一个判据 `ignoreMatches` 解析出真正命中的集号，写回 `resolved`，
 *     同时把命中的记录在进度库里打上 `skip: true`；
 *   - 面板按 `resolved` 把「还差 N 集」算准（`resolved` 只记**磁盘上没有的**，
 *     所以不会和已下好的集重复扣）。
 * **只是标记，音频文件一个都不动。**
 */
export const IGNORE_NAME = '.xmd-ignore.json'

const numList = v => (Array.isArray(v) ? v.map(Number).filter(n => Number.isFinite(n)) : [])

/** 读单集忽略规则：没有或读坏了都返回 null */
export function readIgnore(dir) {
    if (!dir) return null
    try {
        const p = path.join(dir, IGNORE_NAME)
        if (!fs.existsSync(p)) return null
        const o = JSON.parse(String(fs.readFileSync(p, 'utf-8')))
        if (o == null || typeof o !== 'object') return null
        return {
            nums: numList(o.nums),
            patterns: (Array.isArray(o.patterns) ? o.patterns : []).map(String).filter(s => s !== ''),
            resolved: numList(o.resolved),
            reason: String(o.reason == null ? '' : o.reason),
            at: o.at || null,
        }
    } catch (e) {
        return null
    }
}

/**
 * 写单集忽略规则；`nums` 与 `patterns` 都空就等于取消忽略（删掉文件）。
 * @param {{nums?: number[], patterns?: string[], resolved?: number[], reason?: string}} spec
 */
export function writeIgnore(dir, spec) {
    if (!dir) return false
    const p = path.join(dir, IGNORE_NAME)
    try {
        const nums = numList(spec && spec.nums)
        const patterns = ((spec && spec.patterns) || []).map(String).filter(s => s !== '')
        if (nums.length === 0 && patterns.length === 0) {
            if (fs.existsSync(p)) fs.unlinkSync(p)
            return true
        }
        const data = {
            nums: nums,
            patterns: patterns,
            reason: String(spec && spec.reason == null ? '' : spec.reason),
            at: Date.now(),
        }
        // resolved 由下载器解析后写回；用户刚改过规则时先清掉，免得用过期的数字
        const resolved = numList(spec && spec.resolved)
        if (resolved.length > 0) data.resolved = resolved
        fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n')
        return true
    } catch (e) {
        return false
    }
}

/**
 * 「这一集要不要忽略」—— 下载器、进度库自愈、面板三处共用这一个判据。
 * 坏正则退化成普通子串匹配，不让一条写错的规则把整本卡住。
 */
export function ignoreMatches(spec, num, title) {
    if (spec == null) return false
    if (Number.isFinite(num) && (spec.nums || []).indexOf(num) >= 0) return true
    const t = String(title == null ? '' : title)
    for (const p of spec.patterns || []) {
        try {
            if (new RegExp(p).test(t)) return true
        } catch (e) {
            if (t.includes(p)) return true
        }
    }
    return false
}

/**
 * 面板输入框 → 集号数组：`651,656-660` → `[651,656,657,658,659,660]`。
 * 支持中英文逗号、空格、以及 `-`/`~`/`～`/`—`/`－` 区间；单次最多 5000 个，防止手滑写出天文数字。
 */
export function parseNumSpec(text) {
    const out = new Set()
    for (const part of String(text == null ? '' : text).split(/[,，、\s]+/)) {
        if (part === '') continue
        const m = /^(\d+)\s*[-~～—－]\s*(\d+)$/.exec(part)
        if (m) {
            let a = Number(m[1])
            let b = Number(m[2])
            if (a > b) {
                const t = a
                a = b
                b = t
            }
            if (b - a > 5000) b = a + 5000
            for (let i = a; i <= b; i++) out.add(i)
        } else if (/^\d+$/.test(part)) {
            out.add(Number(part))
        }
    }
    return [...out].sort((x, y) => x - y)
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
            if (isAudioFileName(f.name)) audio++
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
            ignore: readIgnore(full),
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
        // 单集忽略：只扣「磁盘上没有、且用户已标记忽略」的那些（下载器解析后写在 resolved 里）。
        // 不扣的话，被忽略的集会让这本书永远显示「未下完，还差 N 集」—— 正是用户当初
        // 想删那几集时遇到的假待办。规则刚写完、下载器还没解析时 ignoredPending 为真，
        // 这一次先照实报「还差」，下一轮就会对上。
        const ignoreSpec = row.ignore || null
        const skipped = ignoreSpec && Array.isArray(ignoreSpec.resolved) ? ignoreSpec.resolved.length : 0
        const ignoredPending = skipped === 0
            && ignoreSpec != null
            && ((ignoreSpec.nums || []).length > 0 || (ignoreSpec.patterns || []).length > 0)
        const remaining = total == null ? null : Math.max(0, total - row.audio - skipped)
        const ignored = row.skip != null
        return {
            ...row,
            albumId,
            albumTitle: album && album.albumTitle ? String(album.albumTitle) : '',
            anchorName: album && album.anchorName ? String(album.anchorName) : '',
            total,
            skipped,
            ignoredPending,
            ignoreReason: ignoreSpec ? String(ignoreSpec.reason || '') : '',
            ignoreNums: ignoreSpec ? (ignoreSpec.nums || []) : [],
            ignorePatterns: ignoreSpec ? (ignoreSpec.patterns || []) : [],
            remaining,
            // 认不出专辑的书没法判断下没下完 —— complete 给 null，面板上按「未识别」显示
            complete: total == null ? null : (row.audio + skipped) >= total,
            matchedBy,
            // 标记过「非本站」的书：面板上不再当待办（认不认得出来都一样，用户已经拍过板）
            ignored,
            skipReason: ignored && row.skip.reason ? String(row.skip.reason) : '',
        }
    }))
}
