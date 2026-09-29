#!/usr/bin/env node
/**
 * `~` 展开只认开头那一个：Windows 8.3 短名（C:\Users\ADMINI~1\…）里也带 `~`，
 * 老实现 `s.replace('~', os.homedir())` 替换的是第一个 `~`，会把真实路径拼坏。
 */
import os from 'os'
import {expandHome} from '../common/config.js'

let pass = 0
let fail = 0
function eq(actual, expected, label) {
    if (actual === expected) {
        pass++
    } else {
        fail++
        console.log(`FAIL ${label}\n  actual   = ${JSON.stringify(actual)}\n  expected = ${JSON.stringify(expected)}`)
    }
}

const home = os.homedir()
const sep = process.platform === 'win32' ? '\\' : '/'

eq(expandHome('~'), home, '~ 单独一个')
eq(expandHome('~/.xmd'), home + '/.xmd', '~ 开头 + /')
eq(expandHome('~/Downloads'), home + '/Downloads', '~/Downloads')
if (process.platform === 'win32') {
    eq(expandHome('~\\.xmd'), home + '\\.xmd', '~ 开头 + 反斜杠')
}
// 回归：8.3 短名里的 ~ 不能被动
const short = `C:\\Users\\ADMINI~1\\AppData\\Local\\Temp`
eq(expandHome(short), short, '8.3 短名原样返回')
eq(expandHome('/vol1/1000/youshengshu'), '/vol1/1000/youshengshu', '绝对路径原样返回')
eq(expandHome('~foo/bar'), '~foo/bar', '~ 后面不是分隔符就不展开')
eq(expandHome('a~b/c'), 'a~b/c', '中间的 ~ 不展开')
eq(expandHome(''), '', '空串')
eq(expandHome(null), '', 'null 当空串')
eq(expandHome(`/downloads~${sep}sub`), `/downloads~${sep}sub`, '尾段里的 ~ 不展开')

console.log(fail === 0 ? `ALL PASS (${pass} 项断言)` : `FAILED (${pass} 通过 / ${fail} 失败)`)
process.exit(fail === 0 ? 0 : 1)
