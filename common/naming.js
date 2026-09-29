/**
 * 专辑目录 / 章节文件的命名规则。
 *
 * 抽成独立模块的原因：CLI（xmd.js）、调度器、将来的 GUI 都要用同一套规则，
 * 各写一份迟早会走偏 —— 一旦偏了，DB 里记的路径就对不上磁盘，下载器会以为
 * 文件不存在而整专辑重下。
 */
import fs from 'fs'
import path from 'path'
import {config} from './config.js'
import {projectRoot} from '../settings.js'

/**
 * 把 Windows 与 POSIX 都不允许出现在路径里的字符换成下划线。
 * 半角 | 会挡路径，全角 ｜ 不会，所以只处理半角（与上游行为一致）。
 */
export function cleanedStr(str) {
    const pathCharactersRegex = /[<>:"/\\|?*\x00-\x1F]/g
    return String(str == null ? '' : str).replace(pathCharactersRegex, '_')
}

/**
 * Linux 单个文件名上限 255 字节，中文一个字 3 字节。
 * 按字节截断而不是按字数，否则长标题（含书名号+卖点）在容器里会 ENAMETOOLONG。
 */
export function truncateBytes(s, maxBytes) {
    let out = ''
    let n = 0
    for (const ch of String(s == null ? '' : s)) {
        const b = Buffer.byteLength(ch, 'utf8')
        if (n + b > maxBytes) break
        out += ch
        n += b
    }
    return out
}

/** 剥掉书名号与包裹括号，避免和模板里已有的《》叠成《《X》》 */
function stripWrapping(s) {
    let out = s
    for (const [l, r] of [['《', '》'], ['【', '】'], ['[', ']'], ['（', '）'], ['(', ')']]) {
        if (out.startsWith(l) && out.endsWith(r) && out.length > l.length + r.length) {
            out = out.slice(l.length, out.length - r.length).trim()
            break
        }
    }
    // 书名号无论成不成对都去掉：模板里已经包了一层《》，
    // 留着就成《《全职高手》合集》。
    // 「三体（全六季）」的括号在中间不成对，不受影响。
    const stripped = out.replace(/[《》]/g, '').replace(/\s{2,}/g, ' ').trim()
    return stripped === '' ? s : stripped
}

/**
 * 拆解专辑标题。
 *
 * 平台没有统一的标题格式，最常撞见两种，靠段数就能分开：
 *   「作者｜书名｜类型」     例：无敌浪爷｜史上最强赘婿｜同名漫画
 *   「书名｜卖点，作者著」   例：三体（全六季）| 精品广播剧，刘慈欣著
 * 三段走第一种：中间那段是书名，第一段是作者（这条很稳，是平台的常用套路）。
 * 其余情况取第一段当书名；若那段恰好等于主播名，说明是「主播｜书名」结构，
 * 往下再取一段，免得拼出「《无敌浪爷》无敌浪爷」。
 *
 * 为什么书名不能直接拿整串：整串又长又带卖点，和 ABS 库里既有的
 * 「《书名》主播」风格不搭。
 *
 * @returns {{title: string, author: string, guessed: boolean}}
 *          guessed 表示作者是从标题推出来的、而不是手工登记的
 */
export function parseAlbumTitle(title, anchorName) {
    const parts = String(title == null ? '' : title)
        .split(/[|｜]/)
        .map(s => s.trim())
        .filter(Boolean)
    const anchor = String(anchorName == null ? '' : anchorName).trim()
    if (parts.length === 0) return {title: '', author: '', guessed: false}

    let book = parts[0]
    let author = ''
    let guessed = false
    if (parts.length === 3) {
        book = parts[1]
        author = parts[0]
        guessed = true
    } else {
        let i = 0
        while (i < parts.length && parts[i] === anchor) i++
        if (i > 0 && i < parts.length) book = parts[i]
    }
    // 推出来的作者跟自己撞了就没意义了
    if (author === anchor || author === stripWrapping(book)) author = ''
    if (author === '') guessed = false
    return {title: stripWrapping(book), author, guessed}
}

/** 只要书名的场景 */
export function shortTitle(title, anchorName) {
    return parseAlbumTitle(title, anchorName).title
}

/**
 * 每张专辑的手工补充信息。
 *
 * 为什么需要：平台**不提供「作者」字段** —— simple、tdk-web seo、
 * m-revision queryAlbumPage、专辑 HTML 页、revision/album 五路都实测过，
 * 只有 anchorName（主播）。（标题里的「作者｜书名｜类型」套路能推出一部分，
 * 见 parseAlbumTitle，但推不出的就得手工补。）
 *
 * 文件放 config/ 下，和 albums.txt 同一目录 —— 容器里整个 config/ 是一个挂载点，
 * 分散在两处容易挂漏。
 *   { "30816438": { "author": "刘慈欣" } }
 */
export function loadAlbumMeta() {
    const p = path.join(projectRoot, 'config', 'albums.meta.json')
    if (!fs.existsSync(p)) return {}
    try {
        return JSON.parse(String(fs.readFileSync(p, 'utf-8')))
    } catch (e) {
        console.warn(`[naming] config/albums.meta.json 解析失败，忽略：${e.message}`)
        return {}
    }
}

/**
 * 默认模板对齐 ABS 媒体库里既有的命名习惯：《书名》主播 作者
 * 可选占位符 {title} {anchor} {author} {count} {status}
 * 占位符为空时会被连同多余空格一起清掉，所以没有作者不会留空格。
 */
export const DEFAULT_TEMPLATE = '《{title}》{anchor} {author}'

const STATUS_LABEL = {2: '完', 1: '连载'}

/**
 * 组装专辑目录名。
 *
 * 空占位符会被连同多余空格一起清掉，所以「没有作者」不会在目录名尾巴上
 * 留一个孤零零的空格或者 0。
 *
 * 作者优先级：手工登记（albums.meta.json）> 从标题推断 > 留空。
 * 推断这条可以靠 config.naming.authorGuess = false 关掉。
 */
export function albumDirName(album, meta) {
    const tpl = (config.naming && config.naming.template) || DEFAULT_TEMPLATE
    const m = (meta && meta[String(album.albumId)]) || {}
    let status = STATUS_LABEL[album.isFinished]
    if (album.isFinished === true) status = '完'
    const anchor = String(album.anchorName || '').trim()
    const parsed = parseAlbumTitle(album.albumTitle, anchor)
    const guessEnabled = config.naming == null || config.naming.authorGuess !== false
    const manualAuthor = String(album.author || m.author || '').trim()
    const values = {
        title: parsed.title,
        anchor: anchor,
        author: manualAuthor || (guessEnabled ? parsed.author : ''),
        count: album.trackCount == null ? '' : String(album.trackCount),
        status: status || '',
    }
    // 防一手：书名取不出更合适的段落时，别拼成《X》X
    if (values.anchor && values.anchor === values.title) values.anchor = ''
    let name = String(tpl)
    for (const k of Object.keys(values)) {
        name = name.split('{' + k + '}').join(values[k])
    }
    // 模板里写了不认识的占位符就别留在目录名上
    name = name.replace(/\{[a-zA-Z]+\}/g, '')
    name = name.replace(/\s{2,}/g, ' ').trim()
    name = cleanedStr(truncateBytes(name, 180)).trim()
    if (name === '') {
        name = cleanedStr(shortTitle(album.albumTitle, anchor)) || String(album.albumId)
    }
    return name
}

/**
 * 章节序号的位宽。
 *
 * 为什么要补零：Audiobookshelf 按文件名排序，不补零会排成
 * 1,10,11,2,3 —— 听书顺序全乱。判据是「同一专辑内数字位宽是否一致」，
 * 不是文件个数（8 集也能排错）。
 * config.naming.padWidth 可覆盖；设 0 表示不补零。
 */
export function padWidth(album) {
    const configured = config.naming && config.naming.padWidth
    if (configured != null && Number.isFinite(Number(configured))) {
        return Math.max(0, Number(configured))
    }
    const n = Math.max(Number(album && album.trackCount) || 0, 1)
    return Math.max(4, String(n).length)
}

/** 章节文件名：`0008.标题.m4a` */
export function trackFileName(track, album, extension) {
    const w = padWidth(album)
    const numStr = w > 0 ? String(track.num).padStart(w, '0') : String(track.num)
    const title = cleanedStr(truncateBytes(track.title, 150))
    return `${numStr}.${title}${extension}`
}

/**
 * 「这一集到底在不在」的唯一判据 —— 三处共用，不再各写一份。
 *
 * 使用者：扫库计数（common/library.js）、下载跳过 / 过期路径修正（xmd.js）、
 * 半成品识别（xmd.js 的原子写入）。历史上这三处判据不一致，代价是实打实的：
 *   - 扫库只认 m4a/mp3/… 不认 mp4，而喜马拉雅有一部分集就是用
 *     `Content-Type: audio/mp4` 下发的（AAC 装在 MP4 盒子里，与 .m4a 同构），
 *     落盘就成了 `.mp4`。于是《道诡异仙》42 集被面板报成欠集（报「差 46 集」，实差 4 集）。
 *   - 下载跳过那一侧只看 `startsWith(num + '.')`，不看扩展名 —— 那么
 *     `0686.jpg`、写到一半的 `0686.xxx.m4a.part` 都算「已下好」：
 *     下载器跳过它、扫库又不把它当音频，两边永远对不上，而且这集再也不会被下载。
 */
export const AUDIO_EXT_RE = /\.(m4a|mp4|m4b|mp3|mp2|aac|flac|ogg|oga|opus|wav|wma)$/i

/** 原子写入的半成品后缀：内容可能只写了一半，永远不算「这一集已经有了」 */
export const PARTIAL_EXT = '.part'

/** 是不是音频文件（只看扩展名） */
export function isAudioFileName(name) {
    return AUDIO_EXT_RE.test(String(name == null ? '' : name))
}

/** 是不是还没下完的半成品 */
export function isPartialFileName(name) {
    return String(name == null ? '' : name).toLowerCase().endsWith(PARTIAL_EXT)
}

/** 序号前缀：补零与不补零两种写法都算命中（用户手工补过零也不重下） */
export function trackNumPrefixes(num, album) {
    const w = padWidth(album)
    const prefixes = []
    if (w > 0) prefixes.push(String(num).padStart(w, '0'))
    prefixes.push(String(num))
    return prefixes
}

/** 目录里的这一行，是不是「前缀为 prefix 的那一集」：前缀对上 + 是音频 + 不是半成品 */
export function trackFileNameMatches(name, prefix) {
    const f = String(name == null ? '' : name)
    if (!f.startsWith(String(prefix) + '.')) return false
    return isAudioFileName(f) && !isPartialFileName(f)
}

/** 目录里的这一行，是不是「第 num 集」 */
export function isTrackFileName(name, num, album) {
    return trackNumPrefixes(num, album).some(p => trackFileNameMatches(name, p))
}

/**
 * 放宽一档的判据：序号后面少了那个点的文件也算这一集。
 *
 * 为什么需要：实测库里有 `2551完结.m4a`、`2552主题曲《荣耀》合唱版.m4a` 这类
 * 手改过的名字（当年补下时把 `2551.完结.m4a` 的点敲掉了）。严格判据认不出它们，
 * 于是这集会被当成「没有」再下一遍，目录里就多出一份重复音频、白烧额度。
 * 放宽的边界很小心：序号后面**必须不是数字**，这样 `25510.xx.m4a`（第 25510 集）
 * 不会被当成第 2551 集；扩展名与半成品仍然要过同一套判据。
 */
export function trackFileNameMatchesLoose(name, prefix) {
    const f = String(name == null ? '' : name)
    const p = String(prefix)
    if (!f.startsWith(p)) return false
    const rest = f.slice(p.length)
    if (rest === '' || /^[0-9]/.test(rest)) return false
    return isAudioFileName(f) && !isPartialFileName(f)
}

/**
 * 扫一次目录，得到「第几集 → 文件名」的索引。
 *
 * 为什么要索引而不是每集都 readdir：老实现是每一集都 `readdirSync` 一遍目录
 * （`findExistingTrack`），一本 2600 集的专辑就是 2600 次目录遍历；
 * 而补路径的老流程又是「每轮从第 1 集起逐条 walk」，实测 3.7 分钟只推进 56 集。
 * 扫一次建索引，整本专辑的对账/补路径都是 O(集数)。
 * 同号多个文件时严格写法优先（`0008.a.m4a` 胜过 `8标题.m4a`）。
 */
export function buildDiskIndex(targetDir, album) {
    const index = new Map()
    if (!targetDir || !fs.existsSync(targetDir)) return index
    let entries
    try {
        entries = fs.readdirSync(targetDir)
    } catch (e) {
        return index
    }
    const loose = new Map()
    for (const name of entries) {
        const m = /^([0-9]+)/.exec(name)
        if (!m) continue
        const prefix = m[1]
        const num = Number(prefix)
        if (trackFileNameMatches(name, prefix)) {
            if (!index.has(num)) index.set(num, name)
        } else if (trackFileNameMatchesLoose(name, prefix)) {
            if (!loose.has(num)) loose.set(num, name)
        }
    }
    for (const [num, name] of loose) {
        if (!index.has(num)) index.set(num, name)
    }
    return index
}

/**
 * `Content-Type` → 落盘扩展名。
 *
 * 为什么不能直接拿 content-type 的小段当后缀（老实现 `'.' + parts[1].replace('x-','')`）：
 *   - `audio/mpeg` 会落成 `.mpeg`，`audio/x-ms-wma` 会落成 `.ms-wma` —— 都不是音频后缀，
 *     扫库不认，下好的集永远显示欠着；
 *   - `audio/mp4` 落成 `.mp4` —— 就是《道诡异仙》那 42 集的由来；
 *   - content-type 缺失（`application/octet-stream`）会落成**空后缀**，同样是扫库不认。
 * 认不出来时退到下载链接上的后缀，再认不出来宁可给 `.m4a`（ABS 认），绝不给空后缀。
 */
const CONTENT_TYPE_EXT = {
    'audio/mp4': '.m4a',
    'audio/m4a': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/mp4a-latm': '.m4a',
    'audio/mp3': '.mp3',
    'audio/mpeg': '.mp3',
    'audio/mpeg3': '.mp3',
    'audio/x-mpeg': '.mp3',
    'audio/aac': '.aac',
    'audio/aacp': '.aac',
    'audio/flac': '.flac',
    'audio/x-flac': '.flac',
    'audio/ogg': '.ogg',
    'audio/opus': '.opus',
    'audio/wav': '.wav',
    'audio/wave': '.wav',
    'audio/x-wav': '.wav',
    'audio/wma': '.wma',
    'audio/x-ms-wma': '.wma',
    'video/mp4': '.mp4',
    'video/x-m4v': '.mp4',
}

export function normalizeAudioExtension(contentType, url) {
    const ct = String(contentType == null ? '' : contentType).split(';')[0].trim().toLowerCase()
    if (CONTENT_TYPE_EXT[ct]) return CONTENT_TYPE_EXT[ct]
    let fromUrl = ''
    try {
        const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(String(url)).pathname)
        if (m) fromUrl = '.' + m[1].toLowerCase()
    } catch (e) {
        // 不是完整 URL（相对路径/空值），忽略
    }
    if (fromUrl !== '' && isAudioFileName('x' + fromUrl)) return fromUrl
    return '.m4a'
}

/**
 * 目录里是否已经有这一集。
 *
 * 光看 DB 里的 path 不够：用户可能手工补过零、改过目录名，
 * 那样 DB 的记录就失效了，下载器会认为文件不存在而重下一遍。
 * 这里再按「序号前缀」在目录内兜一次底 —— 判据统一走上面的 AUDIO_EXT_RE，
 * 免得把封面图、半成品当成已下好的集。
 * @returns 命中的完整路径，没有则 null
 */
export function findExistingTrack(targetDir, num, album, entries) {
    if (!fs.existsSync(targetDir)) return null
    if (entries == null) {
        try {
            entries = fs.readdirSync(targetDir)
        } catch (e) {
            return null
        }
    }
    const prefixes = trackNumPrefixes(num, album)
    for (const p of prefixes) {
        const hit = entries.find(f => trackFileNameMatches(f, p))
        if (hit) return path.join(targetDir, hit)
    }
    // 严格写法没找到，再认一遍手改过名字的（`2551完结.m4a`）—— 不然会重下一份
    for (const p of prefixes) {
        const hit = entries.find(f => trackFileNameMatchesLoose(f, p))
        if (hit) return path.join(targetDir, hit)
    }
    return null
}
