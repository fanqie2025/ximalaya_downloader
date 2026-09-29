#!/usr/bin/env node
import {config, dbDirPath} from './common/config.js'
import pLimit from 'p-limit';
import {log} from './common/log4jscf.js'
import {trackDB} from './db/trackdb.js'
import {albumDB} from './db/albumdb.js'
import {program, InvalidArgumentError} from "commander"
import {AtomicInteger} from './common/AtomicInteger.js'
import {sleep} from './common/utils.js'
import {DownloaderFactory} from './handler/downloader.js'
import {
    albumDirName,
    findExistingTrack,
    loadAlbumMeta,
    trackFileName,
} from './common/naming.js'
import os from "os";
import fs from "fs";
import path from 'path'
import {mkdirpSync} from "mkdirp";
import {rimrafSync} from 'rimraf'

let taskCount = new AtomicInteger(0)
let finishCount = new AtomicInteger(0)

// 与 common 里的档位取值对应，仅用于启动时把生效设置打出来
const QUALITY_LABEL = {
    high: '高音质',
    standard: '标准',
    low: '省流量',
}

let emoji = '>'

async function printProgress(trackName, target, deviceType) {
    const downloaderName = `${deviceType == null ? '' : `(${deviceType})`}`
    if (trackName)
        log.info(`${downloaderName}下载成功${emoji.repeat(5)}进度:${await getProgress(finishCount, taskCount)}%(${await finishCount.get()}/${await taskCount.get()})---->${target}`)
    else {
        log.info(`${downloaderName}当前信息${emoji.repeat(5)}进度:${await getProgress(finishCount, taskCount)}%(${await finishCount.get()}/${await taskCount.get()})`)

    }
}

async function getProgress(finishCount, taskCount) {
    let _finishCount = await finishCount.get()
    let _taskCount = await taskCount.get()
    if (_taskCount == 0) {
        return 100
    }
    let n = _finishCount / _taskCount
    return (n * 100).toFixed(2)
}

function myParseInt(value, dummyPrevious) {
    // parseInt takes a string and a radix
    const parsedValue = parseInt(value, 10);
    if (isNaN(parsedValue)) {
        throw new InvalidArgumentError('Not a number.');
    }
    return parsedValue;
}

/** `~` 得展开成真实 home，否则会当成字面量建出个叫 ~ 的目录 */
function resolveOutput(p) {
    const s = String(p == null ? '' : p)
    return s.includes('~') ? s.replace('~', os.homedir()) : s
}

/**
 * 复查「进度库说下过、磁盘上却没有」的过期路径。
 *
 * 为什么必须有：主循环的查询条件是 `path: null` —— 也就是「有路径 = 已下载，永不再看」。
 * 只要路径失效（改过目录名，或像这次把本机进度库整体搬到容器：里面记的是
 * `G:\ximalayaxiazai\下载\...` 这种 Windows 路径），这些集就变成**幽灵记录**：
 * 进度把它算作已完成，磁盘上永远没有。实测搬到容器后第 1~35 集就这么整段消失了，
 * 而且因为进度数字看着在涨，完全不会有人察觉。
 *
 * 所以下载前先 stat 一遍：文件在 → 不动；文件没了但目录里按序号能找到 → 修正路径；
 * 真没了 → 置回 null 让它重新下。
 */
async function clearStalePaths(albumId, targetDir, album) {
    const records = await trackDB.find({albumId: albumId, path: {$ne: null}})
    let cleared = 0
    let repaired = 0
    for (const record of records) {
        if (fs.existsSync(record.path)) {
            continue
        }
        const existing = record.num == null ? null : findExistingTrack(targetDir, record.num, album)
        if (existing) {
            await trackDB.update({'trackId': record.trackId}, {'path': existing})
            repaired++
            continue
        }
        await trackDB.update({'trackId': record.trackId}, {'path': null})
        cleared++
    }
    if (repaired > 0) {
        log.info(`修正了 ${repaired} 条路径已变化的记录（文件还在，只是位置/名字不同）`)
    }
    if (cleared > 0) {
        log.warn(`有 ${cleared} 集的记录指向的文件已不存在（多为改过目录名或换了机器），`
            + `已标记为待重新下载`)
    }
    return cleared
}

async function download(factory, options, album, track, albumMeta) {
    // 已下载过就跳过。DB 里的 path 是权威判据，但用户手工补过零或改过目录名
    // 会让它失效，所以下面还有一层「按序号在目录里兜底」。
    if (track.path && fs.existsSync(track.path)) {
        return
    }
    const targetDir = path.join(resolveOutput(options.output), albumDirName(album, albumMeta))

    // 目录里已有这一集就把 DB 的路径补正，别重下一遍。
    // 这条分支专门用来收拾「补零/改目录名之后 DB 过期」的历史遗留。
    const existing = findExistingTrack(targetDir, track.num, album)
    if (existing) {
        await trackDB.update({'trackId': track.trackId}, {'path': existing})
        await finishCount.increment()
        await printProgress(track.title, existing, null)
        return
    }

    if (!fs.existsSync(targetDir)) {
        mkdirpSync(targetDir)
    }

    const {data, deviceType} = await factory.getDownloader(options.type, async downloader => {
        return {
            data: await downloader.download(track.trackId),
            deviceType: downloader.deviceType
        }
    })
    // 序号在这里就补好零，直接落成 ABS 认得的 0001.mp3 形态。
    // 事后再用脚本重命名是不行的 —— DB 里记的还是旧路径，
    // 下次跑会认为文件不存在而把整张专辑重下一遍。
    const filePath = path.join(targetDir, trackFileName(track, album, data.extension))
    fs.writeFileSync(filePath, data.buffer)
    await trackDB.update({'trackId': track.trackId}, {'path': filePath})
    await finishCount.increment()
    await printProgress(track.title, filePath, deviceType)
}


async function main() {
    log.info("欢迎使用 ximalaya_downloader！🎉")
    log.info("如果觉得棒棒哒，去 GitHub 给我们点个星星吧！🌟")
    log.info("GitHub 地址：https://github.com/844704781/ximalaya_downloader 💻")
    program
        .option('-a, --albumId <value>', 'albumId,必填')
        .option('-n, --concurrency <number>', '并发数,默认10', myParseInt)
        .option('-s, --slow', '慢速模式')
        .option('-t, --type <value>', '登录类型,可选值pc、web,默认都登陆(需要扫码多次)')
        .option('-r, --replace', '清除缓存,任务将重新下载')
        .option('--dry-run', '只检查登录态、专辑信息和目录命名，不实际下载')
        .option('-o, --output <value>', '当前要保存的目录,默认为~/Downloads', config.archives);

    program.parse(process.argv)
    const options = program.opts();
    const albumId = options.albumId
    if (albumId == null || albumId.trim() == '') {
        log.error("要输入 albumId 哦，尝试输入 node xmd.js --help 查看使用说明吧😞")
        return
    }
    if (options.replace) {
        log.info("清空缓存中...")
        // 清的是**共用**的进度库目录（dbDirPath），不是某个账号的凭据目录 ——
        // 多账号下 XMD_XMD_DIR 指向的是账号目录，那里没有 db。
        rimrafSync(path.join(dbDirPath(), 'db', 'file'))
    }
    log.info(`当前albumId:${options.albumId}`)
    log.info(`当前保存目录:${options.output}`)
    log.info(`音质档位:${QUALITY_LABEL[config.quality?.mode] || '自动（与官方一致）'}` +
        `　付费声音参数 trackQualityLevel=${config.quality?.paidLevel ?? 1}`)
    if (options.concurrency == null) {
        options.concurrency = 10
    }
    if (!options.slow) {
        emoji = '＞'
        log.warn(`${'🚀'.repeat(5)}当前为快速模式,很容易被官方大大踢屁屁哦`)
    } else {
        emoji = '>'
        options.concurrency = 1
        log.info(`${'🐢'.repeat(5)}当前为慢速模式`)
    }

    log.info(`并发数:${options.concurrency}`)
    const limit = pLimit(options.concurrency)

    const factory = DownloaderFactory.create()
    log.info("正在获取专辑信息")

    const albumResp = await factory.getDownloader(options.type, async (downloader) => {
        return await downloader.getAlbum(albumId)
    })

    log.info(`当前专辑:${albumResp.albumTitle},总章节数:${albumResp.trackCount}`)
    const albumMeta = loadAlbumMeta()
    log.info(`专辑目录名:${albumDirName(albumResp, albumMeta)}`)
    let album = await albumDB.findOne({"albumId": albumId})
    let needFlushTracks = true

    if (album == null) {
        album = {
            "albumId": albumId,
            "albumTitle": albumResp.albumTitle,
            // 主播要一起存下来 —— 目录名靠它，复用分支下由 albumResp 提供，
            // 新建分支漏了就会拼出「《X》」这种没主播的目录
            "anchorName": albumResp.anchorName,
            "isFinished": albumResp.isFinished,//0:不间断更新 1:连载中 2:完结
            "trackCount": albumResp.trackCount
        }
        await albumDB.insert(album)
    } else {
        // 顺手把标题和主播刷回库里。网页控制台要拿这两个字段显示，
        // 而老记录里可能压根没有 anchorName（那个字段是后来才补的，
        // 实测容器里这份专辑记录就是 null，页面上看着像缺主播）。
        const patch = {
            "isFinished": albumResp.isFinished,
            "trackCount": albumResp.trackCount,
        }
        if (albumResp.albumTitle) patch.albumTitle = albumResp.albumTitle
        if (albumResp.anchorName) patch.anchorName = albumResp.anchorName
        await albumDB.update({'albumId': albumId}, patch)
        album = albumResp
    }

    const iTrackCount = await trackDB.count({'albumId': albumId})
    if (album.trackCount == iTrackCount) {
        needFlushTracks = false
    }
    if (needFlushTracks) {
        let pageSize = 30
        let total = 1
        let num = 0
        log.info("正在获取章节列表")
        for (let pageNum = 1; pageNum <= total; pageNum++) {
            const book = await factory.getDownloader(options.type, async downloader => {
                return await downloader.getTracksList(albumId, pageNum, pageSize)
            })
            let trackTotalCount = book.trackTotalCount
            if (trackTotalCount === 0) {
                trackTotalCount = albumResp.trackCount
            }
            total = Math.floor(trackTotalCount / pageSize) + 1
            for (let index in book.tracks) {
                num++
                let track = book.tracks[index]
                const _track = await trackDB.findOne({'trackId': track.trackId})
                if (_track == null) {
                    await trackDB.insert({
                        "trackId": track.trackId,
                        "title": track.title,
                        "albumId": albumId,
                        "num": num,
                        "path": null
                    })
                }
                log.info(`获取章节列中,总章节数:${album.trackCount},当前位置:${num}------>${track.title}`)
            }
        }
        log.info("获取章节列表成功")
    }
    // 下载前先清掉过期路径。必须放在统计 taskCount/finishCount 之前，
    // 否则「已完成」的数字是虚的，进度条会一直显示得比实际好。
    await clearStalePaths(
        albumId,
        path.join(resolveOutput(options.output), albumDirName(album, albumMeta)),
        album)

    const condition = {"albumId": albumId, path: null}

    await taskCount.set(await trackDB.count({"albumId": albumId}))
    await finishCount.set(await trackDB.count({
        "albumId": albumId,
        "path": {
            $ne: null
        }
    }))
    await printProgress()
    if (await taskCount.get() == await finishCount.get()) {
        log.info("已经下载完成")
        return
    }
    if (options.dryRun) {
        log.info(`[试运行] 章节文件会写进：${path.join(resolveOutput(options.output), albumDirName(album, albumMeta))}`)
        log.info(`[试运行] 共 ${await taskCount.get()} 集，已下载 ${await finishCount.get()} 集，` +
            `待下载 ${await taskCount.get() - await finishCount.get()} 集`)
        log.info('[试运行] 未实际下载')
        return
    }
    log.info("数据加载中...️")
    while (true) {
        const tracks = await trackDB.find(condition, {"num": 1}, !options.slow ? options.concurrency * 2 : 1)
        if (tracks.length == 0) {
            log.info("已经下载完成")
            break
        }
        const promises = tracks.map(track =>
            limit(async () =>
                await download(factory, options, album, track, albumMeta)))
        await Promise.all(promises)
        if (options.slow) {
            await sleep(Math.floor(Math.random() * (5000 - 500 + 1)) + 500)
        }
    }
}

main()
