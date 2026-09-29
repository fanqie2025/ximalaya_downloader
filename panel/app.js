var $ = function(id){ return document.getElementById(id) }
var lastState = null
var busy = false
// 「库中已有书籍」看哪一页：未完成 / 已完成。用户切过一次就记住（手机上看书方便）
var libTab = 'pending'
try { if (localStorage.getItem('xmd-lib-tab') === 'done') libTab = 'done' } catch (e) {}

function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]
  })
}
function dur(ms){
  if (ms == null || ms < 0) return '-'
  var s = Math.floor(ms / 1000)
  var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600)
  var m = Math.floor((s % 3600) / 60), sec = s % 60
  if (d > 0) return d + ' 天 ' + h + ' 小时'
  if (h > 0) return h + ' 小时 ' + m + ' 分'
  if (m > 0) return m + ' 分 ' + sec + ' 秒'
  return sec + ' 秒'
}
function num(n){ return n == null ? '-' : String(n) }
function toast(msg, bad){
  var el = $('toast')
  el.textContent = msg
  el.style.background = bad ? 'var(--err)' : 'var(--fg)'
  el.style.color = '#fff'
  el.classList.add('on')
  clearTimeout(el._t)
  el._t = setTimeout(function(){ el.classList.remove('on') }, 2600)
}

var PHASE = {idle:'空闲', planning:'获取章节列表', running:'下载中', sleeping:'休眠中'}

function render(st){
  lastState = st
  var paused = st.paused === true
  var phase = paused ? 'pause' : st.phase
  var dotCls = paused ? 'pause' : (st.phase === 'sleeping' ? 'sleep' : (st.phase === 'running' || st.phase === 'planning' ? 'run' : ''))
  $('dot').className = 'dot ' + dotCls
  $('phase-text').textContent = paused ? '已暂停' : (PHASE[st.phase] || st.phase)
  $('chip-uptime').textContent = '已运行 ' + dur(st.uptime)

  $('sum-albums').textContent = num(st.albums.length)
  $('sum-done').textContent = num(st.summary.done)
  $('sum-pending').textContent = num(st.summary.pending)
  $('sum-round').textContent = st.round > 0 ? ('第 ' + st.round + ' 轮') : '未开始'
  $('sum-bar').firstChild.style.width = st.summary.percent + '%'
  $('sum-hint').textContent = '共 ' + st.summary.total + ' 集，已完成 ' + st.summary.done
    + '（' + st.summary.percent + '%）'
    + (st.lastRound ? '　·　上轮：成功 ' + st.lastRound.ok + ' / 失败 ' + st.lastRound.fail
        + '，新增 ' + (st.lastRound.downloaded == null ? '?' : st.lastRound.downloaded) + ' 集'
        + '，耗时 ' + st.lastRound.minutes + ' 分钟' : '')

  $('btn-pause').disabled = paused || busy
  $('btn-resume').disabled = !paused || busy
  $('btn-run').disabled = busy

  if (st.sleepUntil) {
    $('chip-next').textContent = '下次唤醒 ' + dur(st.sleepUntil - st.now) + '后'
  } else if (paused) {
    $('chip-next').textContent = '已暂停，不会自动开始'
  } else if (st.phase === 'running' || st.phase === 'planning') {
    $('chip-next').textContent = '正在工作'
  } else {
    $('chip-next').textContent = '待命'
  }

  var hints = []
  if (st.albumId) hints.push('当前专辑 ' + st.albumId)
  if (st.current) {
    // 谁在下（v9.1）：多账号换号之后，光看「本专辑进度」不知道是哪个账号在推
    hints.push('本专辑进度（账号 ' + (st.current.account || st.sched?.account || '?') + '） '
      + st.current.done + '/' + st.current.total + '（' + st.current.pct + '%）')
    if (st.current.title) hints.push('最近：' + st.current.title)
  }
  if (st.sleepReason) hints.push(st.sleepReason)
  $('now-hint').textContent = hints.length ? hints.join('　·　') : '没有正在进行的任务'

  renderAlbums(st)
  renderAccounts(st)
  renderLibrary(st)
}

function renderAlbums(st){
  var box = $('albums')
  if (!st.albums.length && !st.orphans.length) {
    box.innerHTML = '<div class="empty">还没有订阅。在上面填专辑链接或 ID 即可。</div>'
    return
  }
  var html = ''
  st.albums.forEach(function(a){
    // 注意字段名是 seen（进度库里有没有这张专辑的章节记录），别写成 saw
    var finished = a.seen && a.pending === 0
    var status = !a.seen ? '等待首次拉取'
      : (finished ? (a.isFinished === 2 ? '已完结 · 全部下载完成' : '全部下载完成')
                  : '待下载 ' + a.pending + ' 集')
    html += '<div class="alb">'
      + '<div class="alb-h">'
      +   '<span class="alb-t">' + (a.title ? esc(a.title) : '（尚未获取到专辑名）') + '</span>'
      +   '<span class="alb-m">' + esc(a.albumId) + (a.anchor ? ' · ' + esc(a.anchor) : '') + '</span>'
      +   '<span class="spacer" style="flex:1"></span>'
      +   '<button data-remove="' + esc(a.albumId) + '">移除</button>'
      + '</div>'
      + '<div class="bar' + (finished ? ' done' : '') + '"><i style="width:' + (a.percent || 0) + '%"></i></div>'
      + '<div class="alb-f">'
      +   '<span>' + a.done + ' / ' + (a.seen ? a.total : '?') + '　' + (a.percent || 0) + '%</span>'
      +   '<span class="grow"></span>'
      +   '<span>' + status + '</span>'
      + '</div>'
      + '</div>'
  })
  if (st.orphans.length) {
    html += '<div class="alb" style="opacity:.7"><div class="alb-f">'
      + '<span>另有 ' + st.orphans.length + ' 个专辑在进度库里但已取消订阅：'
      + st.orphans.map(function(o){ return esc(o.title || o.albumId) + '(' + o.done + '/' + o.total + ')' }).join('、')
      + '。文件和进度都还在，重新订阅即可续传。</span></div></div>'
  }
  box.innerHTML = html
  Array.prototype.forEach.call(box.querySelectorAll('button[data-remove]'), function(b){
    b.onclick = function(){ removeAlbum(b.getAttribute('data-remove')) }
  })
}

// 「库中已有书籍」分两页：下完的、标过「非本站」的进「已完成」安静待着；
// 还差集数的、认不出专辑的进「未完成」等着处理。同一张专辑下进两个目录的，
// 服务端（common/library.js 的 dedupeIdentified）已经合并成一条，这里只负责显示。
function renderLibrary(st){
  var lib = st.library || {rows: []}
  var rows = lib.rows || []
  var box = $('library')
  $('chip-lib').textContent = rows.length + ' 本'
  var pending = []
  var done = []
  rows.forEach(function(r, i){
    if (r.complete === true || r.ignored) done.push({r: r, i: i})
    else pending.push({r: r, i: i})
  })
  // 「未完成」里把要人拍板的（还没认出是哪张专辑）排最前，其余按还差多少集从少到多
  pending.sort(function(a, b){
    var am = a.r.complete === null ? 1 : 0
    var bm = b.r.complete === null ? 1 : 0
    if (am !== bm) return bm - am
    var ar = a.r.remaining == null ? Number.MAX_SAFE_INTEGER : a.r.remaining
    var br = b.r.remaining == null ? Number.MAX_SAFE_INTEGER : b.r.remaining
    if (ar !== br) return ar - br
    return String(a.r.name).localeCompare(String(b.r.name), 'zh')
  })
  done.sort(function(a, b){ return String(a.r.name).localeCompare(String(b.r.name), 'zh') })
  renderLibTabs(pending.length, done.length)
  if (!rows.length) {
    box.innerHTML = '<div class="empty">下载目录里还没有书（' + esc(lib.root || '-') + '）</div>'
    return
  }
  var subs = {}
  ;(st.albums || []).forEach(function(a){ subs[String(a.albumId)] = true })
  var list = libTab === 'done' ? done : pending
  if (!list.length) {
    box.innerHTML = '<div class="empty">' + (libTab === 'done'
      ? '还没有下完的书。'
      : '没有未完成的书 —— 都下完了，切到「已完成」看。') + '</div>'
    return
  }
  var html = ''
  list.forEach(function(it){
    var r = it.r
    var i = it.i
    var badge
    var btn = ''
    if (r.ignored) {
      badge = '<span class="badge">非本站 · 已忽略</span>'
      btn = '<button data-lib-skip="' + i + '" data-skip-to="0">取消忽略</button>'
    } else if (r.complete === true) {
      badge = '<span class="badge ok">已下完 ' + r.audio + '/' + r.total + '</span>'
      if (r.skipped) btn = '<button data-lib-ignore="' + i + '">单集忽略（' + r.skipped + '）</button>'
    } else if (r.complete === false) {
      badge = '<span class="badge off">未下完 ' + r.audio + '/' + r.total + '，还差 ' + r.remaining + '</span>'
      if (subs[String(r.albumId)]) btn = '<button disabled>已在订阅列表</button>'
      else btn = '<button class="primary" data-lib-go="' + i + '">继续下载</button>'
      btn += '<button data-lib-ignore="' + i + '">'
        + (r.skipped ? '单集忽略（已忽略 ' + r.skipped + '）' : '忽略某几集') + '</button>'
    } else {
      badge = '<span class="badge">未识别是哪张专辑</span>'
      btn = '<button data-lib-bind="' + i + '">绑定专辑</button>'
        + '<button data-lib-skip="' + i + '" data-skip-to="1">非本站·忽略</button>'
    }
    var marks = (r.hasCover ? '封面 ✓' : '封面 ✗') + '　·　'
      + (r.hasDesc ? '简介 ✓' : '简介 ✗') + '　·　'
      + (r.hasReader ? '主播 ✓' : '主播 ✗')
    html += '<div class="acc">'
      + '<div class="acc-h"><span class="acc-n">' + esc(r.name) + '</span>' + badge + '</div>'
      + '<div class="acc-sub">' + r.audio + ' 个音频'
      + (r.albumId ? '　·　专辑 ' + esc(String(r.albumId))
          + (r.matchedBy === 'sidecar' ? '（手工绑定过）' : '') : '')
      + (r.ignored ? '　·　非喜马拉雅来源，不绑专辑'
          + (r.skipReason ? '（' + esc(r.skipReason) + '）' : '') : '')
      + (r.skipped ? '　·　已忽略 ' + r.skipped + ' 集（不计入「还差」）'
          + (r.ignoreReason ? '（' + esc(r.ignoreReason) + '）' : '')
        : (r.ignoredPending ? '　·　单集忽略规则已写，下一轮下载时生效' : ''))
      + (r.dupes && r.dupes.length ? '　·　另有 ' + r.dupes.length + ' 个目录也是这本（'
          + r.dupes.map(function(d){ return esc(d.name) }).join('、') + '），已合并成一条' : '')
      + '　·　' + marks + '</div>'
      + '<div class="acc-b">' + btn + '</div>'
      + '</div>'
  })
  box.innerHTML = html
  Array.prototype.forEach.call(box.querySelectorAll('button[data-lib-go]'), function(b){
    b.onclick = function(){ libContinue(Number(b.getAttribute('data-lib-go'))) }
  })
  Array.prototype.forEach.call(box.querySelectorAll('button[data-lib-bind]'), function(b){
    b.onclick = function(){ libBind(Number(b.getAttribute('data-lib-bind'))) }
  })
  Array.prototype.forEach.call(box.querySelectorAll('button[data-lib-skip]'), function(b){
    b.onclick = function(){
      libSkip(Number(b.getAttribute('data-lib-skip')), b.getAttribute('data-skip-to') === '1')
    }
  })
  Array.prototype.forEach.call(box.querySelectorAll('button[data-lib-ignore]'), function(b){
    b.onclick = function(){ libIgnore(Number(b.getAttribute('data-lib-ignore'))) }
  })
}

// 两个页签：数字放在标签里，一眼知道还剩几本没收尾
function renderLibTabs(nPending, nDone){
  var box = $('lib-tabs')
  var mk = function(key, label){
    return '<button' + (libTab === key ? ' class="primary"' : '')
      + ' data-lib-tab="' + key + '">' + label + '</button>'
  }
  box.innerHTML = mk('pending', '未完成 ' + nPending) + mk('done', '已完成 ' + nDone)
  Array.prototype.forEach.call(box.querySelectorAll('button[data-lib-tab]'), function(b){
    b.onclick = function(){
      libTab = b.getAttribute('data-lib-tab')
      try { localStorage.setItem('xmd-lib-tab', libTab) } catch (e) {}
      renderLibrary(lastState)
    }
  })
}

// 继续下载 = 把专辑 ID 加进订阅列表（跟「添加订阅」走同一个接口）
function libContinue(i){
  var r = (lastState.library && lastState.library.rows[i]) || null
  if (!r || !r.albumId) return
  act('/api/albums', {input: String(r.albumId)}, '已加入订阅队列，下一轮就接着下')
}

// 绑定专辑：目录名跟专辑名对不上时手工指定一次，写进目录里的 .xmd-album.json
function libBind(i){
  var r = (lastState.library && lastState.library.rows[i]) || null
  if (!r) return
  openModal('绑定专辑：' + r.name,
    '<div class="hint">这一个目录名跟专辑名对不上，程序认不出它。填一次专辑 ID（或直接粘贴专辑链接），'
    + '绑定信息会写进目录里的 .xmd-album.json，顺便把封面/简介补上，以后不用再填。</div>'
    + '<div class="row" style="margin-top:10px">'
    + '<input type="text" id="lib-bind-id" placeholder="专辑 ID 或链接，如 86991161" autocomplete="off">'
    + '<button class="primary" id="lib-bind-ok">绑定</button></div>'
    + '<div class="hint mono">' + esc(r.dir) + '</div>')
  $('lib-bind-id').focus()
  $('lib-bind-id').onkeydown = function(e){ if (e.key === 'Enter') $('lib-bind-ok').click() }
  $('lib-bind-ok').onclick = function(){
    var v = $('lib-bind-id').value.trim()
    if (v === '') { toast('先填专辑 ID', true); return }
    $('lib-bind-ok').disabled = true
    busy = true
    fetch('/api/library/bind', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({dir: r.dir, albumId: v})
    }).then(function(x){ return x.json() }).then(function(x){
      busy = false
      if (x && x.ok) {
        var out = x.result || {}
        toast('绑定成功：《' + (out.albumTitle || r.name) + '》')
        closeModal()
        refresh()
      } else {
        $('lib-bind-ok').disabled = false
        toast((x && x.msg) || '绑定失败', true)
      }
    }).catch(function(e){
      busy = false
      $('lib-bind-ok').disabled = false
      toast('请求出错：' + e.message, true)
    })
  }
}

// 「非本站」：番茄唱听这类不是喜马拉雅来的书，永远绑不上专辑。
// 标记只在目录里放一个 .xmd-skip，音频文件一个都不动（ABS 照常播放）。
function libSkip(i, on){
  var r = (lastState.library && lastState.library.rows[i]) || null
  if (!r) return
  if (!on) { postSkip(r.dir, false, ''); return }
  openModal('标记为非本站：' + r.name,
    '<div class="hint">这本不是喜马拉雅来的（比如番茄唱听、懒人听书），永远拿不到专辑 ID。'
    + '标记后这行显示成「非本站 · 已忽略」，面板不再催你绑定；目录里的音频一个都不动，ABS 照常扫描播放。</div>'
    + '<div class="row" style="margin-top:10px">'
    + '<input type="text" id="lib-skip-reason" placeholder="来源，可留空（如 番茄唱听）" autocomplete="off">'
    + '<button class="primary" id="lib-skip-ok">标记</button></div>'
    + '<div class="hint mono">' + esc(r.dir) + '</div>')
  $('lib-skip-reason').focus()
  $('lib-skip-reason').onkeydown = function(e){ if (e.key === 'Enter') $('lib-skip-ok').click() }
  $('lib-skip-ok').onclick = function(){
    $('lib-skip-ok').disabled = true
    postSkip(r.dir, true, $('lib-skip-reason').value.trim())
  }
}

function postSkip(dir, on, reason){
  if (busy) return
  busy = true
  fetch('/api/library/skip', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({dir: dir, skip: on, reason: reason})
  }).then(function(x){ return x.json() }).then(function(x){
    busy = false
    if (x && x.ok) {
      toast(on ? '已标记为非本站，不再提醒绑定' : '已取消「非本站」标记')
      closeModal()
      refresh()
    } else {
      toast((x && x.msg) || '操作失败', true)
    }
  }).catch(function(e){
    busy = false
    toast('请求出错：' + e.message, true)
  })
}

// 单集忽略：删掉之后会被当成「还没下」再下一遍的那几集，在这里画个圈。
// 规则落在专辑目录的 .xmd-ignore.json，下一轮下载开始时由下载器解析并在进度库打
// skip 标记；音频文件一个都不动，只是不再算「还差 N 集」。
function libIgnore(i){
  var r = (lastState.library && lastState.library.rows[i]) || null
  if (!r) return
  var hasRule = (r.ignoreNums && r.ignoreNums.length) || (r.ignorePatterns && r.ignorePatterns.length)
  var cur = ''
  if (hasRule) {
    cur = '<div class="hint">当前规则：'
      + (r.ignoreNums && r.ignoreNums.length ? '集号 ' + esc(r.ignoreNums.join(',')) : '')
      + (r.ignoreNums && r.ignoreNums.length && r.ignorePatterns && r.ignorePatterns.length ? '　·　' : '')
      + (r.ignorePatterns && r.ignorePatterns.length ? '标题匹配 ' + esc(r.ignorePatterns.join('、')) : '')
      + (r.ignoreReason ? '（' + esc(r.ignoreReason) + '）' : '')
      + (r.skipped ? '，其中 ' + r.skipped + ' 集磁盘上没有、已不计入缺集' : '')
      + (r.ignoredPending ? '，下一轮下载时生效' : '') + '</div>'
  }
  openModal('单集忽略：' + r.name,
    '<div class="hint">这些集删掉之后，程序会当成「还没下」再下一遍。填在这里就不会再下它们了 —— '
    + '音频文件一个都不动，ABS 照常扫描播放，只是面板不再把它们算进「还差 N 集」。'
    + '下一轮下载开始时生效；再填一次是追加，不会覆盖上次的规则。</div>'
    + '<div class="row" style="margin-top:10px">'
    + '<input type="text" id="lib-ig-nums" placeholder="集号，如 651,656-660" autocomplete="off"></div>'
    + '<div class="row" style="margin-top:8px">'
    + '<input type="text" id="lib-ig-pat" placeholder="或按标题匹配，如 活动|福利|片花" autocomplete="off"></div>'
    + '<div class="row" style="margin-top:8px">'
    + '<input type="text" id="lib-ig-reason" placeholder="备注，可留空" autocomplete="off"></div>'
    + '<div class="row" style="margin-top:10px"><button class="primary" id="lib-ig-ok">保存</button>'
    + (hasRule ? '<button id="lib-ig-off">取消全部忽略</button>' : '') + '</div>'
    + cur
    + '<div class="hint mono">' + esc(r.dir) + '</div>')
  $('lib-ig-nums').focus()
  var save = function(){ postIgnore(r.dir, false) }
  $('lib-ig-nums').onkeydown = function(e){ if (e.key === 'Enter') save() }
  $('lib-ig-pat').onkeydown = function(e){ if (e.key === 'Enter') save() }
  $('lib-ig-reason').onkeydown = function(e){ if (e.key === 'Enter') save() }
  $('lib-ig-ok').onclick = save
  if ($('lib-ig-off')) $('lib-ig-off').onclick = function(){ postIgnore(r.dir, true) }
}

function postIgnore(dir, off){
  if (busy) return
  var body = {dir: dir, off: !!off}
  if (!off) {
    body.nums = $('lib-ig-nums').value.trim()
    body.pattern = $('lib-ig-pat').value.trim()
    body.reason = $('lib-ig-reason').value.trim()
  }
  busy = true
  fetch('/api/library/track-skip', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body)
  }).then(function(x){ return x.json() }).then(function(x){
    busy = false
    if (x && x.ok) {
      toast(off ? '已取消单集忽略' : '已记下：这几集下一轮不会再下，删了也不会自己回来')
      closeModal()
      refresh()
    } else {
      toast((x && x.msg) || '操作失败', true)
    }
  }).catch(function(e){
    busy = false
    toast('请求出错：' + e.message, true)
  })
}

function refresh(){
  fetch('/api/state', {cache:'no-store'}).then(function(r){ return r.json() }).then(function(r){
    if (r && r.ok) render(r.data)
    else toast('读取状态失败', true)
  }).catch(function(){ toast('连不上服务', true) })
}

function refreshLog(){
  fetch('/api/log', {cache:'no-store'}).then(function(r){ return r.json() }).then(function(r){
    if (!r || !r.ok) return
    var box = $('log')
    // 停在底部时才自动滚，免得用户翻历史被打断
    var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40
    box.innerHTML = r.lines.map(function(l){
      var cls = /\[ERROR\]/.test(l) ? ' class="e"' : (/\[WARN\]/.test(l) ? ' class="w"' : '')
      return '<span' + cls + '>' + esc(l) + '</span>'
    }).join('\n')
    if (atBottom) box.scrollTop = box.scrollHeight
  }).catch(function(){})
}

function act(path, body, okMsg){
  if (busy) return
  busy = true
  fetch(path, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body || {})
  }).then(function(r){ return r.json() }).then(function(r){
    busy = false
    if (r && r.ok) { if (okMsg) toast(okMsg); refresh() }
    else toast((r && r.msg) || '操作失败', true)
  }).catch(function(e){
    busy = false
    toast('请求出错：' + e.message, true)
  })
}

function addAlbum(){
  var input = $('in-album').value.trim()
  if (input === '') { toast('先填点东西', true); return }
  fetch('/api/albums', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({input: input})
  }).then(function(r){ return r.json() }).then(function(r){
    if (r && r.ok) { $('in-album').value = ''; toast('已添加 ' + r.albumId); refresh() }
    else toast((r && r.msg) || '添加失败', true)
  }).catch(function(e){ toast('请求出错：' + e.message, true) })
}

function removeAlbum(id){
  if (!confirm('确定不再自动下载专辑 ' + id + ' 吗？\n\n已下载的文件和进度记录都会保留，重新添加即可续传。')) return
  act('/api/albums/remove', {albumId: id}, '已移除 ' + id)
}

// ---------------------------------------------------------------- 账号（v7）

var accPoll = null

function ago(ts){
  if (!ts) return '-'
  var s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前'
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前'
  return Math.floor(s / 86400) + ' 天前'
}

function openModal(title, html){
  $('modal-title').textContent = title
  $('modal-body').innerHTML = html
  $('mask').classList.add('on')
}

function closeModal(){
  $('mask').classList.remove('on')
  $('modal-body').innerHTML = ''
  if (accPoll) { clearInterval(accPoll); accPoll = null }
}

function postJson(path, body, okMsg){
  return fetch(path, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body || {})
  }).then(function(r){ return r.json() }).then(function(r){
    if (r && r.ok) { if (okMsg) toast(okMsg); refresh() }
    else toast((r && r.msg) || '操作失败', true)
    return r
  }).catch(function(e){ toast('请求出错：' + e.message, true); return null })
}

function copyText(text, okMsg){
  var done = function(){ toast(okMsg || '已复制') }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function(){ toast('复制失败，手动选中吧', true) })
    return
  }
  var ta = document.createElement('textarea')
  ta.value = text
  document.body.appendChild(ta)
  ta.select()
  try { document.execCommand('copy'); done() } catch (e) { toast('复制失败，手动选中吧', true) }
  document.body.removeChild(ta)
}

function accBadge(a){
  if (a.disabled) return {cls:'off', text: a.disabledReason || '已禁用'}
  if (a.probing) return {cls:'', text:'探测中…'}
  if (a.logging) return {cls:'', text:'登录中…'}
  var st = a.status
  if (!st || st.at == null) return {cls:'', text:'未探测'}
  if (st.alive === true) {
    var t = st.nickname || '正常'
    return {cls:'ok', text: t + (st.vip ? ' · VIP' : '')}
  }
  return {cls:'bad', text: st.reason || '失效'}
}

function renderAccounts(st){
  var box = $('accounts')
  var list = st.accounts || []
  $('chip-acc').textContent = list.length + ' 个账号'
    + (st.probing ? ('　·　正在探测 ' + st.probing) : '')
  if (!list.length) {
    box.innerHTML = '<div class="empty">还没有账号。上面填个名字点「添加账号」，然后扫码登录。</div>'
    return
  }
  var html = ''
  list.forEach(function(a){
    var b = accBadge(a)
    var rec = a.status || {}
    var sub = []
    if (a.daily) sub.push('今日 ' + a.daily.count + '/' + (a.daily.cap || '?'))
    if (rec.uid) sub.push('uid ' + rec.uid)
    if (rec.vipExpire != null) sub.push('VIP 剩 ' + rec.vipExpire + ' 天')
    if (rec.robot) sub.push('⚠ 被判定为机器人')
    if (rec.ban) sub.push('⚠ 禁止登录')
    sub.push(a.credential ? ('凭据 ' + a.credential) : '没有凭据（还需扫码登录）')
    var fp = a.fingerprint || {}
    var fpText = fp.exists ? '指纹 ✔'
      : (fp.usingShared ? '指纹（用共用目录那份）' : '没有指纹')
    html += '<div class="acc">'
      + '<div class="acc-h">'
      +   '<span class="acc-n">' + esc(a.name) + '</span>'
      +   '<span class="badge ' + b.cls + '">' + esc(b.text) + '</span>'
      +   '<span class="acc-m">' + esc(fpText) + '</span>'
      +   '<span class="spacer" style="flex:1"></span>'
      +   '<span class="acc-m">' + (rec.at ? ('探测 ' + ago(rec.at)) : '') + '</span>'
      + '</div>'
      + '<div class="acc-sub">' + esc(sub.join('　·　')) + '</div>'
      + '<div class="acc-sub mono">' + esc(a.dir) + '</div>'
      + '<div class="acc-b">'
      +   '<button data-acc-probe="' + esc(a.name) + '">探测</button>'
      +   '<button data-acc-login="' + esc(a.name) + '">扫码登录</button>'
      +   '<button data-acc-fp="' + esc(a.name) + '">指纹</button>'
      +   (a.disabled
            ? '<button data-acc-enable="' + esc(a.name) + '">启用</button>'
            : '<button data-acc-disable="' + esc(a.name) + '">禁用</button>')
      +   '<button data-acc-remove="' + esc(a.name) + '">移出名单</button>'
      + '</div>'
      + '</div>'
  })
  box.innerHTML = html
  Array.prototype.forEach.call(box.querySelectorAll('button[data-acc-probe]'), function(x){
    x.onclick = function(){ accProbe(x.getAttribute('data-acc-probe')) }
  })
  Array.prototype.forEach.call(box.querySelectorAll('button[data-acc-login]'), function(x){
    x.onclick = function(){ accLogin(x.getAttribute('data-acc-login'), 'web') }
  })
  Array.prototype.forEach.call(box.querySelectorAll('button[data-acc-fp]'), function(x){
    x.onclick = function(){ accFingerprint(x.getAttribute('data-acc-fp')) }
  })
  Array.prototype.forEach.call(box.querySelectorAll('button[data-acc-disable]'), function(x){
    x.onclick = function(){
      var n = x.getAttribute('data-acc-disable')
      if (confirm('禁用账号 ' + n + '？\n\n他不再参与轮转（凭据文件不删），随时可以再启用。')) {
        postJson('/api/accounts/disable', {name:n}, '已禁用 ' + n)
      }
    }
  })
  Array.prototype.forEach.call(box.querySelectorAll('button[data-acc-enable]'), function(x){
    x.onclick = function(){ postJson('/api/accounts/enable', {name:x.getAttribute('data-acc-enable')}, '已启用') }
  })
  Array.prototype.forEach.call(box.querySelectorAll('button[data-acc-remove]'), function(x){
    x.onclick = function(){
      var n = x.getAttribute('data-acc-remove')
      if (confirm('把账号 ' + n + ' 移出名单？\n\n只是不再参与轮转，凭据和指纹文件都留在磁盘上。')) {
        postJson('/api/accounts/remove', {name:n}, '已移出 ' + n)
      }
    }
  })
}

function accAdd(){
  var n = $('in-acc').value.trim()
  if (n === '') { toast('先填个账号名', true); return }
  postJson('/api/accounts/add', {name:n}, '账号 ' + n + ' 已加入，接着扫码登录').then(function(r){
    if (r && r.ok) {
      $('in-acc').value = ''
      refresh()
      accLogin(n, 'web')
    }
  })
}

function accProbe(name){
  openModal('探测账号 ' + name, '<div class="acc-sub">正在查两个通道的登录态，并拿这份指纹去数盟报一次（最多等 2 分钟）…</div>')
  postJson('/api/accounts/probe', {name:name}).then(function(r){
    if (!r || !r.ok) { toast((r && r.msg) || '探测失败', true); return }
    var d = r.probe || {}
    var html = '<div class="acc-sub">账号 <b>' + esc(name) + '</b>　'
      + (d.alive ? '<span class="badge ok">可用</span>' : '<span class="badge bad">不可用</span>')
      + '</div>'
    if (d.nickname || d.uid) html += '<div class="acc-sub">昵称 ' + esc(d.nickname || '-') + '　uid ' + esc(d.uid || '-') + '</div>'
    html += '<div class="acc-sub">VIP ' + (d.vip ? '是' : '否')
      + (d.vipExpire != null ? ('（剩 ' + d.vipExpire + ' 天）') : '') + '</div>'
    var ch = d.channels || {}
    Object.keys(ch).forEach(function(k){
      var c = ch[k]
      html += '<div class="acc-sub">通道 ' + esc(k) + '：'
        + (c.ok ? '<span class="badge ok">正常</span>' : '<span class="badge bad">不可用</span>')
        + ' ' + esc(c.msg || '') + '</div>'
    })
    var fp = d.fingerprint
    if (fp) {
      html += '<div class="acc-sub">指纹：'
        + (!fp.exists ? '<span class="badge bad">没有文件</span> ' + esc(fp.path || '')
            : (fp.accepted ? '<span class="badge ok">服务端认</span>' : '<span class="badge bad">服务端不认</span>')
              + '　字段 ' + (fp.fields || '?') + '　设备 ' + esc(fp.aid || '-'))
        + '</div>'
      if (fp.error) html += '<div class="acc-sub">' + esc(fp.error) + '</div>'
    }
    if (!d.alive && d.reason) html += '<div class="acc-sub">' + esc(d.reason) + '</div>'
    openModal('账号 ' + name + ' 探测结果', html)
    toast(d.alive ? '账号可用' : '账号不可用', !d.alive)
  })
}

function accLogin(name, type){
  postJson('/api/accounts/login', {name:name, type:type || 'web'}).then(function(r){
    if (r && r.ok) showQr(name, type || 'web')
  })
}

function showQr(name, type){
  var html = '<div class="acc-sub">用<b>喜马拉雅 APP</b> 扫下面这张二维码。扫完页面会自己刷新出凭据，不用管终端。</div>'
    + '<div class="row" style="margin-top:10px">'
    +   '<button id="qr-web">网页端登一次</button>'
    +   '<button id="qr-pc">电脑版登一次</button>'
    +   '<button id="qr-cancel">取消登录</button>'
    + '</div>'
    + '<div class="qr">'
    +   '<img id="qr-img" alt="二维码" src="/api/accounts/qrcode?name=' + encodeURIComponent(name) + '&t=' + Date.now() + '">'
    +   '<div class="t" id="qr-t">二维码加载中…</div>'
    + '</div>'
    + '<div class="acc-sub">两条通道的 cookie 是分开存的（网页端 www2 / 电脑版 mac）。想都能下就各扫一遍；只扫一条也能下，'
    + '另一条通道不可用时调度器会自动切过去。</div>'
  openModal('账号 ' + name + ' 扫码登录', html)
  $('qr-web').onclick = function(){ accLogin(name, 'web') }
  $('qr-pc').onclick = function(){ accLogin(name, 'pc') }
  $('qr-cancel').onclick = function(){
    postJson('/api/accounts/login/cancel', {name:name}, '已取消登录')
    closeModal()
  }
  if (accPoll) clearInterval(accPoll)
  accPoll = setInterval(function(){
    var img = $('qr-img')
    if (!img) return
    img.onload = function(){ $('qr-t').textContent = '用喜马拉雅 APP 扫码，扫完稍等几秒' }
    img.onerror = function(){ $('qr-t').textContent = '二维码还没生成，等一下…' }
    img.src = '/api/accounts/qrcode?name=' + encodeURIComponent(name) + '&t=' + Date.now()
    refresh()
    var hit = ((lastState && lastState.accounts) || []).filter(function(x){ return x.name === name })[0]
    if (hit && !hit.logging && hit.credential) {
      clearInterval(accPoll)
      accPoll = null
      $('qr-t').textContent = '登录成功，凭据已保存'
      toast('账号 ' + name + ' 登录完成')
      setTimeout(closeModal, 1500)
    }
  }, 2500)
}

function fpTools(name, text){
  return '<div class="row" style="margin-top:10px">'
    +   '<button id="fp-verify">真校验（报一次数盟）</button>'
    +   '<button id="fp-copy-root">从共用目录复制</button>'
    +   '<button id="fp-copy">复制 JSON</button>'
    +   '<button id="fp-clear">删掉这份</button>'
    + '</div>'
    + '<div class="acc-sub" style="margin-top:14px">导入 / 替换：把设备指纹 JSON 粘进来，或选一个文件</div>'
    + '<textarea id="fp-text" spellcheck="false" placeholder="粘贴 device-info.json 的内容…">' + esc(text || '') + '</textarea>'
    + '<div class="row" style="margin-top:8px">'
    +   '<input type="file" id="fp-file" accept=".json,application/json">'
    +   '<span class="spacer" style="flex:1"></span>'
    +   '<button class="primary" id="fp-import">导入</button>'
    + '</div>'
}

function wireFp(name){
  $('fp-verify').onclick = function(){
    openModal('校验账号 ' + name + ' 的指纹', '<div class="acc-sub">正在拿这份指纹去数盟报一次（最多等 2 分钟）…</div>')
    postJson('/api/accounts/fingerprint/verify', {name:name}).then(function(r){
      if (!r || !r.ok) { toast((r && r.msg) || '校验失败', true); return }
      var fp = r.fingerprint || {}
      var html = '<div class="acc-sub">'
        + (fp.accepted ? '<span class="badge ok">服务端认这份指纹</span>' : '<span class="badge bad">服务端不认</span>')
        + '　设备 ' + esc(fp.aid || '-') + '　字段 ' + (fp.fields || '?') + ' 个</div>'
        + '<div class="acc-sub">HTTP ' + esc(fp.http == null ? '-' : String(fp.http)) + '　err ' + esc(fp.err == null ? '-' : String(fp.err)) + '</div>'
        + '<div class="acc-sub">文件 ' + esc(fp.path || '-') + (fp.exists ? '' : '（不存在）') + '</div>'
        + (fp.ua ? '<div class="acc-sub mono">' + esc(fp.ua) + '</div>' : '')
        + (fp.error ? '<div class="acc-sub">' + esc(fp.error) + '</div>' : '')
        + '<div class="acc-sub">判据：服务端认的指纹会回填 GJ2 和 fd2.av1；不认就是 aid/cadd 空。</div>'
      openModal('账号 ' + name + ' 指纹校验结果', html)
      toast(fp.accepted ? '指纹可用' : '指纹不可用', !fp.accepted)
    })
  }
  $('fp-copy-root').onclick = function(){
    postJson('/api/accounts/fingerprint/copy-root', {name:name}, '已从共用目录复制一份给这个账号')
  }
  $('fp-copy').onclick = function(){
    copyText($('fp-text').value, '指纹 JSON 已复制到剪贴板')
  }
  $('fp-clear').onclick = function(){
    if (!confirm('删掉这个账号目录里的指纹文件？\n\n删了以后会用共用目录那份（如果存在）。')) return
    postJson('/api/accounts/fingerprint/clear', {name:name}, '已删掉，回退用共用目录那份')
  }
  $('fp-import').onclick = function(){
    var t = $('fp-text').value.trim()
    if (t === '') { toast('先粘一份 JSON 进来', true); return }
    postJson('/api/accounts/fingerprint/import', {name:name, json:t}, '指纹已导入，点「真校验」试试服务端认不认')
  }
  $('fp-file').onchange = function(){
    var f = this.files && this.files[0]
    if (!f) return
    var fr = new FileReader()
    fr.onload = function(){ $('fp-text').value = String(fr.result) }
    fr.readAsText(f)
  }
}

function accFingerprint(name){
  fetch('/api/accounts/fingerprint?name=' + encodeURIComponent(name), {cache:'no-store'})
    .then(function(r){ return r.json() }).then(function(r){
      if (!r || !r.ok) {
        openModal('账号 ' + name + ' 的设备指纹',
          '<div class="acc-sub">' + esc((r && r.msg) || '读不到指纹') + '</div>' + fpTools(name, ''))
        wireFp(name)
        return
      }
      var d = r.data
      var head = '<div class="acc-sub">来源：'
        + (d.from === 'shared' ? '共用目录（这个账号自己没有，用的是兜底那份）' : '账号自己的目录')
        + '　字段 ' + d.fields + ' 个　' + Math.round(d.size / 1024) + ' KB</div>'
        + '<div class="acc-sub">注册状态：'
        + (d.registered
            ? '<span class="badge ok">已注册</span>（服务端回填过 GJ2 / fd2.av1）'
            : '<span class="badge bad">看不出注册</span>（缺 GJ2 / fd2.av1，付费声音大概率下不了）')
        + '</div>'
        + '<div class="acc-sub">设备 ' + esc(d.deviceId || '-') + '</div>'
        + '<div class="acc-sub mono">' + esc(d.path) + '</div>'
        + '<div class="acc-sub mono">' + esc(d.ua || '-') + '</div>'
      openModal('账号 ' + name + ' 的设备指纹', head + fpTools(name, d.text))
      wireFp(name)
    }).catch(function(e){ toast('读指纹出错：' + e.message, true) })
}

$('btn-pause').onclick = function(){ act('/api/pause', {}, '已暂停') }
$('btn-resume').onclick = function(){ act('/api/resume', {}, '已继续') }
$('btn-run').onclick = function(){ act('/api/run', {}, '已触发一轮') }
$('btn-add').onclick = addAlbum
$('in-album').addEventListener('keydown', function(e){ if (e.key === 'Enter') addAlbum() })
$('btn-acc-add').onclick = accAdd
$('in-acc').addEventListener('keydown', function(e){ if (e.key === 'Enter') accAdd() })
// 重新扫描：绕开 60 秒缓存，立刻重扫下载目录（比如刚手工往里放了文件）
$('btn-lib-scan').onclick = function(){
  fetch('/api/library?force=1', {cache:'no-store'}).then(function(r){ return r.json() }).then(function(r){
    if (r && r.ok) { toast('扫到 ' + (r.data.rows || []).length + ' 本'); refresh() }
    else toast('扫描失败', true)
  }).catch(function(e){ toast('请求出错：' + e.message, true) })
}
$('modal-close').onclick = closeModal
$('mask').addEventListener('click', function(e){ if (e.target === $('mask')) closeModal() })
document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeModal() })
$('logbox').addEventListener('toggle', function(){ if ($('logbox').open) refreshLog() })

refresh()
refreshLog()
setInterval(refresh, 4000)
setInterval(function(){ if ($('logbox').open) refreshLog() }, 6000)
