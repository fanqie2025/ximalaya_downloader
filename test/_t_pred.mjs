// 临时自测（workstream ①）：统一判据 isAudioFileName / isTrackFileName / normalizeAudioExtension
import fs from 'fs'
import os from 'os'
import path from 'path'
import assert from 'assert'
import {
    isAudioFileName,
    isPartialFileName,
    findExistingTrack,
    normalizeAudioExtension,
    PARTIAL_EXT,
} from '../common/naming.js'

let n = 0
const ok = (cond, msg) => { n++; assert.ok(cond, msg) }

// 1) 扩展名判据
ok(isAudioFileName('0686.上门龙婿650 大年初一.m4a'), 'm4a 认')
ok(isAudioFileName('0686.x.mp4'), 'mp4 必须认（同构 AAC，历史实害）')
ok(!isAudioFileName('0686.x.m4a.part'), '半成品不算音频')
ok(!isAudioFileName('cover.jpg'), '封面不算')
ok(!isAudioFileName('0686.x.txt'), '文本不算')
ok(isPartialFileName('0686.x.m4a' + PARTIAL_EXT), '半成品识别')

// 2) Content-Type → 落盘后缀
const cases = [
    ['audio/mp4', '.m4a'],
    ['audio/mpeg', '.mp3'],
    ['audio/mp3', '.mp3'],
    ['audio/x-m4a', '.m4a'],
    ['audio/x-ms-wma', '.wma'],
    ['audio/aac; charset=utf-8', '.aac'],
    ['video/mp4', '.mp4'],
    ['application/octet-stream', '.m4a'],
    [null, '.m4a'],
    ['', '.m4a'],
]
for (const [ct, want] of cases) {
    const got = normalizeAudioExtension(ct, '')
    ok(got === want, `content-type ${ct} → ${got}，期望 ${want}`)
}
ok(normalizeAudioExtension('application/octet-stream', 'https://x/y/123.mp3?p=1') === '.mp3',
    'content-type 认不出时退到链接后缀')
ok(normalizeAudioExtension('application/octet-stream', 'https://x/y/123.mpeg') === '.m4a',
    '链接后缀不在音频名单里也不给空后缀')

// 3) 目录兜底：mp4 算在、半成品与图片不算
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmdt-'))
const album = {trackCount: 1000}   // padWidth 4
fs.writeFileSync(path.join(dir, '0686.a.mp4'), 'x')
fs.writeFileSync(path.join(dir, '0687.b.m4a' + PARTIAL_EXT), 'x')
fs.writeFileSync(path.join(dir, '0688.c.jpg'), 'x')
fs.writeFileSync(path.join(dir, '0689.d.m4a'), 'x')
ok(path.basename(findExistingTrack(dir, 686, album)) === '0686.a.mp4', 'mp4 兜底命中')
ok(findExistingTrack(dir, 687, album) === null, '半成品不命中（会被重下）')
ok(findExistingTrack(dir, 688, album) === null, '图片不命中')
ok(path.basename(findExistingTrack(dir, 689, album)) === '0689.d.m4a', 'm4a 命中')
fs.rmSync(dir, {recursive: true, force: true})

// 4) 扫库计数也要认 mp4（library.js 现在走同一个判据）
const {scanLibrary} = await import('../common/library.js')
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'xmdl-'))
const book = path.join(dir2, '《测试书》某主播')
fs.mkdirSync(book)
fs.writeFileSync(path.join(book, '0001.a.mp4'), 'x')
fs.writeFileSync(path.join(book, '0002.b.m4a'), 'x')
fs.writeFileSync(path.join(book, '0003.c.m4a' + PARTIAL_EXT), 'x')
fs.writeFileSync(path.join(book, 'cover.jpg'), 'x')
const rows = scanLibrary(dir2, {force: true})
ok(rows.length === 1 && rows[0].audio === 2, `扫库音频数 = ${rows[0] && rows[0].audio}，期望 2（mp4 + m4a，半成品与封面不算）`)
fs.rmSync(dir2, {recursive: true, force: true})

console.log(`ALL PASS (${n} 项断言)`)
