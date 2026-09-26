/**
 * 单集端到端测试：走正式下载链路（DownloaderFactory → downloader.download），
 * 只下一个 trackId，用来验证「付费/ VIP 集」是否真能拿到音频字节。
 * 用法：node _one.js [trackId]
 */
import fs from 'fs'
import {DownloaderFactory} from './handler/downloader.js'

const trackId = Number(process.argv[2] || 171984073) // 该专辑第 36 集，属于 VIP 区间
const factory = DownloaderFactory.create()

const started = Date.now()
const {data, deviceType} = await factory.getDownloader(undefined, async downloader => ({
    data: await downloader.download(trackId),
    deviceType: downloader.deviceType
}))

const buf = data.buffer
console.log(`渠道: ${deviceType}`)
console.log(`扩展名: ${data.extension}`)
console.log(`字节数: ${buf.length} (${(buf.length / 1048576).toFixed(2)} MB)`)
console.log(`耗时: ${((Date.now() - started) / 1000).toFixed(1)}s`)
console.log(`头部字节: ${buf.subarray(0, 16).toString('hex')}`)
console.log(`ftyp 标记: ${buf.subarray(4, 8).toString('latin1')}  (m4a/mp4 应为 ftyp)`)

const out = `_one_test${data.extension}`
fs.writeFileSync(out, buf)
console.log(`已写入: ${out}`)
process.exit(0)
