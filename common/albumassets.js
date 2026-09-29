/**
 * 专辑的「附件」：封面 + 简介 + 主播。
 *
 * 为什么落成文件、而不是只改数据库：
 * Audiobookshelf 的规矩是「书目录里有图片文件就用它，没有才去音频文件的 ID3 里抠封面」
 * （官方 Book Library Structure），它另外还会读同目录下的 desc.txt（简介）与
 * reader.txt（主播）。所以往专辑目录里放这三样，扫库后就有封面和简介 ——
 * 不用碰音频、不用重下、也不吃付费取流的额度（封面是静态图 CDN，跟取流是两条路）。
 *
 * 三个文件一律「缺才写」：已存在且非空就不动。用户手工换过的封面 / 简介
 * 不该被平台上的旧内容覆盖回去；反过来说，已经下完的老专辑再跑一次
 * 就会自动把缺的补上，不需要任何按钮。
 */
import fs from 'fs'
import path from 'path'
import {iaxios} from './axioscf.js'
import {log} from './log4jscf.js'

/** ABS 认的图片文件；封面用这个名字 */
export const COVER_NAME = 'cover.jpg'

/** 平台给的封面地址是协议相对的 `//imagev2.xmcdn.com/...`，必须补上 https: */
export function normalizeUrl(u) {
    const s = String(u == null ? '' : u).trim()
    if (s === '') return ''
    if (s.startsWith('//')) return 'https:' + s
    if (/^https?:\/\//i.test(s)) return s
    if (s.startsWith('/')) return 'https://www.ximalaya.com' + s
    return ''
}

/** 存在且非空才算有 —— 0 字节的半截文件不能当已经补过 */
export function fileOk(p) {
    try {
        const st = fs.statSync(p)
        return st.isFile() && st.size > 0
    } catch (e) {
        return false
    }
}

const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
    hellip: '…', mdash: '—', ndash: '–', middot: '·', times: '×',
    laquo: '《', raquo: '》', bull: '•', copy: '©',
}

/**
 * 把 richIntro 的 HTML 变成 ABS 能读的纯文本。
 *
 * richIntro 里塞了 blockquote / p / 长图（那两张 简介.jpg 就是从这儿来的），
 * 长图里的文字抠不出来（是图片像素），所以正文文字可能比看着少些 —— 但这就是
 * 平台给的简介原文，ABS 也只认纯文本。
 */
export function htmlToText(html) {
    let s = String(html == null ? '' : html)
    if (s.trim() === '') return ''
    s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    s = s.replace(/<br\s*\/?>/gi, '\n')
    s = s.replace(/<\/(p|div|blockquote|li|h[1-6]|tr|section)>/gi, '\n')
    s = s.replace(/<[^>]*>/g, '')
    s = s.replace(/&#(\d+);/g, (m, d) => {
        try {
            return String.fromCodePoint(Number(d))
        } catch (e) {
            return m
        }
    })
    s = s.replace(/&#x([0-9a-fA-F]+);/g, (m, h) => {
        try {
            return String.fromCodePoint(parseInt(h, 16))
        } catch (e) {
            return m
        }
    })
    s = s.replace(/&([a-zA-Z]+);/g, (m, n) => {
        const v = ENTITIES[n.toLowerCase()]
        return v == null ? m : v
    })
    s = s.replace(/[ \t\u00a0]+/g, ' ')
    s = s.split('\n').map(l => l.trim()).join('\n')
    s = s.replace(/\n{3,}/g, '\n\n').trim()
    return s
}

/** 简介正文：richIntro 去标签优先，它空着才退回纯文本的 shortIntro */
export function descText(info = {}) {
    const rich = htmlToText(info.richIntro)
    if (rich) return rich
    return String(info.shortIntro == null ? '' : info.shortIntro).trim()
}

async function fetchCover(url) {
    const res = await iaxios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {Referer: 'https://www.ximalaya.com/'},
    })
    if (res.status !== 200 || res.data == null) {
        throw new Error(`HTTP ${res.status}`)
    }
    const buf = Buffer.from(res.data)
    // 风控页 / 404 也会是 200，只有几十字节 —— 太小的一律当没拿到
    if (buf.length < 1024) {
        throw new Error(`图片只有 ${buf.length} 字节，明显不对`)
    }
    return buf
}

/**
 * 给专辑目录补上封面/简介/主播。
 *
 * @param dir 专辑目录（不存在会建）
 * @param info getAlbum() 的返回值（含 coverUrl / richIntro / shortIntro / anchorName）
 * @returns {Promise<{cover:string, desc:string, reader:string}>}
 *          每个字段：written（这次写了）/ skip（本来就有）/ empty（平台没这字段）/ fail（下载失败）
 */
export async function writeAlbumAssets(dir, info = {}, opts = {}) {
    const out = {cover: 'skip', desc: 'skip', reader: 'skip'}
    if (!dir) return out
    try {
        fs.mkdirSync(dir, {recursive: true})
    } catch (e) {
        // 目录建不出来就没什么可写的了，交给上层记日志
        throw new Error(`建目录失败 ${dir}：${e.message}`)
    }
    const quiet = !!opts.quiet
    const say = m => {
        if (!quiet) log.info(m)
    }

    // ---- 封面
    const coverPath = path.join(dir, COVER_NAME)
    const coverUrl = normalizeUrl(info.coverUrl)
    if (fileOk(coverPath)) {
        out.cover = 'skip'
    } else if (coverUrl === '') {
        out.cover = 'empty'
    } else {
        try {
            const buf = await fetchCover(coverUrl)
            fs.writeFileSync(coverPath, buf)
            out.cover = 'written'
            say(`封面已保存：${path.basename(coverPath)}（${Math.round(buf.length / 1024)} KB）`)
        } catch (e) {
            out.cover = 'fail'
            log.warn(`封面没拿到（${coverUrl}）：${e.message}`)
        }
    }

    // ---- 简介
    const descPath = path.join(dir, 'desc.txt')
    if (fileOk(descPath)) {
        out.desc = 'skip'
    } else {
        const text = descText(info)
        if (text === '') {
            out.desc = 'empty'
        } else {
            fs.writeFileSync(descPath, text.endsWith('\n') ? text : text + '\n')
            out.desc = 'written'
            say(`简介已保存：desc.txt（${text.length} 字）`)
        }
    }

    // ---- 主播（ABS 读 reader.txt）
    const readerPath = path.join(dir, 'reader.txt')
    const anchor = String(info.anchorName == null ? '' : info.anchorName).trim()
    if (fileOk(readerPath)) {
        out.reader = 'skip'
    } else if (anchor === '') {
        out.reader = 'empty'
    } else {
        fs.writeFileSync(readerPath, anchor + '\n')
        out.reader = 'written'
        say(`主播已保存：reader.txt（${anchor}）`)
    }

    return out
}

/** 三个字段全是 skip 或 empty，就没什么可说的了（日志里不用每次都刷） */
export function assetSummary(out) {
    const label = {cover: '封面', desc: '简介', reader: '主播'}
    const done = []
    for (const k of ['cover', 'desc', 'reader']) {
        const v = out[k]
        if (v === 'written') done.push(label[k])
        else if (v === 'fail') done.push(label[k] + '(失败)')
    }
    return done.length ? done.join('、') : ''
}
