/**
 * 诊断：DownloaderFactory.getDownloader 会把真实异常吞掉，
 * 一律报「所有下载方式都受限了」。这里逐个环节直接调用，把真实错误打出来。
 * 用法：node _diag.js [web|pc]
 */
import {WebSiteDownloader} from './handler/webSiteDownloader.js'
import {DarwinDownloader} from './handler/darwinDownloader.js'
import {trackDB} from './db/trackdb.js'
import {config} from './common/config.js'

const which = process.argv[2] || 'web'
const d = which === 'web' ? new WebSiteDownloader() : new DarwinDownloader()

console.log(`===== ${d.deviceType} 诊断 =====`)
console.log('cwd:', process.cwd())
console.log('config.xmd:', config.xmd, '| archives:', config.archives)
console.log('homedir:', (await import('os')).homedir())
console.log('cookiePath:', d.cookiePath)

// 1) 能不能拿到 cookie 串
try {
    const cookies = await d._getCookies()
    const s = String(cookies || '')
    console.log(`[1] _getCookies ok，长度 ${s.length}`)
    // 只显示 cookie 名，值打码
    console.log('    ' + s.split('; ').map(p => p.split('=')[0]).join(', '))
} catch (e) {
    console.log('[1] !! _getCookies 失败:', e && e.stack || e)
}

// 2) 登录态
try {
    const u = await d._getCurrentUser()
    if (u == null) {
        console.log('[2] !! getCurrentUser 返回 null —— 凭据失效或被拒')
    } else {
        console.log('[2] getCurrentUser ok:', JSON.stringify({
            nickname: u.nickname, isVip: u.isVip, isRobot: u.isRobot,
            isLoginBan: u.isLoginBan, vipExpireTime: u.vipExpireTime,
        }))
    }
} catch (e) {
    console.log('[2] !! _getCurrentUser 失败:', e && e.stack || e)
}

// 3) 取一条待下载的声音，看基础信息
try {
    const rows = await trackDB.find({albumId: '22216262', path: null}, {num: 1}, 1)
    if (rows.length === 0) {
        console.log('[3] 没有待下载的 track')
    } else {
        const t = rows[0]
        console.log(`[3] 试 trackId=${t.trackId} num=${t.num}`)
        try {
            const info = await d._getBaseInfo(t.trackId)
            console.log('[3] _getBaseInfo ok，地址:', String(info.url).slice(0, 100))
        } catch (e) {
            console.log('[3] !! _getBaseInfo 失败:', e && e.stack || e)
        }
    }
} catch (e) {
    console.log('[3] !! 读 trackDB 失败:', e && e.stack || e)
}

process.exit(0)
