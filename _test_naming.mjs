import {
    albumDirName,
    trackFileName,
    shortTitle,
    parseAlbumTitle,
    padWidth,
    loadAlbumMeta,
} from './common/naming.js'
import {config} from './common/config.js'

console.log('生效模板:', config.naming && config.naming.template,
    '| padWidth:', config.naming && config.naming.padWidth,
    '| authorGuess:', config.naming && config.naming.authorGuess)

function show(label, album, meta) {
    const p = parseAlbumTitle(album.albumTitle, album.anchorName)
    console.log(`${label}`)
    console.log(`   原标题 : ${album.albumTitle}`)
    console.log(`   主播   : ${album.anchorName}`)
    console.log(`   拆出   : title=${JSON.stringify(p.title)} author=${JSON.stringify(p.author)} guessed=${p.guessed}`)
    console.log(`   目录名 : ${albumDirName(album, meta || {})}`)
}

// 三段式：作者｜书名｜类型
show('【1】三段式（真实专辑）', {
    albumId: '22216262',
    albumTitle: '无敌浪爷｜史上最强赘婿｜同名漫画',
    anchorName: '幻樱空',
    isFinished: 2,
    trackCount: 1589,
})
console.log('   文件名 :', trackFileName({num: 8, title: '史上最强赘婿 007 刮目相看'}, {
    albumId: '22216262', trackCount: 1589, anchorName: '幻樱空',
}, '.m4a'))
console.log()

// 两段式：书名｜卖点，作者著 —— 作者推不出来，需手工登记
show('【2】两段式（作者需手工登记）', {
    albumId: '30816438',
    albumTitle: '三体（全六季）| 精品广播剧，刘慈欣著',
    anchorName: '三体宇宙',
    isFinished: true,
    trackCount: 120,
})
show('【3】同上 + 手工登记作者', {
    albumId: '30816438',
    albumTitle: '三体（全六季）| 精品广播剧，刘慈欣著',
    anchorName: '三体宇宙',
    isFinished: true,
    trackCount: 120,
}, {30816438: {author: '刘慈欣'}})
console.log()

// 主播｜书名 结构（第一段 == 主播）
show('【4】第一段就是主播', {
    albumId: '3',
    albumTitle: '传说中的方片K｜道诡异仙',
    anchorName: '传说中的方片K',
    isFinished: 2,
    trackCount: 1303,
})
console.log()

// 单段
show('【5】单段带书名号', {
    albumId: '4',
    albumTitle: '《全职高手》合集',
    anchorName: '刺儿',
    isFinished: 2,
    trackCount: 500,
}, {})

console.log()
console.log('书名号不自剥  :', JSON.stringify(shortTitle('《全职高手》合集')))
console.log('无主播        :', JSON.stringify(albumDirName({albumId: '1', albumTitle: '孤儿专辑', anchorName: '', trackCount: 5}, {})))
console.log('padWidth      :', padWidth({trackCount: 1589}))
const long = 'A'.repeat(300)
console.log('超长截断字节  :', Buffer.byteLength(albumDirName({albumId: '1', albumTitle: long, anchorName: 'x', trackCount: 5}, {}), 'utf8'), '(应 <= 255)')
console.log('非法字符      :', JSON.stringify(albumDirName({albumId: '1', albumTitle: 'a/b:c*d?e"f<g>h|i', anchorName: '', trackCount: 5}, {})))
console.log('元数据文件    :', JSON.stringify(loadAlbumMeta()).slice(0, 60))
