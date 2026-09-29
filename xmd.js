#!/usr/bin/env node
import {config, dbDirPath, expandHome} from './common/config.js'
import pLimit from 'p-limit';
import {log} from './common/log4jscf.js'
import {trackDB} from './db/trackdb.js'
import {albumDB} from './db/albumdb.js'
import {program, InvalidArgumentError} from "commander"
import {AtomicInteger} from './common/AtomicInteger.js'
import {sleep} from './common/utils.js'
import {DownloaderFactory} from './handler/downloader.js'
import {
    buildDiskIndex,
    findExistingTrack,
    loadAlbumMeta,
    PARTIAL_EXT,
    trackFileName,
} from './common/naming.js'
import {assetSummary, writeAlbumAssets} from './common/albumassets.js'
import {readIgnore, resolveAlbumDir, writeIgnore, writeSidecar} from './common/library.js'
import {pendingQuery, selfHealAlbum, syncIgnoreMarks} from './common/dbselfheal.js'
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
    return expandHome(p)
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
    // 目录只扫一次，后面按集号查索引 —— 老实现是每查一集 readdirSync 一遍目录，
    // 2600 集的专辑就是 2600 次目录遍历。
    const onDisk = buildDiskIndex(targetDir, album)
    const records = await trackDB.find({albumId: albumId, path: {$ne: null}})
    let cleared = 0
    let repaired = 0
    for (const record of records) {
        // 用户标记「这几集不要」的直接放过：文件在不在都不管，更不能因为文件没了
        // 就把它置回 path: null（那正是「删了又自己回来」的成因）。
        if (record.skip === true) {
            continue
        }
        if (fs.existsSync(record.path)) {
            continue
        }
        const name = record.num == null ? null : onDisk.get(record.num)
        if (name) {
            await trackDB.update({'trackId': record.trackId}, {'path': path.join(targetDir, name)})
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

async function download(factory, options, album, track, targetDir) {
    // 已下载过就跳过。DB 里的 path 是权威判据，但用户手工补过零或改过目录名
    // 会让它失效，所以下面还有一层「按序号在目录里兜底」。
    if (track.path && fs.existsSync(track.path)) {
        return
    }

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
    // 先写 `.part` 再改名（同目录内 rename 是原子的）。
    // 直接写正式名字的话，进程在下到一半时被杀（暂停、额度满、重启、OOM）会留下半截文件，
    // 而下一轮 findExistingTrack 会按序号前缀认下它 —— 于是这集永远是个坏的、还不会被重下。
    // 半成品在统一判据（common/naming.js 的 isPartialFileName）里不算「已经有了」。
    const partPath = filePath + PARTIAL_EXT
    fs.writeFileSync(partPath, data.buffer)
    fs.renameSync(partPath, filePath)
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
        .option('--audit', '只对账进度库与磁盘（顺带自愈），打印报告后退出，不下载')
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
    // 目录名不能只靠 albumDirName 算：用户手工改过目录名就会算出一个不存在的名字，
    // 老实现会另建空目录把这本从头下一遍（实测《道诡异仙》重下了 56 集）。
    // resolveAlbumDir 先找带同一 albumId sidecar 的兄弟目录。
    const dirInfo = resolveAlbumDir(resolveOutput(options.output), albumResp, albumMeta)
    const targetDir = dirInfo.dir
    if (dirInfo.reused) {
        log.warn(`算出来的目录名是「${dirInfo.canonicalName}」，但磁盘上已有同一张专辑的目录`
            + `「${dirInfo.name}」（${dirInfo.audio} 集）—— 沿用已有目录，不另建、不重下`)
    }
    log.info(`专辑目录名:${dirInfo.name}`)

    // 封面 / 简介 / 主播：顺手存进专辑目录。
    // ABS 的规矩是「书目录里有图片就用它，没有才去音频 ID3 里抠封面」，另外它读
    // desc.txt（简介）与 reader.txt（主播）—— 所以这三样落盘就够了，不用碰音频。
    // 位置很讲究：必须放在下面「已经下载完成就直接 return」之前 —— 已经下完的
    // 专辑再跑一次时，正好把当年缺的封面/简介补上（不是每次都要重下才补）。
    if (!options.dryRun) {
        try {
            writeSidecar(targetDir, albumResp)
            const assets = await writeAlbumAssets(targetDir, albumResp)
            const sum = assetSummary(assets)
            log.info(sum === '' ? '封面/简介/主播都已存在，跳过' : `已补上：${sum}`)
        } catch (e) {
            // 补附件失败绝不能影响下载本身
            log.warn(`补封面/简介失败（不影响下载）：${e.message}`)
        }
    }
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

    // 判「章节列表要不要重新拉」得按**不同集号**数，不能按记录条数：
    // 实测 33476331 有 58 组同集号重复记录，条数永远比 trackCount 多，
    // 于是每轮都重新拉一遍章节列表（2625 集、每页 30，就是 88 个请求）。
    const existingTracks = await trackDB.find({'albumId': albumId}, {'num': 1})
    const distinctNums = new Set(existingTracks.map(t => t.num)).size
    if (album.trackCount == distinctNums) {
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
    await clearStalePaths(albumId, targetDir, album)

    // 单集忽略：面板在专辑目录里写下的 `.xmd-ignore.json`（那几集我不要）。
    // 必须在这里落地成进度库的 skip 标记 —— 主循环查的是 `pendingQuery()`，
    // 标了的集就不会再被下载，删掉也不会自己回来。写者仍然是本进程（面板只写文件，
    // 不碰 track.db），所以不用担心两边同时开库互相覆盖。
    const ignoreSpec = readIgnore(targetDir)
    const ignoreSync = await syncIgnoreMarks(albumId, targetDir, album, ignoreSpec)
    if (ignoreSync.marked > 0 || ignoreSync.cleared > 0) {
        log.info(`单集忽略：标记 ${ignoreSync.marked} 集、解除 ${ignoreSync.cleared} 集`
            + `（共忽略 ${ignoreSync.matched.length} 集，其中 ${ignoreSync.resolved.length} 集磁盘上没有）`)
    }
    if (ignoreSpec != null) {
        const changed = JSON.stringify(ignoreSpec.resolved.slice().sort((a, b) => a - b))
            !== JSON.stringify(ignoreSync.resolved)
        if (changed) {
            // 把解析结果写回规则文件：面板据此把「还差 N 集」算准（只扣磁盘上真没有的）
            writeIgnore(targetDir, {
                nums: ignoreSpec.nums,
                patterns: ignoreSpec.patterns,
                reason: ignoreSpec.reason,
                resolved: ignoreSync.resolved,
            })
            log.info(`单集忽略：已忽略 ${ignoreSync.resolved.length} 集`
                + (ignoreSync.resolved.length > 0 ? `（${ignoreSync.resolved.slice(0, 30).join(',')}`
                    + `${ignoreSync.resolved.length > 30 ? ' …' : ''}）` : ''))
        }
    }

    // 进度库自愈：老库书（文件都在磁盘上、进度库里却没有记录或记着 null）在这一步
    // 一次性认下来。不做这一步，主循环会从第 1 集起逐条 walk 着补路径 ——
    // 实测 3.7 分钟只推进 56 集，一本 1300 集的专辑要二十多轮才认完。
    const healed = await selfHealAlbum(albumId, targetDir, album, {apply: !options.dryRun})
    if (healed.backfill.marked > 0) {
        log.info(`进度库补齐 ${healed.backfill.marked} 集路径（磁盘上已有，不会重下），`
            + `仍缺 ${healed.backfill.stillMissing} 集`)
    }
    if (healed.dedupe.removed > 0) {
        log.info(healed.dedupe.applied
            ? `清理了 ${healed.dedupe.removed} 条同集号重复记录（${healed.dedupe.groups} 组）`
            : `[试运行] 发现 ${healed.dedupe.removed} 条同集号重复记录（${healed.dedupe.groups} 组）`)
    }
    log.info(`进度库对账：${healed.audit.rows} 条记录 / ${healed.audit.distinctNums} 个集号，`
        + `磁盘 ${healed.audit.onDiskFiles} 集，真缺 ${healed.audit.missingOnDisk} 集`
        + (healed.audit.ghostPaths > 0 ? `，幽灵路径 ${healed.audit.ghostPaths} 条` : '')
        + (healed.audit.skipped > 0 ? `，已忽略 ${healed.audit.skipped} 集` : ''))
    if (options.audit) {
        log.info(`[对账] ${JSON.stringify(healed.audit)}`)
        return
    }

    // 待下载查询只此一处定义（`skip: {$ne: true}` 就在 pendingQuery 里）——
    // 主循环、目录自愈、对账三处共用，免得哪一处漏掉 skip 把忽略的集又下回来。
    const condition = pendingQuery(albumId)

    // 被忽略的集既不算「要下」，也不算「已完成」—— 否则「已经下载完成」这条
    // 早退永远走不到（用户忽略的那几集永远补不上）。
    await taskCount.set(await trackDB.count({"albumId": albumId, "skip": {"$ne": true}}))
    await finishCount.set(await trackDB.count({
        "albumId": albumId,
        "skip": {"$ne": true},
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
        log.info(`[试运行] 章节文件会写进：${targetDir}`)
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
                await download(factory, options, album, track, targetDir)))
        await Promise.all(promises)
        if (options.slow) {
            await sleep(Math.floor(Math.random() * (5000 - 500 + 1)) + 500)
        }
    }
}

main()
