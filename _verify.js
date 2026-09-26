/**
 * 补充验证：
 *  1) pc(mac) 渠道是否也能下付费集 —— 容器里两个渠道都会用
 *  2) 付费接口到底给了哪些音质档位、体量各多少 —— 用来判断 trackQualityLevel 是否真生效
 */
import {WebSiteDownloader} from './handler/webSiteDownloader.js'
import {DarwinDownloader} from './handler/darwinDownloader.js'
import {DownloaderFactory} from './handler/downloader.js'

const WHY = 171984073 // 该专辑第 36 集，VIP 区间

// ---- 1) pc 渠道 ----
const factory = DownloaderFactory.create()
try {
    const {data, deviceType} = await factory.getDownloader('pc', async d => ({
        data: await d.download(WHY), deviceType: d.deviceType
    }))
    console.log(`[pc 渠道] ${deviceType} 扩展名=${data.extension} 字节=${data.buffer.length} (${(data.buffer.length / 1048576).toFixed(2)} MB)`)
} catch (e) {
    console.log('[pc 渠道] 失败 ->', e.message)
}

// ---- 2) 音质档位 ----
const d = new WebSiteDownloader()
const orig = d._playUrl
d._playUrl = (list) => {
    console.log('[付费接口返回的档位]')
    for (const item of list) {
        const text = String(item.url || item.encodeText || '')
        console.log(`   qualityLevel=${item.qualityLevel}  type=${item.type || '-'}  fileSize=${item.fileSize}  url=${text.slice(0, 90)}`)
    }
    const picked = orig(list)
    console.log(`   >>> 本次选中 qualityLevel=${picked.qualityLevel}`)
    return picked
}
try {
    const info = await d._getBaseInfo(WHY)
    console.log('[最终地址]', String(info.url).slice(0, 110))
} catch (e) {
    console.log('[音质探测] 失败 ->', e.message)
}

// ---- 3) 对比一个免费集，看免费侧给了什么 ----
try {
    const free = await new WebSiteDownloader()._getBaseInfo(179700089)
    console.log('[免费集对照]', String(free.url).slice(0, 110))
} catch (e) {
    console.log('[免费集对照] 失败 ->', e.message)
}

process.exit(0)
