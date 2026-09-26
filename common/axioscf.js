import axios from 'axios'
import axiosRetry from "axios-retry"
import {httpAgent, httpsAgent, stripProxyEnv} from './dnsfix.js'
import {log} from './log4jscf.js'

// 网络层统一兜底，两件事都放在这里，避免每个入口各清一遍（原文见 common/dnsfix.js）：
//   1. 清掉 shell 继承的代理变量 —— 否则请求退化成明文发 443，报 400 像风控
//   2. 挂上带 DNS 兜底的 agent —— 系统解析拿不到可用地址时自动换公共 DNS
const strippedProxy = stripProxyEnv()
if (strippedProxy.length) {
    log.debug(`已忽略 shell 代理设置 ${strippedProxy.join(',')}（境内直连；如需保留请设 XMD_KEEP_PROXY=1）`)
}
axios.defaults.httpAgent = httpAgent()
axios.defaults.httpsAgent = httpsAgent()

axiosRetry(axios, {
    retries: 3,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error) => {
        return error.code === 'ETIMEDOUT';
    }
});

export const iaxios = axios