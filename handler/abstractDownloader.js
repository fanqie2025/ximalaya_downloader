import {iaxios} from '../common/axioscf.js'
import {config} from '../common/config.js'
import {log} from '../common/log4jscf.js'
import {sleep, buildHeaders, parseCookies, addCookie, convertCookiesToString} from '../common/utils.js'
import {randomUUID} from 'crypto'
import path from "path";
import fs from "fs";
import {exec, spawn} from "child_process";
import kill from "tree-kill";
import {CustomError} from '../common/error.js'
import {getXmSign} from './core/xm-sign.js'
import os from 'os'

// www 域的 revision 接口已被 dws 风控接管，需要浏览器指纹算出的 xm-sign 才能访问，
// 命令行侧无法复刻，章节列表与播放地址改走无此校验的客户端接口
const MOBILE_BASE_URL = 'https://mobile.ximalaya.com'

/**
 * 下载抽象类
 */
class AbstractDownloader {
    constructor(deviceType, playDeviceType) {
        if (this.constructor == AbstractDownloader) {
            throw new Error("抽象类不能被实例化")
        }
        this.deviceType = deviceType
        // 付费声音接口按这个值决定密文用哪套算法加密，与 cookie 用的 deviceType 不是一回事
        this.playDeviceType = playDeviceType
        this.pcDeviceId = randomUUID()
        this.cookiePath = path.join(config.xmd.replace('~', os.homedir()), `${deviceType}-cookies.json`)
        this.qrCodePath = path.join(config.xmd.replace('~', os.homedir()), `${deviceType}-qrcode.png`);
        this.albumId = null
        this.cookies = null

    }

    /**
     * 获取可用的cookies
     * @private
     */
    _getCookies() {
        throw new Error("抽象方法，子类需要实现")
    }

    /**
     * 获取 cookies json格式
     * @returns {Promise<unknown>}
     * @private
     */
    async __readCookies() {
        const readFile = () => {
            return new Promise((resolve) => {
                return fs.readFile(this.cookiePath, (err, data) => {
                    if (err) {
                        return resolve(null)
                    }
                    return resolve(JSON.parse(String(data)))
                })
            })
        }
        return await readFile()
    }


    /**
     * 打开登录二维码
     * @param qrCodePath
     * @returns {ChildProcessWithoutNullStreams}
     */
    _openQrCode() {
        const platform = process.platform;
        let command;

        if (platform === 'win32') {
            command = `start ${this.qrCodePath}`;
        } else if (platform === 'darwin') {
            command = `open ${this.qrCodePath}`;
        } else if (platform === 'linux') {
            command = `xdg-open ${this.qrCodePath}`;
        }

        const openProcess = spawn(command, [], {shell: true});
        return openProcess;
    }

    /**
     * 关闭登录二维码
     * @param openProcess
     * @returns {Promise<unknown>}
     */
    _killQrCode(openProcess) {
        return new Promise((resolve, reject) => {
            if (process.platform == 'darwin') {
                exec(`osascript -e 'quit app "Preview"'`, (err) => {
                    if (err) {
                        log.error('Error closing the image viewer:', err);
                        return reject(err)
                    }
                    return resolve()
                });
            } else if (process.platform === 'win32') {
                // 使用 taskkill 命令终止进程
                exec(`taskkill /IM PhotosApp.exe /F`, (err) => {
                    if (err) {
                        log.error('Error closing the image viewer:', err);
                        return reject(err)
                    }
                    return resolve()
                });
            } else {
                kill(openProcess.pid, 'SIGKILL', (err) => {
                    if (err) {
                        log.error('Error closing the image viewer:', err);
                        return reject(err)
                    }
                    return resolve()
                })
            }
        })
    }

    /**
     * 获取登录二维码抽象方法
     * @returns {Promise<void>}
     * @private
     */
    async _getQrCode() {
        throw new Error("抽象方法，子类需要实现")
    }

    /**
     * 获取登录二维码
     * @returns {Promise<{qrId:int,img:str}>}
     */
    async __getQrCode(clientName) {
        const url = `${config.loginBaseUrl}/web/qrCode/gen?level=L&source=${encodeURIComponent(clientName)}`;
        const response = await iaxios.get(url)

        if (response.status != 200) {
            throw new Error('网络请求失败');
        }
        if (response.data == null) {
            throw new Error('数据为空');
        }
        if (response.data.ret != 0) {
            log.error("喜马拉雅内部异常", response.data)
            throw new Error("喜马拉雅内部异常")
        }
        return {
            qrId: response.data.qrId,
            img: response.data.img
        }; // 将响应数据解析为 JSON
    }


    /**
     * 登录方法
     * @returns {Promise<AbstractDownloader>}
     */
    async login() {
        // TODO 如果config中没有的cookies的话，就扫码获取
        let cookies = null
        if (config.cookie != null
            && config.cookie[this.deviceType] != null
            && config.cookie[this.deviceType]['serverMode']) {
            if (config.cookie[this.deviceType].value == null || config.cookie[this.deviceType].value.trim() == '') {
                throw new CustomError(`当前为非扫码模式，请在config.json中手动配置cookie.${this.deviceType}.value的值`)
            }
            cookies = parseCookies(config.cookie[this.deviceType].value.split(';'))
        } else {
            const qrCode = await this._getQrCode()
            const qrCodeBuffer = Buffer.from(qrCode.img, 'base64');

            fs.writeFileSync(this.qrCodePath, qrCodeBuffer);

            log.info(this.deviceType, "请使用喜马拉雅APP扫描登录二维码")
            const openProcess = this._openQrCode();
            //等待扫码
            log.info(this.deviceType, "等待登录结果...")
            while (true) {
                const loginResult = await this._getLoginResult(qrCode.qrId)
                if (loginResult.isSuccess) {
                    cookies = loginResult.cookies
                    break
                }
                await sleep(2000)
            }

            //处理登录成功
            try {
                await this._killQrCode(openProcess);
            } catch (e) {
                log.debug(e)
                log.info(this.deviceType, "扫码已成功，可自行关闭图片程序")
            }
        }
        fs.writeFileSync(this.cookiePath, Buffer.from(JSON.stringify(cookies)))
        log.info(this.deviceType, "登录成功")
        const user = await this._getCurrentUser()
        this._checkUser(user, false)
        return this
    }

    /**
     * 根据qrId，获取登录结果
     * @param qrId
     * @returns {Promise<{cookies: JSONObject, isSuccess: boolean}|{isSuccess: boolean}>}
     */
    async _getLoginResult(qrId) {
        const url = `${config.loginBaseUrl}/web/qrCode/check/${qrId}/${Date.now()}`;
        const response = await iaxios.get(url)

        if (response.status != 200) {
            throw new Error('网络请求失败');
        }
        if (response.data == null) {
            throw new Error('数据为空');
        }
        let isSuccess = false
        if (response.data.ret != 0) {
            return {
                isSuccess
            }
        }
        const cookieHeaders = response.headers['set-cookie'];
        const cookies = parseCookies(cookieHeaders)
        return {
            isSuccess: true,
            cookies: cookies
        };
    }

    async _getCurrentUser() {
        const url = `${config.baseUrl}/revision/main/getCurrentUser`
        const cookie = await this._getCookies()
        const headers = buildHeaders(config.baseUrl, cookie)
        const response = await iaxios.get(url, {headers: headers})
        if (response.status != 200) {
            throw new Error('网络请求失败');
        }
        if (response.data == null) {
            throw new Error('数据为空');
        }
        if (response.data.ret == 401) {
            log.error(response.data.msg)
            return null
        }
        if (response.data.ret != 200) {
            log.error("喜马拉雅内部异常", response.data)
            throw new Error("喜马拉雅内部异常")
        }
        return response.data.data; // 将响应数据解析为 JSON
    }

    /**
     * 检查用户账号信息
     * @param user
     */
    _checkUser(user, single) {
        if (user.isLoginBan) {
            log.warn("该用户被禁止登录")
        }
        if (!single) {
            log.info("用户名称:", user.nickname)
            log.info("是否vip:", user.isVip ? "是" : "否")
            log.info("vip剩余天数:", user.vipExpireTime)
            log.info("是否被检测为机器人:", "否")
        }
        if (user.isRobot) {
            log.warn("警告，被系统检测为机器人，请暂停下载稍后重试")
        }
    }

    async isLogin() {
        const cookies = await this._getCookies()
        if (cookies == null) {
            return false
        }
        const user = await this._getCurrentUser(cookies)
        if (user == null) {
            return false
        }
        return true
    }

    /**
     * 获取专辑简况
     * @param albumId
     * @param cookies
     * @returns {Promise<*>}
     */
    async _getAlbumSimple(albumId, cookie) {
        const url = `${config.baseUrl}/revision/album/v1/simple?albumId=${albumId}`
        const referer = `${config.baseUrl}/album/${albumId}`
        const headers = buildHeaders(referer, cookie)
        const response = await iaxios.get(url, {headers: headers})
        if (response.status != 200) {
            throw new Error('网络请求失败');
        }
        if (response.data == null) {
            throw new Error('数据为空');
        }
        if (response.data.ret != 200) {
            log.error("喜马拉雅内部异常", response.data)
            throw new Error("喜马拉雅内部异常")
        }
        return response.data.data;
    }


    /**
     * 获取专辑信息
     * @param albumId
     * @param cookies
     * @returns {Promise<*>}
     */
    async _getAlbumInfo(albumId, cookie) {
        const url = `${config.baseUrl}/tdk-web/seo/search/albumInfo?albumId=${albumId}`
        const referer = `${config.baseUrl}/album/${albumId}`
        const headers = buildHeaders(referer, cookie)
        const response = await iaxios.get(url, {headers: headers})
        if (response.status != 200) {
            throw new Error('网络请求失败');
        }
        if (response.data == null) {
            throw new Error('数据为空');
        }
        if (response.data.ret != 200) {
            log.error("喜马拉雅内部异常", response.data)
            throw new Error("喜马拉雅内部异常")
        }
        return response.data.data;
    }

    /**
     * 拿主播名。
     *
     * simple 接口的 albumPageMainInfo 里通常直接有 anchorName；缺失时退回
     * revision/album 的 anchorInfo.anchorName。
     *
     * 「作者」平台**不提供**，不在这里找：simple、tdk-web seo、m-revision
     * queryAlbumPage、专辑 HTML 页（全文搜 author 命中 0 次）、revision/album
     * 五路都测过，只有主播一个字段。要作者只能手工登记，见 common/naming.js。
     * @private
     */
    async _getAnchorName(albumId, simpleMain) {
        if (simpleMain && simpleMain.anchorName) {
            return String(simpleMain.anchorName)
        }
        try {
            const url = `${config.baseUrl}/revision/album?albumId=${albumId}`
            const referer = `${config.baseUrl}/album/${albumId}`
            const headers = buildHeaders(referer, await this._getCookies())
            const response = await iaxios.get(url, {headers: headers})
            const anchor = response && response.data && response.data.data &&
                response.data.data.anchorInfo
            if (anchor && anchor.anchorName) {
                return String(anchor.anchorName)
            }
        } catch (e) {
            log.debug('取主播名失败：', e.message)
        }
        return ''
    }

    /**
     * 获取专辑详情
     *
     * 顺带把封面地址和简介一起返回：它们本来就在上面这个 simple 响应里
     * （albumPageMainInfo.cover / richIntro / shortIntro），不取白不取 ——
     * 以前只挑走标题/主播/集数，这几样当场丢了，想补封面就得再请求一次。
     * @param albumId
     * @returns {Promise<{trackCount, albumTitle, isFinished, anchorName, coverUrl, richIntro, shortIntro}>}
     */
    async getAlbum(albumId) {
        if (albumId == null) {
            throw new Error("albumId不能为空")
        }
        const simple = await this._getAlbumSimple(albumId, await this._getCookies())
        const info = await this._getAlbumInfo(albumId, await this._getCookies())
        const book = await this.getTracksList(albumId, 1, 1)
        const main = simple['albumPageMainInfo'] || {}
        return {
            albumId: albumId,
            albumTitle: main['albumTitle'],
            isFinished: main['isFinished'],
            anchorName: await this._getAnchorName(albumId, main),
            trackCount: book.trackTotalCount,
            // 封面是协议相对的 //imagev2.xmcdn.com/...，落盘时由 common/albumassets.js 补 https:
            coverUrl: main['cover'] || '',
            // richIntro 是带 HTML 的长简介（长图也塞在里面），shortIntro 是纯文本短简介
            richIntro: main['richIntro'] || '',
            shortIntro: main['shortIntro'] || '',
        }
    }

    /**
     * 获取章节列表
     * @param albumId
     * @param pageNum
     * @param pageSize
     * @returns {Promise<*>}
     */
    async getTracksList(albumId, pageNum, pageSize) {
        const url = `${MOBILE_BASE_URL}/mobile/v1/album/track?albumId=${albumId}&device=android&isAsc=true&pageId=${pageNum}&pageSize=${pageSize}&source=0`
        const referer = `${config.baseUrl}/album/${albumId}`
        const headers = buildHeaders(referer, await this._getCookies())
        const response = await iaxios.get(url, {headers: headers})
        if (response.status != 200) {
            throw new Error('网络请求失败')
        }
        if (response.data == null) {
            throw new Error('数据为空')
        }
        if (response.data.ret == 924) {
            log.error(`专辑${albumId}在客户端渠道不可用，换个专辑试试`, response.data)
            throw new CustomError(924, "该专辑已下架或不支持客户端渠道")
        }
        if (response.data.ret != 0) {
            log.error("喜马拉雅内部异常", response.data)
            throw new Error("喜马拉雅内部异常")
        }
        const data = response.data.data
        return {
            trackTotalCount: data.totalCount,
            tracks: data.list.map(track => ({trackId: track.trackId, title: track.title}))
        }
    }

    /**
     * 获取音频数据
     * @param trackId
     * @returns {Promise<{trackTitle, playUrlList}>}
     * @private
     */
    async _getBaseInfo(trackId) {
        const url = `${MOBILE_BASE_URL}/mobile/v1/track/baseInfo/${Date.now()}?device=pc&trackId=${trackId}`
        const referer = `${config.baseUrl}/album/${trackId}`
        const headers = buildHeaders(referer, await this._getCookies())
        const response = await iaxios.get(url, {headers: headers})
        if (response.status != 200) {
            throw new Error('网络请求失败');
        }
        if (response.data == null) {
            throw new Error('数据为空');
        }
        if (response.data.ret == 999 || response.data.ret == 1001) {
            log.error(`${this.deviceType}端喜马拉雅接口内部异常`, response.data)
            throw new CustomError(999, `${this.deviceType}端速率限制`)
        }
        if (response.data.ret != 0) {
            log.error(`${this.deviceType}端喜马拉雅接口内部异常`, response.data)
            throw new Error("喜马拉雅内部异常")
        }
        const info = response.data
        const playUrl = this._pickFreePlayUrl(info)
        if (playUrl == null || playUrl == '') {
            // 付费声音这里只有时长和体积，地址要另走带签名的加密接口
            return {
                url: await this._getPaidPlayUrl(trackId),
                trackTitle: info.title
            }
        }
        return {
            url: playUrl,
            trackTitle: info.title
        }
    }

    /**
     * 付费声音专用 cookie：登录态 + 客户端设备身份
     *
     * 这几个设备 cookie 不能并到 _getCookies，章节列表接口按 device=android 请求，
     * 带上 win32 的设备标识会被判成参数矛盾直接拒掉
     * @returns {Promise<string>}
     */
    async _getPaidCookies() {
        const cookies = await this.__readCookies()
        addCookie(cookies, 'install_id', this.pcDeviceId)
        addCookie(cookies, '1&_device', `win32&${this.pcDeviceId}&4.0.14`)
        addCookie(cookies, 'channel', '99&100001')
        return convertCookiesToString(cookies)
    }

    /**
     * 获取付费声音的播放地址
     * @param trackId
     * @returns {Promise<string>}
     */
    async _getPaidPlayUrl(trackId) {
        const {xmSign, userAgent} = await getXmSign()
        const url = `${config.baseUrl}/mobile-playpage/track/v3/baseInfo/${Date.now()}?device=${this.playDeviceType}&trackId=${trackId}&trackQualityLevel=${this._paidLevel()}`
        const headers = buildHeaders(`${config.baseUrl}/`, await this._getPaidCookies())
        headers['User-Agent'] = userAgent
        headers['Origin'] = config.baseUrl
        headers['xm-sign'] = xmSign
        const response = await iaxios.get(url, {headers: headers})
        if (response.status != 200) {
            throw new Error('网络请求失败')
        }
        if (response.data == null) {
            throw new Error('数据为空')
        }
        if (response.data.ret != 0) {
            log.error(`${this.deviceType}端付费声音接口异常`, response.data)
            throw new CustomError(999, `${this.deviceType}端被风控或没有该声音的收听权限`)
        }
        const playUrlList = response.data.trackInfo.playUrlList
        if (playUrlList == null || playUrlList.length == 0) {
            throw new CustomError(403, `没有该声音的收听权限，需要VIP或已购买(trackId:${trackId})`)
        }
        return this._decrypt(this._playUrl(playUrlList).encodeText)
    }

    /**
     * 获取音频数据
     * @param url
     * @returns {Promise<*>}
     */
    async _getAudio(url) {
        if (url == null) {
            throw new Error("Invalid url")
        }
        let response = await iaxios({
            method: 'GET',
            url: url,
            responseType: 'arraybuffer',
        })
        if (response.status != 200) {
            throw new Error('网络请求失败');
        }
        if (response.data == null) {
            throw new Error('数据为空');
        }

        // 获取文件后缀函数
        function getFileExtension(contentType) {
            const parts = contentType.split('/');
            if (parts.length === 2) {
                return '.' + parts[1].replace("x-", "");
            }
            return '';
        }

        const contentType = response.headers['content-type'];
        const fileExtension = getFileExtension(contentType)

        return {
            buffer: response.data,
            extension: fileExtension
        }
    }

    /**
     * 音质档位：high | standard | low | auto
     * 默认 auto —— 与上游行为逐字一致（playPathHq 优先）。
     */
    _qualityMode() {
        const m = config.quality && config.quality.mode
        return (m === 'high' || m === 'standard' || m === 'low') ? m : 'auto'
    }

    /**
     * 付费声音的音质参数 trackQualityLevel。
     * 上游原值写死为 1，这里改成可配；取值语义平台未公开，故默认保持 1 不动。
     */
    _paidLevel() {
        const v = config.quality && config.quality.paidLevel
        return Number.isFinite(Number(v)) ? Number(v) : 1
    }

    /**
     * 免费声音的下载地址挑选。
     *
     * 平台对同一条声音给出多个档位字段，按所选档位改变优先顺序。
     * 关键：**任何一档缺失都继续往下一档回退**，所以不会因为选了个平台
     * 没提供的档位就拿不到地址。auto 一行与上游原写法完全等价。
     */
    _pickFreePlayUrl(info) {
        const chain = {
            high: [info.playPathHq, info.downloadUrl, info.playUrl64, info.playUrl32],
            standard: [info.playUrl64, info.playPathHq, info.downloadUrl, info.playUrl32],
            low: [info.playUrl32, info.playUrl64, info.playPathHq, info.downloadUrl],
            auto: [info.playPathHq, info.downloadUrl, info.playUrl64, info.playUrl32],
        }[this._qualityMode()]
        for (const u of chain) {
            if (u != null && u !== '') {
                return u
            }
        }
        return null
    }

    /**
     * 获取解密参数
     * @param t playUrlList
     * @returns {*}
     */
    _playUrl = (t) => {
        // 上游原逻辑恒取 t[0]。这里多加一层：列表里存在与目标档位相等的条目就选它，
        // 找不到则原样回退到 t[0] —— 行为不会比上游更差。
        const hit = Array.isArray(t)
            ? t.find(x => Number(x.qualityLevel) === Number(this._paidLevel()))
            : null
        const item = hit || t[0]
        return {
            qualityLevel: item.qualityLevel,
            encodeText: item.url
        }
    }

    /**
     * 解密
     * @param encodeText
     * @return url
     */
    _decrypt(encodeText) {
        throw new Error("抽象方法，子类需要实现")
    }


    /**
     * 下载音频
     * @param trackId
     * @returns {Promise<buffer, fileExtension>}
     */
    async download(trackId) {
        let user = await this._getCurrentUser()
        await this._checkUser(user, true)
        const baseInfo = await this._getBaseInfo(trackId)
        const data = await this._getAudio(baseInfo.url)
        return data
    }


}


export {
    AbstractDownloader
}


