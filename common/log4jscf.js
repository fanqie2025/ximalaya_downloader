import log4js from 'log4js'

/**
 * 账号标签（2026-09-30，多账号之后加的）。
 *
 * 为什么要它：多账号跑起来之后，日志里两个账号的行是**交错**刷的 ——
 * 轮次分隔线（`第 1 轮（账号 bob）…`）只在开头出现一次，往下翻几十屏之后
 * 看到一条 `ret: 1001`，根本认不出是哪个账号撞的墙（v9 那套「撞墙换账号」的日志
 * 尤其需要这个：换号前后两条错误紧挨着，却分属两个账号）。
 *
 * 做法：调度器 spawn 子进程时塞 `XMD_ACCOUNT=<账号名>`（见 scheduler.js 的 accountEnv），
 * 这里把它做成**每一行的前缀**，于是下载器的所有输出（成功 / 限流 / 报错 / 登录）都自带账号：
 *
 *   [2026-09-30T21:03:47.164] [INFO] [账号 bob] app - (www2)下载成功>>>>>进度:...
 *
 * 没有这个环境变量时（手工跑 xmd.js / web.js / 各种脚本）照旧不加前缀，格式和以前一模一样。
 * token 是**每次写日志时才求值**的，所以同一个进程里改 env 也能立刻生效。
 */
const accountToken = () => {
    const name = String(process.env.XMD_ACCOUNT || '').trim()
    return name ? `[账号 ${name}] ` : ''
}

// 沿用 log4js 默认 basicLayout 的格式（`[时间] [级别] 类别 - 消息`），只在类别前插账号标签。
// ⚠️ 时间格式别改：skill 里清点额度用的是 `grep -oaE '2026-09-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'` + mktime。
const layout = {
    type: 'pattern',
    pattern: '[%d{yyyy-MM-ddThh:mm:ss.SSS}] [%p] %x{account}%c - %m',
    tokens: {account: accountToken},
}

log4js.configure({
    appenders: {
        // 加轮转：容器是无人值守长跑的，日志不封顶迟早把飞牛的盘写满
        file: {
            type: 'file',
            filename: 'logs/app.log',
            maxLogSize: 10 * 1024 * 1024,
            backups: 5,
            compress: true,
            layout,
        },
        console: {type: 'console', layout}
    },
    categories: {
        default: {appenders: ['file', 'console'], level: 'info'}
    }
});

export const log = log4js.getLogger('app')
