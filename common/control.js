/**
 * 调度器的运行时状态 + 「可被打断的休眠」。
 *
 * 为什么单独抽出来：网页上的暂停 / 继续 / 立即跑一轮，都必须能**立刻**打断
 * 调度器那个动辄几小时的 sleep —— 裸 setTimeout 是叫不醒的，所以休眠留一个唤醒口。
 * 状态也集中放这儿，网页直接读，不用去问调度器要。
 */
const LOG_KEEP = 400

export const state = {
    startedAt: Date.now(),
    paused: false,
    // idle：没在干活（等下一轮 / 已暂停）｜planning：正在拉章节列表｜running：正在下 ｜sleeping：倒计时中
    phase: 'idle',
    round: 0,
    // 当前正在处理的专辑 id（无论哪个阶段）
    albumId: null,
    sleepUntil: null,
    sleepReason: '',
    // 正在下的那一集：{done, total, pct, title, at}
    current: null,
    // 上一轮结果：{ok, fail, minutes, at, aborted, downloaded}
    lastRound: null,
    // 退避状态：{stage, consecutiveFailures, maxRetries, retryMinutes, backoffAt}
    // stage: normal（正常周期）| short-retry（短试中）| backoff（已退避到次日）
    // 放这儿是为了让网页面板直接读得到，不用 ssh 去翻日志。
    sched: null,
    logTail: [],
}

let wakeFn = null
let sleepTimer = null
// 调度器把「怎么杀掉当前专辑子进程」注册进来，好让网页的暂停能立刻生效
let childKiller = null

/**
 * 注册中止当前专辑的方法。
 *
 * 网页点「暂停」时，光把 paused 置 true 是不够的：子进程是独立跑的，
 * 一张 1589 集的专辑按慢速模式要跑很久，用户点完按钮看着日志还在刷会以为没生效。
 * 所以暂停要顺手把当前专辑掐掉 —— 已下完的集在进度库里都有记录，恢复后自动续传，
 * 丢的只是当前这一集，代价可以接受。
 */
export function registerChildKiller(fn) {
    childKiller = fn
}

/** 中止当前专辑（没在跑就什么都不做） */
export function killCurrent() {
    if (childKiller) {
        try {
            childKiller()
        } catch (e) {
            // 掐不掉就算了，下一轮会自然停
        }
    }
}

function clearWaiter() {
    if (sleepTimer) {
        clearTimeout(sleepTimer)
        sleepTimer = null
    }
    wakeFn = null
}

/** 叫醒正在休眠的调度器（点「继续」「立即跑一轮」时调） */
export function wake() {
    const fn = wakeFn
    clearWaiter()
    state.sleepUntil = null
    state.sleepReason = ''
    if (fn) fn()
}

/**
 * 睡 ms 毫秒，但随时可能被 wake() 提前打断。
 *
 * @returns {Promise<boolean>} true = 被 wake() 提前叫醒，false = 正常睡满
 *
 * 注意别把 ms 设得太大：setTimeout 超过 2^31-1（约 24.8 天）会立刻触发，
 * 变成死循环刷日志。要「无限等」用 waitForWake()，别用大数字糊。
 */
export function sleepInterruptible(ms, reason = '') {
    return new Promise(resolve => {
        state.phase = 'sleeping'
        state.sleepUntil = Date.now() + ms
        state.sleepReason = reason
        wakeFn = () => {
            state.phase = 'idle'
            state.sleepUntil = null
            state.sleepReason = ''
            resolve(true)
        }
        sleepTimer = setTimeout(() => {
            state.sleepUntil = null
            state.sleepReason = ''
            clearWaiter()
            state.phase = 'idle'
            resolve(false)
        }, ms)
    })
}

/** 一直等到被叫醒（已暂停时用这个，别拿大数字去凑） */
export function waitForWake() {
    return new Promise(resolve => {
        state.phase = 'idle'
        wakeFn = () => resolve()
    })
}

/** 留最近若干行日志给页面看，多了就丢老的 */
export function pushLog(line) {
    state.logTail.push(line)
    if (state.logTail.length > LOG_KEEP) {
        state.logTail.splice(0, state.logTail.length - LOG_KEEP)
    }
}
