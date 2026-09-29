#!/usr/bin/env node
/**
 * 面板前端的检查。
 *
 * 为什么需要：前端 JS 原来塞在 web.js 的 `const PAGE = String.raw`…`` 模板字符串里，
 * `node --check web.js` 只检查「怎么拼字符串」，看不见里面的前端代码 —— 一个手滑的
 * 括号都能一路部署到线上，直到有人打开面板才发现白屏。现在前端是真实文件
 * （panel/app.js），这个脚本负责：
 *   1. panel/index.html 确实外链 panel/app.js，且没有残留的内联 <script> 块；
 *   2. panel/app.js 能通过经 vm 编译（等价于浏览器第一步解析）；
 *   3. web.js 确实按请求读盘、又把 /panel/app.js 挂出去了，且没有再把整页塞回模板字符串。
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import {fileURLToPath} from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0
function ok(cond, label, extra) {
    if (cond) {
        pass++
    } else {
        fail++
        console.log(`FAIL ${label}${extra ? '\n  ' + extra : ''}`)
    }
}

const html = fs.readFileSync(path.join(here, '..', 'panel', 'index.html'), 'utf-8')
const js = fs.readFileSync(path.join(here, '..', 'panel', 'app.js'), 'utf-8')
const web = fs.readFileSync(path.join(here, '..', 'web.js'), 'utf-8')

ok(html.includes('<script src="/panel/app.js"></script>'), 'index.html 外链 /panel/app.js')
ok((html.match(/<script/g) || []).length === 1, 'index.html 只有一个 <script> 标签',
    `实际 ${(html.match(/<script/g) || []).length} 个`)
ok(!/<script>/.test(html), 'index.html 没有内联 <script> 正文块')
ok(html.includes('<style>') && html.includes('</html>'), 'index.html 结构完整（含 <style> 与 </html>）')

let compiled = false
let err = ''
try {
    new vm.Script(js, {filename: 'panel/app.js'})
    compiled = true
} catch (e) {
    err = String(e && e.message)
}
ok(compiled, 'panel/app.js 能被 vm 编译（前端语法没问题）', err)

ok(js.includes('document.getElementById') || js.includes('document.'), 'panel/app.js 看着是前端脚本')
ok(!web.includes("String.raw`<!DOCTYPE html>"), 'web.js 不再内嵌整页模板')
ok(web.includes("readPanel('index.html')"), 'web.js 的 / 路由改为读盘 panel/index.html')
ok(web.includes("p === '/panel/app.js'"), 'web.js 挂出了 /panel/app.js')

console.log(fail === 0 ? `ALL PASS (${pass} 项断言；index.html ${html.length} 字符，app.js ${js.length} 字符)` : `FAILED (${pass} 通过 / ${fail} 失败)`)
process.exit(fail === 0 ? 0 : 1)
