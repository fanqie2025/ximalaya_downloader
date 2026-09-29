// 「库中已有书籍」的分组逻辑（纯函数，不碰 DOM，方便 node 里单测）。
//
// 用户 2026-09-30 拍板：同一本书不要在「订阅列表」和「库中已有书籍」里各显示一遍。
// 订阅列表那张卡本来就带进度、待下载集数和「移除」按钮，所以订阅中的书归它管，
// 这里只把它们挑出来（返回 subscribed），由 app.js 用一行提示指回订阅列表。
//
// 注意返回的是 {r: 行, i: 行在原始 rows 里的下标} —— 面板的按钮（继续下载/绑定/
// 忽略）都是拿这个下标回调服务端的，分组不能改变下标。

function splitLibRows(rows, subs){
  var pending = []
  var done = []
  var subscribed = []
  var sub = subs || {}
  ;(rows || []).forEach(function(r, i){
    // 标了「非本站·忽略」的留着（那是用户在库这边的决定），不按订阅去重
    if (!r.ignored && r.albumId != null && sub[String(r.albumId)]) {
      subscribed.push({r: r, i: i})
      return
    }
    if (r.complete === true || r.ignored) done.push({r: r, i: i})
    else pending.push({r: r, i: i})
  })
  return {pending: pending, done: done, subscribed: subscribed}
}
