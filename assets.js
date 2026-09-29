#!/usr/bin/env node
/**
 * 给一张专辑的目录补封面 / 简介 / 主播。
 *
 * 为什么要单独一个子进程：`config.xmd`（凭据目录）是进程启动时定死的，
 * 多账号下必须靠 XMD_XMD_DIR 指过去 —— 这跟 probe-account.js 是同一个道理。
 * 调度器每轮的「补全已下好的书」用它，网页上「绑定专辑」也用它。
 *
 * 用法：
 *   XMD_XMD_DIR=<账号目录> XMD_DB_DIR=<共用目录> node assets.js <albumId> <目标目录>
 *
 * 输出：人看的日志走 log4js（父进程转进 app.log），最后一行是机器可读的
 *   XMD_ASSETS={"ok":true,"albumId":"...","cover":"written","desc":"written","reader":"skip"}
 */
import {DownloaderFactory} from './handler/downloader.js'
import {log} from './common/log4jscf.js'
import {assetSummary, writeAlbumAssets} from './common/albumassets.js'
import {writeSidecar} from './common/library.js'

const albumId = String(process.argv[2] == null ? '' : process.argv[2]).trim()
const targetDir = String(process.argv[3] == null ? '' : process.argv[3]).trim()

function finish(obj, code) {
    console.log('XMD_ASSETS=' + JSON.stringify(obj))
    process.exit(code)
}

if (albumId === '' || targetDir === '') {
    log.error('用法：node assets.js <albumId> <目标目录>')
    finish({ok: false, error: '参数不全'}, 2)
}

try {
    const factory = DownloaderFactory.create()
    const album = await factory.getDownloader(null, async d => await d.getAlbum(albumId))
    log.info(`专辑《${album.albumTitle}》主播 ${album.anchorName || '(未知)'}　目录：${targetDir}`)
    log.info(`封面地址：${album.coverUrl || '(平台没给)'}`)
    // sidecar 先写：就算封面下载失败，下次扫库也知道这个目录是哪张专辑
    writeSidecar(targetDir, album)
    const out = await writeAlbumAssets(targetDir, album)
    const sum = assetSummary(out)
    log.info(sum === '' ? '封面/简介/主播都已存在，无需补' : `本次补上：${sum}`)
    finish({ok: true, albumId, albumTitle: album.albumTitle, ...out}, 0)
} catch (e) {
    log.error(`补封面/简介失败：${e.message}`)
    finish({ok: false, error: e.message}, 1)
}
