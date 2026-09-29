import fs from "fs";
import os from "os";
import {projectRoot} from "../settings.js";

let _config = {
  "baseUrl": "https://www.ximalaya.com",
  "loginBaseUrl": "https://passport.ximalaya.com",
  "archives": "~/Downloads",
  "xmd": "~/.xmd",
  "cookie": {
    "www2": {
      "serverMode": false,
      "value": ""
    },
    "mac": {
      "serverMode": false,
      "value": ""
    }
  }
}
if (fs.existsSync(`${projectRoot}/config.json`)) {
  const configBuf = fs.readFileSync(`${projectRoot}/config.json`)
  _config = JSON.parse(String(configBuf))
}

// 本地附加设置单独放一个文件，别写进 config.json —— 上游更新时不易被覆盖。
// 目前承载：下载目录 archives、音质 quality、命名 naming。
if (fs.existsSync(`${projectRoot}/settings.local.json`)) {
  const localBuf = fs.readFileSync(`${projectRoot}/settings.local.json`)
  const local = JSON.parse(String(localBuf))
  _config = { ..._config, ...local }
}

/**
 * 环境变量覆盖，优先级最高。
 *
 * 为什么需要：同一个镜像要在本机（Windows，下载到 G:\...）和飞牛容器
 * （下载到挂载的 /downloads）两处跑，差异只在下载目录和调度参数上。
 * 为这点差异挂两份 settings.local.json 容易改漏，用环境变量注入更省事 ——
 * compose 里写死，代码不用动。
 */
const ENV_MAP = {
  XMD_ARCHIVES: ['archives'],
  XMD_XMD_DIR: ['xmd'],
  // 下载进度库（nedb 的 track.db / album.db）放在哪。
  // 多账号下它必须**全账号共用一份**：这张表就是「这集下过没有」的唯一依据，
  // 各账号各记一份的话，同一集会被每个账号各下一遍。不配就退回老行为（跟着 xmd 目录）。
  XMD_DB_DIR: ['dbDir'],
  XMD_QUALITY_MODE: ['quality', 'mode'],
  XMD_QUALITY_PAID_LEVEL: ['quality', 'paidLevel'],
  XMD_NAMING_TEMPLATE: ['naming', 'template'],
  XMD_NAMING_PAD_WIDTH: ['naming', 'padWidth'],
  XMD_SCHEDULE_ALBUMS_FILE: ['schedule', 'albumsFile'],
  XMD_SCHEDULE_INTERVAL_HOURS: ['schedule', 'intervalHours'],
  XMD_SCHEDULE_CONCURRENCY: ['schedule', 'concurrency'],
  XMD_SCHEDULE_SLOW: ['schedule', 'slow'],
  XMD_SCHEDULE_RUN_ON_START: ['schedule', 'runOnStart'],
  XMD_SCHEDULE_RETRY_MINUTES: ['schedule', 'retryMinutes'],
  XMD_SCHEDULE_MAX_RETRIES: ['schedule', 'maxRetries'],
  // 本轮有新增集数、但最后被挡（撞的是单轮上限）之后多久再来，默认 60 分钟；off/0 关掉。
  XMD_SCHEDULE_PROGRESS_RETRY_MINUTES: ['schedule', 'progressRetryMinutes'],
  // 短试用尽后退避到次日哪个时刻（"HH:MM"，默认 00:05）。
  // 注意 coerce() 会把纯数字字符串转成 number，所以 scheduler 里取用时统一 String() 一遍。
  XMD_SCHEDULE_BACKOFF_AT: ['schedule', 'backoffAt'],
  // 主动避让（2026-09-29）：单轮下满这么多集就主动停（**算成功**，不退避）；
  // 当天累计下满 dailyCap 集就睡到次日 backoffAt。都是 0 / off 关掉，退回「撞墙才收手」。
  XMD_SCHEDULE_MAX_PER_ROUND: ['schedule', 'maxPerRound'],
  XMD_SCHEDULE_DAILY_CAP: ['schedule', 'dailyCap'],
  // 多账号（2026-09-29）：逗号分隔的账号名，如 "default,bob"。
  //   default = 根 xmd 目录（老凭据不用搬）；其它名字 = <xmd>/accounts/<名字>/。
  // 不配就是单账号，行为和以前完全一样。上面那两个上限是**按账号各算一份**的。
  XMD_SCHEDULE_ACCOUNTS: ['schedule', 'accounts'],
  // 账号名单文件（2026-09-29 v7）：网页面板能加能删，运行时生效，不用重建容器。
  // 不配就是 config/accounts.txt；文件不存在时用上面那个 XMD_SCHEDULE_ACCOUNTS 播种。
  XMD_SCHEDULE_ACCOUNTS_FILE: ['schedule', 'accountsFile'],
  // DNS 兜底相关，见 common/dnsfix.js
  XMD_DNS_ENABLED: ['dns', 'enabled'],
  XMD_DNS_SERVERS: ['dns', 'servers'],
}

function coerce(raw) {
  const s = String(raw).trim()
  if (s === 'true') return true
  if (s === 'false') return false
  // 目录名模板可能长这样：《{title}》{anchor}，这里不能把纯数字字符串以外的东西转成数
  if (s !== '' && /^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  return s
}

function setDeep(obj, keys, raw) {
  let cur = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}
    cur = cur[k]
  }
  cur[keys[keys.length - 1]] = coerce(raw)
}

for (const [env, keys] of Object.entries(ENV_MAP)) {
  const raw = process.env[env]
  if (raw != null && raw !== '') {
    setDeep(_config, keys, raw)
  }
}

export const config = _config

/**
 * 下载进度库（nedb）所在目录。
 *
 * 为什么单独拎出来：多账号下每个账号有自己的凭据目录（XMD_XMD_DIR 指向
 * <xmd>/accounts/<名字>，cookie 和设备指纹都在里面），但「这集下过没有」这张表
 * 必须全局一份 —— 否则两个账号各自记各自，同一集会被下两遍。
 * 没配 XMD_DB_DIR 时退回老行为：就在 xmd 目录里（单账号完全不变）。
 */
/**
 * 展开路径开头的 `~`。
 *
 * 为什么不能整串 replace('~', …)：Windows 的 8.3 短名里就带 `~`
 * （os.tmpdir() 在 Windows 上会给出 `C:\Users\ADMINI~1\…`），一刀切替换会把它
 * 拼成 `C:\Users\Administrator…1\…` 这种不存在的路径。只认开头的 `~`，
 * 且只认紧跟着分隔符（或就是一个 `~`）的那些。
 */
export function expandHome(p) {
    const s = String(p == null ? '' : p)
    if (s === '~') return os.homedir()
    const m = /^~([/\\])(.*)$/.exec(s)
    return m ? os.homedir() + m[1] + m[2] : s
}

export function dbDirPath() {
    const p = config.dbDir || config.xmd || '~/.xmd'
    return expandHome(p)
}
