/**
 * 只登录，不下载。
 *
 * 上游的登录逻辑藏在「开始下载」这一步里，必须先给一个 albumId 才会触发扫码。
 * 这个脚本把它单独拎出来：跑一次、扫完码，凭据就落到 ~/.xmd/ 下，
 * 之后所有下载都直接复用，不用再扫。
 *
 * 用法：
 *   node login.js          # 同时登录 网页端 + 电脑版（扫两次码，吞吐更高）
 *   node login.js pc       # 只登录电脑版（扫一次码）
 *   node login.js web      # 只登录网页端（扫一次码）
 */
import {DownloaderFactory} from './handler/downloader.js'
import {log} from './common/log4jscf.js'

const type = process.argv[2] || null
if (type !== null && type !== 'pc' && type !== 'web') {
    log.error(`登录类型只能是 pc 或 web，收到：${type}`)
    process.exit(1)
}

log.info(`开始登录，类型：${type == null ? '网页端 + 电脑版' : type}`)
const factory = DownloaderFactory.create()
try {
    // getDownloader 内部会完成 _login，回调直接返回即可
    await factory.getDownloader(type, async () => true)
    log.info('登录完成，凭据已保存到 ~/.xmd/')
} catch (e) {
    log.error('登录失败：' + e.message)
    process.exit(1)
}
