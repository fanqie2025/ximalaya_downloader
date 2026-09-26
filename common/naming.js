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
 * 目录里是否已经有这一集。
 *
 * 光看 DB 里的 path 不够：用户可能手工补过零、改过目录名，
 * 那样 DB 的记录就失效了，下载器会认为文件不存在而重下一遍。
 * 这里再按「序号前缀」在目录内兜一次底。
 * @returns 命中的完整路径，没有则 null
 */
export function findExistingTrack(targetDir, num, album) {
    if (!fs.existsSync(targetDir)) return null
    const w = padWidth(album)
    const prefixes = []
    if (w > 0) prefixes.push(String(num).padStart(w, '0'))
    prefixes.push(String(num))
    let entries
    try {
        entries = fs.readdirSync(targetDir)
    } catch (e) {
        return null
    }
    for (const p of prefixes) {
        const hit = entries.find(f => f.startsWith(p + '.'))
        if (hit) return path.join(targetDir, hit)
    }
    return null
}
