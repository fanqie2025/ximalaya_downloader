import fs from "fs";
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
  // 短试用尽后退避到次日哪个时刻（"HH:MM"，默认 00:05）。
  // 注意 coerce() 会把纯数字字符串转成 number，所以 scheduler 里取用时统一 String() 一遍。
  XMD_SCHEDULE_BACKOFF_AT: ['schedule', 'backoffAt'],
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
