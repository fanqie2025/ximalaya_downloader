/**
 * 子进程日志行的解析（2026-09-30 从 scheduler.js 抽出来，附单测）。
 *
 * 为什么单独一层：调度器要拿子进程的日志算出「本专辑下到第几集了」给网页看，
 * 而从中抽数字的规则很容易踩坑 —— 日志里能匹配 `进度:` 的行不止一种。
 * 摘成纯函数（输入一行字符串，输出结构化结果）后，这些规则可以直接喂样本测，
 * 不用真起下载进程。
 *
 * 进度行长这样：
 *   (web)下载成功＞＞＞＞＞进度:12.34%(196/1589)---->/downloads/《书名》主播 作者/0001.mp3
 * 但也可能是（专辑已下完时每轮都会打一行，没有「下载成功」）：
 *   当前信息>>>>>进度:100%(1589/1589)---->/downloads/《书名》…/1589.mp3
 */

// 进度行：百分比 + 「已完成/总数」。注意 `\d+` 而不是 `\d+\.?\d*`，
// 括号里那对数字是集数，不会带小数点。
export const RE_PROGRESS = /进度:([\d.]+)%\((\d+)\/(\d+)\)/
// 进度行尾部的目标文件名（可省 —— 有些行只报进度不带路径）
export const RE_TARGET = /---->(.+)$/
// 首次拉章节列表时逐集刷的行，量大（1589 集），只用来推阶段、不进页面日志
export const CHAPTER_LIST_MARK = '获取章节列'
// 只有带这三个字的进度行才算「真下到了一集」
export const SUCCESS_MARK = '下载成功'

/**
 * 解析子进程的一行日志。
 *
 * @param {string} line
 * @returns {{blank: boolean, chapterList: boolean, succeeded: boolean,
 *            progress: {pct: number, done: number, total: number} | null,
 *            target: string | null}}
 *   - blank：空行/纯空白（调用方直接忽略）
 *   - chapterList：章节列表刷屏行（调用方只拿它推阶段，不进日志面板）
 *   - succeeded：这一行是「下载成功」的进度行（调用方据此给本轮集数 +1）
 *   - progress：解析出的进度（无则 null）
 *   - target：尾部路径（已 trim，未取 basename —— 那是调用方的事）
 */
export function parseChildLine(line) {
    const raw = line == null ? '' : String(line)
    const out = {blank: false, chapterList: false, succeeded: false, progress: null, target: null}
    if (raw.trim() === '') {
        out.blank = true
        return out
    }
    if (raw.includes(CHAPTER_LIST_MARK)) {
        out.chapterList = true
        return out
    }
    const p = raw.match(RE_PROGRESS)
    if (p) {
        out.progress = {pct: Number(p[1]), done: Number(p[2]), total: Number(p[3])}
        const t = raw.match(RE_TARGET)
        out.target = t ? t[1].trim() : null
        out.succeeded = raw.includes(SUCCESS_MARK)
    }
    return out
}
