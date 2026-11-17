/* 列车经由查询 —— 纯前端，无依赖 */
(function () {
  'use strict';

  var D = window.ROUTE_DATA;
  var out = document.getElementById('out');
  var ft = document.getElementById('ft');
  var q = document.getElementById('q');
  var goBtn = document.getElementById('go');
  var clr = document.getElementById('clr');
  var ac = document.getElementById('ac');
  var hint = document.getElementById('hint');

  if (!D) {
    out.innerHTML = '<section class="card"><div class="err">缺少 <b>routes.js</b>，' +
      '请先在项目目录运行 <b>python build.py</b> 生成数据。</div></section>';
    return;
  }

  var ST = D.stations, LN = D.lines, TR = D.trains;
  var LST = D.lineStations || {};
  var TM = D.times || {};
  var META = window.ROUTE_META || null;   // 车站档案 + 车底/车型，懒加载（meta.js）
  var metaWait = null, ST_PY = null;
  var KEYS = Object.keys(TR).sort();
  var ST_ID = Object.create(null), LN_SET = Object.create(null);
  var ST_LO = [], LN_LO = [], LN_PARTS = [];
  var i, N_LN = 0;
  for (i = 0; i < ST.length; i++) { ST_ID[ST[i]] = i; ST_LO.push(ST[i].toLowerCase()); }
  for (i = 0; i < LN.length; i++) {
    LN_SET[LN[i]] = i;
    LN_LO.push(LN[i].toLowerCase());
    LN_PARTS.push(LN[i].split('/'));
    if (LN[i].indexOf('/') < 0) N_LN++;   // 含 / 的是换线标记，不是独立线路
  }

  var MAX = 20;         // 每组搜索结果上限
  var MAX_LIST = 200;   // 车站 / 线路 / 区段列表上限

  var items = [], active = -1;
  var S = { kind: 'empty' };
  var ST_INDEX = null;  // 站号 -> 车次[]，首次用到才建
  var BU_SET = null, BU_LIST = null;  // 担当 -> 车次[]，首次用到才建

  /* ---------------- 工具 ---------------- */
  function norm(s) { return String(s == null ? '' : s).toUpperCase().replace(/[\s\u3000]+/g, ''); }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function num(n) { return Number(n).toLocaleString('en-US'); }
  function stName(id) { return ST[id]; }
  function lnName(id) { return LN[id]; }
  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  /* 站名做成可点，点开车站浮窗（数据来自 meta.js） */
  function stLink(id) {
    var n = ST[id];
    return '<a class="sl" href="#" data-pop="st:' + esc(n) + '">' + esc(n) + '</a>';
  }
  function lnLink(name) {
    return '<a class="sl" href="#" data-pop="ln:' + esc(name) + '" data-hl="' + esc(name) + '">' + esc(name) + '</a>';
  }
  function stLinkName(n) {
    return '<a class="sl" href="#" data-pop="st:' + esc(n) + '">' + esc(n) + '</a>';
  }
  function isMobile() { return window.innerWidth <= 560; }

  /* ---------------- 时刻 ---------------- */
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  // 数据里是从首站当天 0 点起的分钟数，跨日靠整除 1440 判断
  function fmtT(v) {
    if (v == null) return '';
    var d = Math.floor(v / 1440), m = v - d * 1440;
    return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60) +
      (d > 0 ? '<i class="d">+' + d + '</i>' : '');
  }
  function durTxt(m) {
    var d = Math.floor(m / 1440), r = m - d * 1440;
    return (d ? d + ' 天 ' : '') + Math.floor(r / 60) + ':' + pad2(r % 60);
  }
  // 取某条经由第 k 站的 [站序, 到点, 发点]
  function timeAt(no, vi, k) {
    var t = TM[no];
    if (!t) return null;
    var a = t[vi];
    if (!a) return null;
    for (var j = 0; j < a.length; j++) if (a[j][0] === k) return a[j];
    return null;
  }

  /* 优先读 .gz（服务器不压缩时也能省流量），不支持就退回 <script> */
  function loadScriptGz(src, done) {
    function fallback() {
      var s = document.createElement('script');
      s.src = src;
      s.onload = s.onerror = done;
      document.body.appendChild(s);
    }
    if (location.protocol === 'file:' || !window.fetch || !window.TextDecoder ||
        !window.DecompressionStream || !window.TransformStream) {
      fallback();
      return;
    }
    fetch(src + '.gz').then(function (r) {
      if (!r.ok || !r.body) throw new Error('no gz');
      var enc = (r.headers.get('content-encoding') || '').toLowerCase();
      if (enc === 'gzip' || enc === 'br') {
        return r.text().then(function (text) { (0, eval)(text); done(); });
      }
      var stream = r.body.pipeThrough(new DecompressionStream('gzip'));
      var rd = stream.getReader(), chunks = [];
      function pump() {
        return rd.read().then(function (x) {
          if (x.done) return;
          chunks.push(x.value);
          return pump();
        });
      }
      return pump().then(function () {
        var len = 0, i;
        for (i = 0; i < chunks.length; i++) len += chunks[i].byteLength;
        var buf = new Uint8Array(len), off = 0;
        for (i = 0; i < chunks.length; i++) { buf.set(chunks[i], off); off += chunks[i].byteLength; }
        (0, eval)(new TextDecoder('utf-8').decode(buf));
        done();
      });
    }).catch(fallback);
  }

  /* ---------------- 附加信息：车站档案 / 车底（meta.js，懒加载） ---------------- */
  function loadMeta(cb) {
    if (META) { if (cb) cb(); return; }
    if (metaWait) { if (cb) metaWait.then(cb); return; }
    metaWait = new Promise(function (res) {
      loadScriptGz('meta.js', function () {
        META = window.ROUTE_META || {};
        res();
        if (cb) cb();
      });
    });
  }

  /* 站名 -> 拼音检索串：全拼 + 简拼 + 电报码 */
  function ensurePy() {
    if (ST_PY || !META || !META.stations) return ST_PY;
    ST_PY = new Array(ST.length);
    for (var k = 0; k < ST.length; k++) {
      var m = META.stations[ST[k]];
      ST_PY[k] = m ? (m[1] + ' ' + m[2] + ' ' + m[0]).toLowerCase() : '';
    }
    return ST_PY;
  }

  /* file:// 下 pushState/replaceState 会抛 SecurityError，忽略即可 */
  function setHash(h, push) {
    try {
      if (push) history.pushState(null, '', h);
      else history.replaceState(null, '', h);
    } catch (e) { /* noop */ }
  }

  /* ---------------- 索引 ---------------- */
  function ensureIndex() {
    if (ST_INDEX) return ST_INDEX;
    var idx = new Array(ST.length);
    for (var k = 0; k < ST.length; k++) idx[k] = [];
    var stamp = new Int32Array(ST.length), t = 0;
    for (var no in TR) {
      t++;
      var vs = TR[no];
      for (var v = 0; v < vs.length; v++) {
        var a = vs[v];
        for (var j = 0; j < a.length; j++) {
          var sid = a[j][0];
          if (stamp[sid] !== t) { stamp[sid] = t; idx[sid].push(no); }
        }
      }
    }
    ST_INDEX = idx;
    return idx;
  }

  function atStation(no, sid) {
    var vs = TR[no];
    for (var v = 0; v < vs.length; v++) {
      var a = vs[v];
      for (var k = 0; k < a.length; k++) {
        if (a[k][0] === sid) {
          return { km: a[k][2], k: k, n: a.length, vi: v,
                   from: a[0][0], to: a[a.length - 1][0] };
        }
      }
    }
    return null;
  }

  function pairSearch(aId, bId) {
    var res = [];
    for (var no in TR) {
      var vs = TR[no];
      for (var v = 0; v < vs.length; v++) {
        var a = vs[v], from = -1, to = -1, k;
        for (k = 0; k < a.length; k++) { if (a[k][0] === aId) { from = k; break; } }
        if (from < 0) continue;
        for (k = from + 1; k < a.length; k++) { if (a[k][0] === bId) { to = k; break; } }
        if (to < 0) continue;
        res.push({
          no: no, from: from, to: to, vi: v,
          km: a[to][2] - a[from][2], n: to - from + 1,
          total: a[a.length - 1][2], totalN: a.length
        });
        break;
      }
    }
    return res.sort(function (x, y) { return cmp(x.no, y.no); });
  }

  function trainsOnLine(name) {
    var want = name.split('/');      // 手输 "A/B" 时两条线都算
    var res = [];
    for (var no in TR) {
      var vs = TR[no], hit = 0;
      for (var v = 0; v < vs.length; v++) {
        var a = vs[v];
        for (var k = 0; k < a.length; k++) {
          // 按 / 拆段精确匹配：站点线路名可能是换线站的 "A/B" 标记
          var pp = LN_PARTS[a[k][1]];
          for (var j = 0; j < pp.length; j++) {
            if (want.indexOf(pp[j]) >= 0) { hit++; break; }
          }
        }
      }
      if (hit) res.push({ no: no, n: hit });
    }
    return res.sort(function (x, y) { return cmp(x.no, y.no); });
  }

  /* ---------------- 匹配 ---------------- */
  function matchTrains(n) {
    var pre = [], has = [];
    for (var k = 0; k < KEYS.length; k++) {
      var key = KEYS[k];
      if (key.indexOf(n) === 0) pre.push(key);
      else if (key.indexOf(n) > 0) has.push(key);
    }
    return { list: pre.concat(has), total: pre.length + has.length };
  }

  function matchStations(raw) {
    var v = String(raw).toLowerCase(), ex = [], pre = [], has = [];
    for (var k = 0; k < ST.length; k++) {
      var n = ST_LO[k];
      if (n === v) ex.push(k);
      else if (n.indexOf(v) === 0) pre.push(k);
      else if (n.indexOf(v) > 0) has.push(k);
    }
    /* 拼音 / 简拼 / 电报码：meta.js 加载后才有 */
    var py = /^[a-z0-9]+$/.test(v) ? ensurePy() : null;
    if (py) {
      for (k = 0; k < ST.length; k++) {
        var p = py[k];
        if (!p) continue;
        if (p.indexOf(v) === 0 || p.indexOf(' ' + v) >= 0) pre.push(k);
        else if (p.indexOf(v) > 0) has.push(k);
      }
    }
    var all = ex.concat(pre, has), seen = Object.create(null), list = [];
    for (k = 0; k < all.length; k++) {
      if (seen[all[k]]) continue;
      seen[all[k]] = 1;
      list.push(all[k]);
    }
    return { list: list, total: list.length };
  }

  function matchLines(raw) {
    var v = String(raw).toLowerCase(), ex = [], pre = [], has = [];
    for (var k = 0; k < LN.length; k++) {
      var n = LN_LO[k];
      if (n.indexOf('/') >= 0) continue;            // 换线标记，不是线路
      if (n === v) ex.push(k);
      else if (n.indexOf(v) === 0) pre.push(k);
      else if (n.indexOf(v) > 0) has.push(k);
    }
    return { list: ex.concat(pre, has), total: ex.length + pre.length + has.length };
  }

  /* 担当（路局/客运段）索引：META.trains 第 4 位 */
  function ensureBu() {
    if (BU_SET) return;
    BU_SET = Object.create(null);
    BU_LIST = [];
    if (!META || !META.trains) return;
    for (var no in META.trains) {
      var bu = META.trains[no][3];
      if (!bu || !TR[no]) continue;
      if (!BU_SET[bu]) { BU_SET[bu] = []; BU_LIST.push(bu); }
      BU_SET[bu].push(no);
    }
    BU_LIST.sort(cmp);
  }

  function matchBu(raw) {
    ensureBu();
    var v = String(raw == null ? '' : raw).trim();
    if (!v || !BU_LIST || !BU_LIST.length) return { list: [], total: 0 };
    var ex = [], pre = [], has = [];
    for (var i = 0; i < BU_LIST.length; i++) {
      var n = BU_LIST[i];
      if (n === v) ex.push(n);
      else if (n.indexOf(v) === 0) pre.push(n);
      else if (n.indexOf(v) > 0) has.push(n);
    }
    var list = ex.concat(pre, has);
    return { list: list, total: list.length };
  }

  /* ---------------- 解析查询 ---------------- */
  var SEP = /\s*(?:到|至|→|->|—|－|~|～|-)\s*/g;

  function splitPair(s) {
    // 站名里没有空格，先按空白切，避免站名自带「到 / 至」被误切（如 到保、东至）
    var ws = s.split(/[\s\u3000]+/).filter(function (x) { return x; });
    if (ws.length === 2 && ST_ID[ws[0]] != null && ST_ID[ws[1]] != null) return ws;

    var t = s.replace(SEP, '|');
    var p = t.split('|').filter(function (x) { return x; });
    if (p.length !== 2) return null;
    if (ST_ID[p[0]] == null || ST_ID[p[1]] == null) return null;
    return p;
  }

  function parse(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return { kind: 'empty', raw: '' };
    var n = norm(s);
    if (TR[n]) return { kind: 'train', no: n, raw: s };
    if (ST_ID[s] != null) return { kind: 'station', st: ST_ID[s], raw: s };
    if (LN_SET[s] != null) return { kind: 'line', ln: s, raw: s };
    if (META) {
      ensureBu();
      if (BU_SET && BU_SET[s]) return { kind: 'bu', q: s, bu: s, raw: s };
      if (/[局段司]/.test(s)) {
        var bm = matchBu(s);
        if (bm.total) return { kind: 'bu', q: s, bu: s, raw: s };
      }
    }
    var pr = splitPair(s);
    if (pr) return { kind: 'pair', a: ST_ID[pr[0]], b: ST_ID[pr[1]], raw: s };
    return { kind: 'results', q: n, raw: s };
  }

  function fromHash() {
    var h = location.hash.slice(1);
    if (!h) return { kind: 'empty', raw: '' };
    if (h.charAt(0) === '?') {
      var m = /(?:^|&)q=([^&]*)/.exec(h.slice(1));
      return m ? parse(decodeURIComponent(m[1])) : { kind: 'empty', raw: '' };
    }
    return parse(decodeURIComponent(h));
  }

  /* ---------------- 搜索建议 ---------------- */
  function suggest(raw) {
    var v = String(raw == null ? '' : raw).trim();
    if (!v) return [];
    var t = matchTrains(norm(v));
    var st = matchStations(v);
    var ln = matchLines(v);
    var bu = META ? matchBu(v) : { list: [] };
    var cn = /[\u4e00-\u9fa5]/.test(v);
    var res = [], seen = Object.create(null);

    function add(type, val, id) {
      var key = type + ':' + val;
      if (seen[key]) return;
      seen[key] = 1;
      res.push({ t: type, v: val, id: id });
    }
    function addSt(id) { add('st', ST[id], id); }
    function addLn(id) { add('ln', LN[id], id); }
    function addTr(no) { add('train', no); }
    function addBu(name) { add('bu', name); }

    if (cn) {
      st.list.slice(0, 4).forEach(addSt);
      ln.list.slice(0, 2).forEach(addLn);
      bu.list.slice(0, 2).forEach(addBu);
      t.list.slice(0, 6).forEach(addTr);
    } else {
      t.list.slice(0, 8).forEach(addTr);
      st.list.slice(0, 3).forEach(addSt);
      ln.list.slice(0, 1).forEach(addLn);
    }
    return res.slice(0, 10);
  }

  function showAc(list) {
    items = list; active = -1;
    if (!list.length) { hideAc(); return; }
    ac.innerHTML = list.map(function (it) {
      if (it.t === 'train') {
        var v = TR[it.v][0];
        return '<li data-i="' + esc(it.v) + '"><span class="ty">车次</span><b>' + esc(it.v) + '</b>' +
          '<span class="ln"> ' + esc(stName(v[0][0])) + ' → ' +
          esc(stName(v[v.length - 1][0])) + '</span></li>';
      }
      if (it.t === 'st') {
        return '<li data-i="' + esc(it.v) + '"><span class="ty">车站</span><b>' + esc(it.v) + '</b></li>';
      }
      if (it.t === 'bu') {
        return '<li data-i="' + esc(it.v) + '"><span class="ty">担当</span><b>' + esc(it.v) + '</b></li>';
      }
      return '<li data-i="' + esc(it.v) + '"><span class="ty">线路</span><b>' + esc(it.v) + '</b></li>';
    }).join('');
    ac.hidden = false;
  }
  function hideAc() { ac.hidden = true; ac.innerHTML = ''; items = []; active = -1; }
  function moveAc(d) {
    if (ac.hidden || !items.length) return;
    active = (active + d + items.length) % items.length;
    [].forEach.call(ac.children, function (li, k) {
      li.className = k === active ? 'on' : '';
    });
  }

  /* ---------------- 浮窗（车站 / 车型 / 交路） ---------------- */
  var pop = null, popAnchor = null;

  function ensurePop() {
    if (pop) return pop;
    pop = document.createElement('div');
    pop.className = 'pop';
    pop.hidden = true;
    pop.innerHTML = '<div class="pop-hd"><b></b>' +
      '<button type="button" class="pop-x" aria-label="关闭">×</button></div>' +
      '<div class="pop-bd"></div>';
    document.body.appendChild(pop);
    pop.addEventListener('click', function (e) {
      if (e.target.closest('.pop-x')) { closePop(); return; }
      var a = e.target.closest('a');
      if (!a) return;
      var p = a.getAttribute('data-pop');
      if (p) { e.preventDefault(); openPop(p, null); return; }
      var g = a.getAttribute('data-go');
      if (g != null) { e.preventDefault(); closePop(); go(g); return; }
      var k = a.getAttribute('data-k');
      if (k) { e.preventDefault(); closePop(); openTrain(k, null); }
    });
    return pop;
  }

  function closePop() {
    if (pop) pop.hidden = true;
    popAnchor = null;
  }

  function placePop(a) {
    var r = a.getBoundingClientRect();
    var w = pop.offsetWidth, h = pop.offsetHeight;
    var left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    var top = r.bottom + 8;
    if (top + h > window.innerHeight - 10) top = Math.max(10, r.top - h - 8);
    pop.style.left = Math.max(8, left) + 'px';
    pop.style.top = top + 'px';
  }

  function openPop(key, anchor) {
    ensurePop();
    if (anchor) popAnchor = anchor;
    if (!popAnchor) return;
    pop.hidden = false;
    pop.className = 'pop' + (isMobile() ? ' sheet' : '');
    if (isMobile()) { pop.style.left = ''; pop.style.top = ''; }

    function render() {
      var body = popBody(key);
      if (!body) { closePop(); return; }
      pop.querySelector('.pop-hd b').textContent = popTitle(key);
      pop.querySelector('.pop-bd').innerHTML = body;
      if (!isMobile()) placePop(popAnchor);
    }

    if (!META) {
      pop.querySelector('.pop-hd b').textContent = '加载中…';
      pop.querySelector('.pop-bd').innerHTML = '<div class="pp">正在加载车站与车底信息…</div>';
      if (!isMobile()) placePop(popAnchor);
      loadMeta(render);
    } else {
      render();
    }
  }

  function popTitle(key) {
    var i = key.indexOf(':'), kind = key.slice(0, i), arg = key.slice(i + 1);
    if (kind === 'tn') return '同车底交路';
    if (kind === 'md') return '车型 · ' + arg;
    if (kind === 'bu') return '担当';
    return arg;
  }

  function popBody(key) {
    var i = key.indexOf(':'), kind = key.slice(0, i), arg = key.slice(i + 1);
    if (kind === 'st') return stPop(arg);
    if (kind === 'md') return mdPop(arg);
    if (kind === 'tn') return tnPop(arg);
    if (kind === 'ln') return lnPop(arg);
    if (kind === 'bu') return buPop(arg);
    return '';
  }

  function sameCity(code, self) {
    var out = [], all = META.stations;
    for (var n in all) {
      if (n !== self && all[n][3] === code) out.push(n);
      if (out.length >= 14) break;
    }
    return out;
  }

  function stPop(name) {
    var m = META.stations && META.stations[name];
    var sid = ST_ID[name];
    var h = '<div class="pp">';
    if (m) {
      h += '<dl><dt>电报码</dt><dd>' + esc(m[0]) + '</dd>' +
        '<dt>拼音</dt><dd>' + esc(m[1]) + '（' + esc(m[2]) + '）</dd>' +
        '<dt>城市</dt><dd>' + esc(m[4]) + '</dd></dl>';
      var same = sameCity(m[3], name);
      if (same.length) {
        h += '<div class="ps">同城站</div><div class="pl">' + same.map(function (n) {
          return '<a href="#" data-pop="st:' + esc(n) + '">' + esc(n) + '</a>';
        }).join('') + '</div>';
      }
    }
    if (sid != null) {
      h += '<div class="ps">途经 ' + num((ensureIndex()[sid] || []).length) + ' 个车次</div>' +
        '<div class="pl"><a href="#" data-go="' + esc(name) + '">查看全部车次 →</a></div>';
    } else {
      h += '<div class="ps">该站没有经由数据</div>';
    }
    return h + '</div>';
  }

  function mdPop(model) {
    var list = [], descs = {}, all = META.trains;
    for (var no in all) {
      if (all[no][0] !== model) continue;
      list.push(no);
      if (all[no][1]) descs[all[no][1]] = 1;
    }
    list.sort(cmp);
    var h = '<div class="pp">';
    var ds = Object.keys(descs);
    if (ds.length) {
      h += '<div class="ps">编组 / 车底</div><div class="pl">' + ds.slice(0, 6).map(function (d) {
        return '<span class="tagx">' + esc(d) + '</span>';
      }).join('') + (ds.length > 6 ? '<span class="tagx">…</span>' : '') + '</div>';
    }
    h += '<div class="ps">同车型 ' + num(list.length) + ' 个车次</div><div class="pl">' +
      list.slice(0, 40).map(function (no) {
        return '<a href="#" data-k="' + esc(no) + '">' + esc(no) + '</a>';
      }).join('') + (list.length > 40 ? ' …' : '') + '</div>';
    return h + '</div>';
  }

  function tnPop(no) {
    var m = META.trains[no];
    var g = (m && META.turns[m[2]]) || [];
    var h = '<div class="pp"><div class="pl">' + g.filter(function (t) {
      return !!TR[t];
    }).map(function (t) {
      return t === no ? '<b>' + esc(t) + '</b>'
        : '<a href="#" data-k="' + esc(t) + '">' + esc(t) + '</a>';
    }).join(' → ') + '</div>';
    if (m && m[1]) h += '<div class="ps">' + esc(m[1]) + '</div>';
    return h + '</div>';
  }

  /* 线路卡：站数 / 里程 / 车次数 + 前几站 + 线路页入口 */
  function lnPop(name) {
    var via = LST[name] || null;
    var n = trainsOnLine(name).length;
    var h = '<div class="pp">';
    if (via && via.length) {
      var km = via[via.length - 1][1] - via[0][1];
      h += '<div class="ps">' + num(via.length) + ' 站 · ' + num(km) + ' km · ' +
        num(n) + ' 个车次</div>' +
        '<div class="pl"><b>' + esc(via[0][0]) + ' → ' +
        esc(via[via.length - 1][0]) + '</b></div>' +
        '<div class="pl">' + via.slice(0, 8).map(function (s) {
          return stLinkName(s[0]);
        }).join('') + (via.length > 8 ? ' …' : '') + '</div>';
    } else {
      h += '<div class="ps">' + num(n) + ' 个车次</div>';
    }
    if (name.indexOf('/') >= 0) {
      h += '<div class="ps">这是换线站上的线路标记，不是独立线路</div><div class="pl">' +
        name.split('/').map(function (p) {
          return '<a href="#" data-pop="ln:' + esc(p) + '">' + esc(p) + '</a>';
        }).join('') + '</div>';
    }
    h += '<div class="pl"><a href="#" data-go="' + esc(name) + '">查看线路页 →</a></div>';
    return h + '</div>';
  }

  /* 担当卡：extra.dat 名称池里的单位 + 同担当车次 */
  function buPop(no) {
    var m = META.trains[no] || [];
    var bu = m[3];
    if (!bu) return '';
    var list = [];
    for (var t in META.trains) {
      if (META.trains[t][3] === bu && TR[t]) list.push(t);
    }
    list.sort(cmp);
    var h = '<div class="pp"><div class="pl"><b>' + esc(bu) + '</b></div>' +
      '<div class="ps">同担当 ' + num(list.length) + ' 个车次</div><div class="pl">' +
      list.slice(0, 40).map(function (t) {
        return '<a href="#" data-k="' + esc(t) + '">' + esc(t) + '</a>';
      }).join('') + (list.length > 40 ? ' …' : '') + '</div>' +
      '<div class="pl"><a href="#" data-go="' + esc(bu) + '">查看担当页 →</a></div>';
    return h + '</div>';
  }

  /* 车次页头部：车型 / 编组 / 交路 chips（meta.js 到位后填充） */
  function fillChips(no) {
    function draw() {
      var box = out.querySelector('#chips');
      if (!box) return;
      var m = META.trains && META.trains[no];
      if (!m) { if (box.parentNode) box.parentNode.removeChild(box); return; }
      var model = m[0], desc = m[1] || model, gi = m[2], html = '';
      if (model) {
        html += '<button type="button" class="chip k" data-pop="md:' + esc(model) + '">' +
          esc(model) + '</button>';
      }
      (desc && desc !== model ? desc.split(/[,，;；]/) : []).forEach(function (f) {
        f = f.trim();
        if (!f || f === model || f === model + '型') return;
        html += '<button type="button" class="chip" data-pop="md:' +
          esc(model || f) + '">' + esc(f) + '</button>';
      });
      var g = META.turns && META.turns[gi];
      if (g && g.length > 1) {
        html += '<button type="button" class="chip" data-pop="tn:' + esc(no) + '">' +
          '同车底 ' + (g.length - 1) + ' 车次</button>';
      }
      if (m[3]) {
        html += '<button type="button" class="chip k" data-pop="bu:' + esc(no) + '">' +
          esc(m[3]) + '</button>';
      }
      var eat = META.eat && META.eat[no];
      if (eat) {
        html += '<span class="chip">' +
          esc(eat.indexOf('[餐]') >= 0 ? '餐车 ' + eat.replace('[餐]', '') : eat) + '</span>';
      }
      box.innerHTML = html;
    }
    if (META) draw(); else loadMeta(draw);
  }

  /* 线路页头部：起终 + 车型分布（meta 到位后填） */
  function fillLineChips(name) {
    var box = out.querySelector('#lchips');
    if (!box) return;
    var via = LST[name] || [];
    var head = via.length ? '<span class="chip k">' + esc(via[0][0]) + ' → ' +
      esc(via[via.length - 1][0]) + '</span>' : '';
    function draw() {
      var b = out.querySelector('#lchips');
      if (!b) return;
      var cnt = {}, list = trainsOnLine(name);
      for (var i = 0; i < list.length; i++) {
        var m = META.trains && META.trains[list[i].no];
        if (m && m[0]) cnt[m[0]] = (cnt[m[0]] || 0) + 1;
      }
      var arr = Object.keys(cnt).map(function (k) { return [k, cnt[k]]; });
      arr.sort(function (x, y) { return y[1] - x[1]; });
      b.innerHTML = head + arr.slice(0, 5).map(function (x) {
        return '<button type="button" class="chip" data-pop="md:' + esc(x[0]) + '">' +
          esc(x[0]) + ' ' + x[1] + '</button>';
      }).join('');
    }
    box.innerHTML = head;
    if (META) draw(); else loadMeta(draw);
  }

  /* 车站页头部：同城站 + 主要线路 */
  function stationLines(sid) {
    var idx = ensureIndex(), trains = idx[sid] || [], cnt = {};
    for (var i = 0; i < trains.length; i++) {
      var vs = TR[trains[i]];
      for (var v = 0; v < vs.length; v++) {
        var a = vs[v];
        for (var k = 0; k < a.length; k++) {
          if (a[k][0] !== sid) continue;
          var parts = lnName(a[k][1]).split('/');
          for (var j = 0; j < parts.length; j++) cnt[parts[j]] = (cnt[parts[j]] || 0) + 1;
          break;
        }
      }
    }
    var arr = Object.keys(cnt).map(function (n) { return [n, cnt[n]]; });
    arr.sort(function (x, y) { return y[1] - x[1]; });
    return arr;
  }

  function fillStationChips(sid) {
    var name = ST[sid];
    var total = (ensureIndex()[sid] || []).length;
    function draw() {
      var box = out.querySelector('#schips');
      if (!box) return;
      var m = META && META.stations && META.stations[name];
      if (m) {
        var sm = out.querySelector('#smeta');
        if (sm) sm.textContent = m[0] + ' · ' + m[1] + ' · ' + m[4] + ' · 途经 ' + num(total) + ' 个车次';
      }
      var same = m ? sameCity(m[3], name).slice(0, 8) : [];
      var lines = stationLines(sid).slice(0, 5);
      var html = '';
      if (same.length) {
        html += '<span class="clab">同城站</span>' + same.map(function (n) {
          return '<a class="chip" href="#" data-pop="st:' + esc(n) + '">' + esc(n) + '</a>';
        }).join('');
      }
      if (lines.length) {
        html += '<span class="clab">主要线路</span>' + lines.map(function (x) {
          return '<a class="chip" href="#" data-pop="ln:' + esc(x[0]) + '">' +
            esc(x[0]) + ' ' + x[1] + '</a>';
        }).join('');
      }
      box.innerHTML = html;
    }
    draw();
    if (!META) loadMeta(draw);
  }

  /* ---------------- 线路图（OpenRailwayMap / OSM，懒加载） ---------------- */
  var RAIL = window.RAIL_DATA || null;
  var railWait = null;
  var MAP_OPEN = (function () {
    try {
      var v = localStorage.getItem('mapOpen');
      if (v === '0') return false;
      if (v === '1') return true;
    } catch (e) { /* noop */ }
    return !isMobile();
  })();

  function loadRail(cb) {
    if (RAIL) { if (cb) cb(); return; }
    if (railWait) { if (cb) railWait.then(cb); return; }
    railWait = new Promise(function (res) {
      loadScriptGz('railmap.js', function () {
        RAIL = window.RAIL_DATA || {};
        res();
        if (cb) cb();
      });
    });
  }

  /* polyline 解码（精度 1e5） */
  function decLine(s) {
    var out = [], i = 0, lat = 0, lon = 0;
    while (i < s.length) {
      var k, b, shift, res, d;
      for (k = 0; k < 2; k++) {
        shift = 0; res = 0;
        do {
          b = s.charCodeAt(i++) - 63;
          res |= (b & 0x1f) << shift;
          shift += 5;
        } while (b >= 0x20);
        d = (res & 1) ? ~(res >> 1) : (res >> 1);
        if (k === 0) lat += d; else lon += d;
      }
      out.push([lat / 1e5, lon / 1e5]);
    }
    return out;
  }

  var MPAL = ['#dc2626', '#ea580c', '#d97706', '#65a30d', '#059669', '#0891b2',
    '#2563eb', '#7c3aed', '#c026d3', '#db2777', '#475569', '#0d9488'];

  function lineColor(name) {
    var s = String(name).split('/')[0];
    if (RAIL && RAIL.l && RAIL.l[s] && RAIL.l[s].c) return RAIL.l[s].c;
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return MPAL[Math.abs(h) % MPAL.length];
  }

  function colorsFor(names) {
    var out = {}, last = '';
    names.forEach(function (n) {
      var c = lineColor(n);
      if (c === last) c = MPAL[(MPAL.indexOf(c) + 1) % MPAL.length];
      out[n] = c;
      last = c;
    });
    return out;
  }

  function pickLine(id) {
    var parts = lnName(id).split('/');
    for (var i = 0; i < parts.length; i++) {
      if (RAIL && RAIL.l && RAIL.l[parts[i]]) return parts[i];
    }
    return parts[0];
  }

  function d2(a, b) {
    var dy = a[0] - b[0], dx = (a[1] - b[1]) * Math.cos(a[0] * Math.PI / 180);
    return dx * dx + dy * dy;
  }

  function nearestIdx(pts, p) {
    var bi = -1, bd = Infinity;
    for (var i = 0; i < pts.length; i++) {
      var d = d2(pts[i], p);
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  }

  /* 在一条线的几何上截取 A→B 之间的一段 */
  function sliceLine(geo, a, b) {
    if (!geo || !geo.g || !geo.g.length) return null;
    var best = null, score = Infinity;
    for (var k = 0; k < geo.g.length; k++) {
      var pts = decLine(geo.g[k]);
      if (pts.length < 2) continue;
      var ia = nearestIdx(pts, a), ib = nearestIdx(pts, b);
      if (ia < 0 || ib < 0) continue;
      var da = d2(pts[ia], a), db = d2(pts[ib], b);
      if (da > 0.04 || db > 0.04) continue;          // 超过约 20 km 视为不在同一条线上
      var lo = Math.min(ia, ib), hi = Math.max(ia, ib);
      var sub = pts.slice(lo, hi + 1);
      if (ia > ib) sub.reverse();
      var cand = [a].concat(sub, [b]);
      if (da + db < score) { score = da + db; best = cand; }
    }
    return best;
  }

  function trainSpec(no, tab) {
    var st = TR[no][tab], segs = [], names = [], stations = [], seen = {};
    for (var i = 0; i < st.length; i++) {
      var nm = stName(st[i][0]);
      var ln = pickLine(st[i][1]);
      var geo = RAIL.l && RAIL.l[ln];
      var p = (RAIL.s && RAIL.s[nm]) || null;
      if (p && !seen[nm]) {
        seen[nm] = 1;
        stations.push({
          name: nm, lat: p[0], lon: p[1], idx: i,
          first: i === 0, last: i === st.length - 1,
          chg: lnName(st[i][1]).indexOf('/') >= 0
        });
      }
      if (i === st.length - 1) break;
      var nb = stName(st[i + 1][0]);
      var q = (RAIL.s && RAIL.s[nb]) || null;
      if (!p || !q) continue;
      var pts = geo ? sliceLine(geo, p, q) : null;
      if (!pts) pts = [p, q];
      if (names.indexOf(ln) < 0) names.push(ln);
      var ea = timeAt(no, tab, i), eb = timeAt(no, tab, i + 1);
      segs.push({
        line: ln, pts: pts, from: i, to: i + 1,
        dep: ea ? ea[2] : null, arr: eb ? eb[1] : null
      });
    }
    var cols = colorsFor(names), merged = [];
    segs.forEach(function (s) {
      var last = merged[merged.length - 1];
      if (last && last.line === s.line) {
        for (var i = 1; i < s.pts.length; i++) last.pts.push(s.pts[i]);
      } else {
        merged.push({ line: s.line, pts: s.pts.slice() });
      }
    });
    /* 相邻两个办客站之间的完整路径，用于按时刻估算位置 */
    var tm = TM[no] && TM[no][tab] || [];
    var timed = [];
    for (var ti = 0; ti < tm.length - 1; ti++) {
      var ta = tm[ti], tb = tm[ti + 1];
      if (ta[2] == null || tb[1] == null) continue;
      var tpts = [];
      for (var si = 0; si < segs.length; si++) {
        var sg = segs[si];
        if (sg.from < ta[0] || sg.to > tb[0]) continue;
        for (var pi = 0; pi < sg.pts.length; pi++) {
          var q = sg.pts[pi], last = tpts[tpts.length - 1];
          if (!last || last[0] !== q[0] || last[1] !== q[1]) tpts.push(q);
        }
      }
      if (tpts.length > 1) timed.push({
        dep: ta[2], arr: tb[1], pts: tpts, from: ta[0], to: tb[0],
        fromName: stName(st[ta[0]][0]), toName: stName(st[tb[0]][0])
      });
    }
    return {
      paths: merged.map(function (m) {
        return { name: m.line, color: cols[m.line] || lineColor(m.line), pts: m.pts };
      }),
      stations: stations,
      names: names,
      cols: cols,
      segs: segs,
      timed: timed,
      st: st
    };
  }

  function flatten(paths) {
    var pts = [];
    paths.forEach(function (p) {
      p.pts.forEach(function (q) {
        var last = pts[pts.length - 1];
        if (!last || last[0] !== q[0] || last[1] !== q[1]) pts.push(q);
      });
    });
    return pts;
  }

  function lineSpec(name) {
    var via = LST[name] || [], paths = [], stations = [];
    var geo = RAIL.l && RAIL.l[name];
    if (geo && geo.g) {
      geo.g.forEach(function (s) {
        var pts = decLine(s);
        if (pts.length > 1) paths.push({ name: name, color: lineColor(name), pts: pts });
      });
    }
    if (!paths.length) {
      var pts = via.map(function (s) { return RAIL.s && RAIL.s[s[0]]; }).filter(Boolean);
      if (pts.length > 1) paths.push({ name: name, color: lineColor(name), pts: pts });
    }
    via.forEach(function (s, idx) {
      var p = RAIL.s && RAIL.s[s[0]];
      if (p) {
        stations.push({
          name: s[0], lat: p[0], lon: p[1], idx: idx,
          first: idx === 0, last: idx === via.length - 1
        });
      }
    });
    var c = {}; c[name] = lineColor(name);
    return { paths: paths, stations: stations, names: [name], cols: c };
  }

  function arcOfPts(pts) {
    var cum = [0];
    for (var i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.sqrt(d2(pts[i - 1], pts[i])));
    }
    return { pts: pts, cum: cum, total: cum[cum.length - 1] || 0 };
  }

  function pointAtArc(arc, f) {
    if (!arc || arc.pts.length < 2) return null;
    var target = Math.max(0, Math.min(1, f)) * arc.total, i = 1;
    while (i < arc.cum.length - 1 && arc.cum[i] < target) i++;
    var a = arc.pts[i - 1], b = arc.pts[i];
    var seg = Math.sqrt(d2(a, b)) || 1;
    var t = (target - arc.cum[i - 1]) / seg;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  /* 按当前时刻和区间时刻，估算列车在本段几何上的位置 */
  function estimatedNow(spec) {
    if (!spec.timed || !spec.timed.length) return null;
    var d = new Date(), now = d.getHours() * 60 + d.getMinutes();
    var first = null, last = null;
    spec.timed.forEach(function (s) {
      if (s.dep != null && (first == null || s.dep < first)) first = s.dep;
      if (s.arr != null && (last == null || s.arr > last)) last = s.arr;
    });
    if (first == null || last == null) return null;
    var t = now;
    if (t < first && last > 1440 && t + 1440 <= last) t += 1440;
    if (t < first || t > last) return null;
    for (var i = 0; i < spec.timed.length; i++) {
      var s = spec.timed[i];
      if (s.dep == null || s.arr == null) continue;
      if (t >= s.dep && t <= s.arr) {
        var f = s.arr > s.dep ? (t - s.dep) / (s.arr - s.dep) : 0;
        var p = pointAtArc(arcOfPts(s.pts), f);
        var st = spec.st || [];
        var km = (st[s.from] && st[s.to]) ? st[s.from][2] + f * (st[s.to][2] - st[s.from][2]) : 0;
        var seg = kmSegment(st, km);
        var fromName = seg ? stName(st[seg.from][0]) : s.fromName;
        var toName = seg ? stName(st[seg.to][0]) : s.toName;
        return p ? {
          lat: p[0], lon: p[1], t: t,
          fromName: fromName, toName: toName,
          dwell: false, atStation: seg ? seg.at : false
        } : null;
      }
      if (t > s.arr && i + 1 < spec.timed.length) {
        var n = spec.timed[i + 1];
        if (n.dep != null && t < n.dep) {
          var q = s.pts[s.pts.length - 1];
          return q ? {
            lat: q[0], lon: q[1], t: t,
            fromName: s.toName, toName: s.toName, dwell: true, nextDep: n.dep
          } : null;
        }
      }
    }
    return null;
  }

  function fmtNow(t) {
    var d = Math.floor(t / 1440), m = t - d * 1440;
    return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60) + (d ? '+' + d : '');
  }

  function nowStatus(est) {
    if (!est) return '';
    if (est.dwell) return ' · ' + est.toName + ' 停站至 ' + fmtNow(est.nextDep);
    if (est.atStation) return ' · ' + est.toName + ' 附近';
    return ' · ' + est.fromName + ' → ' + est.toName;
  }

  function kmSegment(st, km) {
    if (!st || !st.length) return null;
    if (km <= st[0][2]) return { from: 0, to: 0, at: true };
    if (km >= st[st.length - 1][2]) return { from: st.length - 1, to: st.length - 1, at: true };
    var i;
    for (i = 0; i < st.length; i++) {
      if (Math.abs(st[i][2] - km) <= 0.5) return { from: i, to: i, at: true };
    }
    for (i = 0; i < st.length - 1; i++) {
      if (km >= st[i][2] && km <= st[i + 1][2]) return { from: i, to: i + 1, at: false };
    }
    return { from: st.length - 1, to: st.length - 1, at: true };
  }

  /* 画图：viewBox 固定，字号/点径按容器宽度换算，保证屏幕上大小稳定 */
  var VBW = 720, VBH = 620, mapRender = null, mapTimer = null, nowTimer = null, liveTimer = null, hotLine = '';

  function drawRailMap(box, spec) {
    if (nowTimer && typeof clearInterval === 'function') { clearInterval(nowTimer); nowTimer = null; }
    var all = flatten(spec.paths);
    if (!all.length) {
      all = (spec.stations || []).map(function (s) { return [s.lat, s.lon]; });
    }
    if (!all.length) {
      box.innerHTML = '<div class="map-skel">暂无该线路的坐标数据</div>';
      return;
    }
    var lat0 = 0;
    all.forEach(function (p) { lat0 += p[0]; });
    lat0 /= all.length;
    var kx = Math.cos(lat0 * Math.PI / 180);

    var minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    all.forEach(function (p) {
      var x = p[1] * kx, y = -p[0];
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
    });
    spec.stations.forEach(function (s) {
      var x = s.lon * kx, y = -s.lat;
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
    });
    var pad = Math.max((maxx - minx), (maxy - miny)) * 0.06 + 1e-4;
    minx -= pad; maxx += pad; miny -= pad; maxy += pad;

    var vw = maxx - minx, vh = maxy - miny;
    if (vw / vh > VBW / VBH) vh = vw * VBH / VBW;
    else vw = vh * VBW / VBH;
    var view = { x: (minx + maxx) / 2 - vw / 2, y: (miny + maxy) / 2 - vh / 2, w: vw, h: vh };

    box.innerHTML =
      '<div class="map-hd"><b>线路图</b><span>' +
      (spec.paths.length > 1 ? spec.paths.length + ' 段' : '') +
      '</span><span class="sp"></span>' +
      '<button type="button" class="map-reset">复位</button></div>' +
      '<div class="mapwrap"><svg class="rmap" viewBox="0 0 ' + VBW + ' ' + VBH +
      '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="线路示意图"></svg></div>' +
      '<div class="map-lg"></div>';

    var svg = box.querySelector('.rmap');
    var wrap = box.querySelector('.mapwrap');
    var mapProject = null, nowMarker = null;

    function render() {
      var cw = wrap.clientWidth || 380;
      var k = VBW / cw;
      var scale = Math.min(VBW / view.w, VBH / view.h);
      var ox = (VBW - view.w * scale) / 2 - view.x * scale;
      var oy = (VBH - view.h * scale) / 2 - view.y * scale;
      function X(p) { return p[1] * kx * scale + ox; }
      function Y(p) { return -p[0] * scale + oy; }

      var fs = 11 * k, dotR = 3.2 * k, halo = 3 * k, lineW = 3;
      var html = '';
      var est = spec.kind === 'train' ? estimatedNow(spec) : null;

      var legend = '';
      spec.names.forEach(function (n) {
        if (!n) return;
        legend += '<a href="#" data-go="' + esc(n) + '" data-hl="' + esc(n) + '"><i style="background:' +
          (spec.cols[n] || lineColor(n)) + '"></i>' + esc(n) + '</a>';
      });
      if (est) legend += '<span class="map-now"><i></i>估算位置 <span class="mp-now-t">' + fmtNow(est.t) +
        '</span><span class="mp-now-s">' + esc(nowStatus(est)) + '</span></span>';
      box.querySelector('.map-lg').innerHTML = legend;

      spec.paths.forEach(function (p) {
        if (p.pts.length < 2) return;
        var d = '';
        for (var i = 0; i < p.pts.length; i++) {
          d += (i ? 'L' : 'M') + X(p.pts[i]).toFixed(1) + ' ' + Y(p.pts[i]).toFixed(1);
        }
        html += '<path class="mp-ln" data-line="' + esc(p.name) + '" d="' + d +
          '" fill="none" stroke="' + p.color +
          '" stroke-width="' + lineW + '" stroke-linejoin="round" stroke-linecap="round"' +
          ' vector-effect="non-scaling-stroke" opacity=".92"></path>';
      });

      var placed = [], labels = '';
      var order = spec.stations.slice().sort(function (a, b) {
        return (b.first || b.last || b.chg ? 1 : 0) - (a.first || a.last || a.chg ? 1 : 0);
      });
      order.forEach(function (s) {
        var x = X([s.lat, s.lon]), y = Y([s.lat, s.lon]);
        var w = s.name.length * fs * 0.98 + 4, h = fs * 1.15;
        var cand = [
          [x + dotR + 3, y + fs * 0.36, 'start', x + dotR + 2, y - h / 2],
          [x - dotR - 3, y + fs * 0.36, 'end', x - dotR - 2 - w, y - h / 2],
          [x, y - dotR - 4, 'middle', x - w / 2, y - dotR - 4 - h],
          [x, y + dotR + fs + 2, 'middle', x - w / 2, y + dotR + 2]
        ];
        var pick = null;
        for (var i = 0; i < cand.length; i++) {
          var r = [cand[i][3], cand[i][4], w, h];
          var ok = true;
          for (var j = 0; j < placed.length; j++) {
            var q = placed[j];
            if (r[0] < q[0] + q[2] && q[0] < r[0] + r[2] &&
                r[1] < q[1] + q[3] && q[1] < r[1] + r[3]) { ok = false; break; }
          }
          if (ok) { pick = cand[i]; placed.push(r); break; }
        }
        if (!pick && (s.first || s.last)) { pick = cand[0]; placed.push([cand[0][3], cand[0][4], w, h]); }
        if (pick) {
          labels += '<text x="' + pick[0].toFixed(1) + '" y="' + pick[1].toFixed(1) +
            '" text-anchor="' + pick[2] + '" font-size="' + fs.toFixed(1) +
            '" fill="' + (s.first || s.last ? '#111827' : '#4b5563') +
            '" font-weight="' + (s.first || s.last ? '600' : '400') +
            '" stroke="#fbfcfe" stroke-width="' + halo.toFixed(1) +
            '" paint-order="stroke">' + esc(s.name) + '</text>';
        }
      });

      var dots = '';
      spec.stations.forEach(function (s) {
        var x = X([s.lat, s.lon]), y = Y([s.lat, s.lon]);
        dots += '<g class="mp-st" data-pop="st:' + esc(s.name) + '">' +
          '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' +
          (s.first || s.last ? dotR * 1.35 : dotR).toFixed(1) + '" fill="' +
          (s.first || s.last ? '#111827' : (s.est ? '#fff' : '#fff')) +
          '" stroke="' + (s.est ? '#9aa1ab' : (s.first || s.last ? '#111827' : '#4b5563')) +
          '" stroke-width="' + (s.est ? 1.2 : 1.5) + '"' +
          (s.est ? ' stroke-dasharray="2 2"' : '') + '></circle>' +
          '<title>' + esc(s.name) + '</title></g>';
      });

      /* 线名标在最长的一段上 */
      var lineLabels = '';
      spec.paths.forEach(function (p) {
        var best = 0, bx = 0, by = 0, ba = 0;
        for (var i = 1; i < p.pts.length; i++) {
          var x1 = X(p.pts[i - 1]), y1 = Y(p.pts[i - 1]);
          var x2 = X(p.pts[i]), y2 = Y(p.pts[i]);
          var len = Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1));
          if (len > best) {
            best = len; bx = (x1 + x2) / 2; by = (y1 + y2) / 2;
            ba = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
          }
        }
        if (best < 46 || !p.name) return;
        if (ba > 90) ba -= 180;
        if (ba < -90) ba += 180;
        lineLabels += '<text x="' + bx.toFixed(1) + '" y="' + by.toFixed(1) +
          '" text-anchor="middle" font-size="' + (fs * 0.92).toFixed(1) +
          '" fill="' + p.color + '" font-weight="600" opacity=".85"' +
          ' transform="rotate(' + ba.toFixed(1) + ' ' + bx.toFixed(1) + ' ' + by.toFixed(1) + ')"' +
          ' stroke="#fbfcfe" stroke-width="' + halo.toFixed(1) + '" paint-order="stroke">' +
          esc(p.name) + '</text>';
      });

      var nowHtml = '';
      if (est) {
        var ex = X([est.lat, est.lon]), ey = Y([est.lat, est.lon]);
        var r0 = 4 * k, r1 = 8 * k;
        nowHtml = '<g class="mp-now" style="transform:translate(' + ex.toFixed(1) + 'px,' + ey.toFixed(1) + 'px)">' +
          '<circle cx="0" cy="0" r="' + r0.toFixed(1) + '" fill="#16a34a" stroke="#fff" stroke-width="' + (1.6 * k).toFixed(1) + '">' +
          '<animate attributeName="r" values="' + r0.toFixed(1) + ';' + r1.toFixed(1) + ';' + r0.toFixed(1) + '" dur="1.4s" repeatCount="indefinite"/>' +
          '<animate attributeName="opacity" values="1;.55;1" dur="1.4s" repeatCount="indefinite"/>' +
          '</circle></g>';
      }
      svg.innerHTML = html + dots + labels + lineLabels + nowHtml;
      mapProject = function (lat, lon) { return [X([lat, lon]), Y([lat, lon])]; };
      nowMarker = svg.querySelector('.mp-now');
      if (hotLine) paintHl(hotLine);
    }

    function updateNow() {
      var est = estimatedNow(spec);
      if (!est) {
        if (nowMarker && nowMarker.parentNode) nowMarker.parentNode.removeChild(nowMarker);
        nowMarker = null;
        var item = box.querySelector('.map-now');
        if (item && item.parentNode) item.parentNode.removeChild(item);
        return;
      }
      if (!nowMarker || !mapProject) { render(); return; }
      var p = mapProject(est.lat, est.lon);
      nowMarker.style.transform = 'translate(' + p[0].toFixed(1) + 'px,' + p[1].toFixed(1) + 'px)';
      var tEl = box.querySelector('.mp-now-t');
      if (tEl) tEl.textContent = fmtNow(est.t);
      var sEl = box.querySelector('.mp-now-s');
      if (sEl) sEl.textContent = nowStatus(est);
    }

    mapRender = render;
    render();

    if (nowTimer && typeof clearInterval === 'function') { clearInterval(nowTimer); nowTimer = null; }
    if (spec.kind === 'train' && typeof setInterval === 'function') {
      nowTimer = setInterval(updateNow, 1000);
    }

    var reset = box.querySelector('.map-reset');
    reset.addEventListener('click', function () {
      view = { x: (minx + maxx) / 2 - vw / 2, y: (miny + maxy) / 2 - vh / 2, w: vw, h: vh };
      render();
    });

    var drag = null, moved = false;
    svg.addEventListener('pointerdown', function (e) {
      drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
      moved = false;
      if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      var cw = wrap.clientWidth || 380;
      var sc = Math.min(VBW / view.w, VBH / view.h);
      view.x = drag.vx - dx / sc;
      view.y = drag.vy - dy / sc;
      render();
    });
    function endDrag() { drag = null; }
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);
    svg.addEventListener('click', function (e) {
      if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; }
    }, true);

    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r = svg.getBoundingClientRect();
      var sx = (e.clientX - r.left) / r.width, sy = (e.clientY - r.top) / r.height;
      var scale = Math.min(VBW / view.w, VBH / view.h);
      var wx = view.x + (sx * VBW - (VBW - view.w * scale) / 2) / scale;
      var wy = view.y + (sy * VBH - (VBH - view.h * scale) / 2) / scale;
      var f = Math.exp(e.deltaY * 0.0012);
      var nw = Math.max(vw * 0.02, Math.min(vw * 2, view.w * f));
      var nh = nw * view.h / view.w;
      view.x = wx - sx * nw;
      view.y = wy - sy * nh;
      view.w = nw;
      view.h = nh;
      render();
    }, { passive: false });
  }

  function paintHl(name) {
    var rmap = out.querySelector('.rmap');
    if (!rmap) return;
    var parts = String(name).split('/');
    var paths = rmap.querySelectorAll('path.mp-ln');
    var any = false, i;
    for (i = 0; i < paths.length; i++) {
      if (parts.indexOf(paths[i].getAttribute('data-line')) >= 0) { any = true; break; }
    }
    for (i = 0; i < paths.length; i++) {
      var on = parts.indexOf(paths[i].getAttribute('data-line')) >= 0;
      if (paths[i].classList) {
        paths[i].classList.toggle('hot', on);
        paths[i].classList.toggle('dim', any && !on);
      }
    }
  }

  function hlLine(name) {
    hotLine = name || '';
    paintHl(hotLine);
  }

  function clearHl() {
    hotLine = '';
    var rmap = out.querySelector('.rmap');
    if (!rmap) return;
    var paths = rmap.querySelectorAll('path.mp-ln');
    for (var i = 0; i < paths.length; i++) {
      if (paths[i].classList) {
        paths[i].classList.remove('hot');
        paths[i].classList.remove('dim');
      }
    }
  }

  function fillTrainMap(no, tab) {
    var box = out.querySelector('#mapcol');
    if (!box) return;
    if (!MAP_OPEN) { box.innerHTML = ''; return; }
    if (!RAIL) {
      box.innerHTML = '<div class="map-hd"><b>线路图</b></div><div class="map-skel">正在加载线路数据…</div>';
      loadRail(function () { fillTrainMap(no, tab); });
      return;
    }
    var st = TR[no][tab];
    var spec = trainSpec(no, tab);
    spec.kind = 'train';
    spec.miss = st.length - spec.stations.length;
    drawRailMap(box, spec);
  }

  function fillLineMap(name) {
    var box = out.querySelector('#mapcol');
    if (!box) return;
    if (!MAP_OPEN) { box.innerHTML = ''; return; }
    if (!RAIL) {
      box.innerHTML = '<div class="map-hd"><b>线路图</b></div><div class="map-skel">正在加载线路数据…</div>';
      loadRail(function () { fillLineMap(name); });
      return;
    }
    var spec = lineSpec(name);
    spec.kind = 'line';
    spec.est = spec.stations.filter(function (s) { return s.est; }).length;
    drawRailMap(box, spec);
  }

  function elecName(v) {
    if (v === 'contact_line') return '接触网';
    if (v === 'rail') return '第三轨';
    if (v === 'yes') return '有';
    if (v === 'no') return '无';
    return v;
  }

  function fillLineFacts(name) {
    var box = out.querySelector('#lfacts');
    if (!box) return;
    var via = LST[name] || [], km = via.length ? via[via.length - 1][1] - via[0][1] : 0;
    var t = (RAIL && RAIL.l && RAIL.l[name] && RAIL.l[name].t) || {};
    var rows = [];
    if (t.lineType) rows.push(['类型', t.lineType]);
    if (t.operator) rows.push(['运营', t.operator]);
    var params = t.params || {};
    var keys = Object.keys(params);
    if (keys.length) {
      keys.forEach(function (k) { rows.push([k, params[k]]); });
    } else {
      if (t.maxspeed) rows.push(['最高时速', t.maxspeed + ' km/h']);
      if (t.tracks) rows.push(['正线', t.tracks + ' 条']);
      if (t.electrified) rows.push(['电气化', elecName(t.electrified)]);
      if (t.gauge) rows.push(['轨距', t.gauge + ' mm']);
      if (t.opening_date) rows.push(['开通', t.opening_date]);
    }
    if (km) rows.push(['里程', num(km) + ' km']);
    if (via.length) rows.push(['车站', num(via.length) + ' 站']);
    var h = rows.map(function (r) {
      return '<span><span class="k">' + esc(r[0]) + '</span><b>' + esc(r[1]) + '</b></span>';
    }).join('');
    if (!RAIL) h += '<span class="k">线路资料加载中…</span>';
    else if (!rows.length) h += '<span class="k">暂无线路技术参数</span>';
    box.innerHTML = h;
  }

  function mapBtn() {
    return '<button type="button" class="mapbtn" data-map="1" aria-expanded="' +
      (MAP_OPEN ? 'true' : 'false') + '">' + (MAP_OPEN ? '收起线路图' : '线路图') + '</button>';
  }

  function toggleMap() {
    MAP_OPEN = !MAP_OPEN;
    try { localStorage.setItem('mapOpen', MAP_OPEN ? '1' : '0'); } catch (e) { /* noop */ }
    out.className = 'wrap' + (MAP_OPEN && (S.kind === 'train' || S.kind === 'line') ? ' wide' : '');
    var card = out.querySelector('.card');
    if (card && card.classList) card.classList.toggle('mapoff', !MAP_OPEN);
    var btn = out.querySelector('[data-map]');
    if (btn) {
      btn.setAttribute('aria-expanded', MAP_OPEN ? 'true' : 'false');
      btn.textContent = MAP_OPEN ? '收起线路图' : '线路图';
    }
    if (MAP_OPEN) {
      if (S.kind === 'train') fillTrainMap(S.no, S.tab || 0);
      else if (S.kind === 'line') fillLineMap(S.ln);
    } else {
      if (nowTimer && typeof clearInterval === 'function') { clearInterval(nowTimer); nowTimer = null; }
      mapRender = null;
      var box = out.querySelector('#mapcol');
      if (box) box.innerHTML = '';
    }
  }

  /* ---------------- 视图 ---------------- */
  function paint() {
    if (nowTimer) { clearInterval(nowTimer); nowTimer = null; }
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    mapRender = null;
    hotLine = '';
    var r;
    if (S.kind === 'train') r = trainView();
    else if (S.kind === 'results') r = resultsView();
    else if (S.kind === 'station') r = stationView();
    else if (S.kind === 'line') r = lineView();
    else if (S.kind === 'bu') r = buView(S.q || S.bu || S.raw);
    else if (S.kind === 'pair') r = pairView();
    else r = empty();
    out.className = 'wrap' + (MAP_OPEN && (S.kind === 'train' || S.kind === 'line') ? ' wide' : '');
    return r;
  }

  function resTrain(no, attrs) {
    var v = TR[no][0];
    return '<li><a href="#" data-k="' + esc(no) + '"' + (attrs || '') + '><b>' + esc(no) + '</b>' +
      '<span class="rt">' + esc(stName(v[0][0])) + ' → ' + esc(stName(v[v.length - 1][0])) + '</span>' +
      '<span class="rm">' + num(v[v.length - 1][2]) + ' km · ' + v.length + ' 站</span></a></li>';
  }

  /* 当前时刻所在区间：返回上一站/下一站的站序（0 起） */
  function liveSegment(no, tab) {
    var st = TR[no] && TR[no][tab];
    var tm = TM[no] && TM[no][tab] || [];
    if (!st || tm.length < 2) return null;
    var d = new Date(), now = d.getHours() * 60 + d.getMinutes();
    var first = null, last = null, i;
    for (i = 0; i < tm.length; i++) {
      if (tm[i][2] != null && (first == null || tm[i][2] < first)) first = tm[i][2];
      if (tm[i][1] != null && (last == null || tm[i][1] > last)) last = tm[i][1];
    }
    if (first == null || last == null) return null;
    if (now < first && last > 1440 && now + 1440 <= last) now += 1440;
    if (now < first || now > last) return null;
    for (i = 0; i < tm.length - 1; i++) {
      var a = tm[i], b = tm[i + 1];
      if (a[2] == null || b[1] == null) continue;
      if (now >= a[2] && now <= b[1]) {
        var f = b[1] > a[2] ? (now - a[2]) / (b[1] - a[2]) : 0;
        var km = st[a[0]][2] + f * (st[b[0]][2] - st[a[0]][2]);
        return kmSegment(st, km) || { from: a[0], to: b[0] };
      }
      if (now > b[1] && i + 2 < tm.length && tm[i + 2][2] != null && now < tm[i + 2][2]) {
        return { from: b[0], to: b[0] };
      }
    }
    return null;
  }

  function paintLiveRows(no, tab) {
    var rows = out.querySelectorAll('tbody tr');
    if (!rows || !rows.length) return;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].classList) rows[i].classList.remove('live', 'live-a', 'live-b');
    }
    var live = liveSegment(no, tab);
    if (!live) return;
    if (live.from === live.to) {
      if (rows[live.from] && rows[live.from].classList) rows[live.from].classList.add('live');
    } else {
      if (rows[live.from] && rows[live.from].classList) rows[live.from].classList.add('live-a');
      if (rows[live.to] && rows[live.to].classList) rows[live.to].classList.add('live-b');
    }
  }

  function trainView() {
    var no = S.no, vs = TR[no];
    if (!vs) return empty();

    var tab = S.tab || 0;
    if (tab >= vs.length) tab = 0;
    var st = vs[tab];
    var first = st[0], last = st[st.length - 1];

    /* 高亮：区段查询传 from+to，车站查询只传 from */
    var hl = S.hl, aIdx = -1, bIdx = -1, k;
    if (hl && hl.from != null) {
      for (k = 0; k < st.length; k++) if (st[k][0] === hl.from) { aIdx = k; break; }
    }
    if (hl && hl.to != null && aIdx >= 0) {
      for (k = aIdx + 1; k < st.length; k++) if (st[k][0] === hl.to) { bIdx = k; break; }
    }

    var head = '<div class="head">' +
      '<span class="no">' + esc(no) + '</span>' +
      '<span class="route">' + stLink(first[0]) +
      '<i>→</i>' + stLink(last[0]) + '</span>' +
      mapBtn() +
      '<span class="meta">' + num(last[2]) + ' km · ' + st.length + ' 站</span>' +
      '</div>';

    var strip = '';
    if (bIdx >= 0) {
      strip = '<div class="hl">查询区间：<b>' + esc(stName(st[aIdx][0])) + '</b>（第 ' + (aIdx + 1) + ' 站）' +
        ' → <b>' + esc(stName(st[bIdx][0])) + '</b>（第 ' + (bIdx + 1) + ' 站）· ' +
        num(st[bIdx][2] - st[aIdx][2]) + ' km · ' + (bIdx - aIdx + 1) + ' 站</div>';
    } else if (aIdx >= 0) {
      strip = '<div class="hl">本站：<b>' + esc(stName(st[aIdx][0])) + '</b> · 第 ' + (aIdx + 1) +
        ' 站 · ' + num(st[aIdx][2]) + ' km</div>';
    }

    var tabs = '';
    if (vs.length > 1) {
      tabs = '<div class="tabs">' + vs.map(function (x, j) {
        var a = stName(x[0][0]), b = stName(x[x.length - 1][0]);
        return '<button type="button" data-i="' + j + '"' +
          (j === tab ? ' class="on"' : '') + '>' + esc(a) + '→' + esc(b) + '</button>';
      }).join('') + '</div>';
    }

    /* 本段均速：相邻两个办客站之间的 km/h，单元格纵向合并覆盖这两站之间的行 */
    var timedIdx = [];
    st.forEach(function (s, idx) { if (timeAt(no, tab, idx)) timedIdx.push(idx); });
    var spdCell = {};
    var dash0 = '<span class="dash">—</span>';
    if (timedIdx.length) {
      var t0 = timedIdx[0], tN = timedIdx[timedIdx.length - 1];
      // 首个办客站之前（含该站）没有上一站，整段留空
      spdCell[0] = '<td class="r sp"' +
        (t0 ? ' rowspan="' + (t0 + 1) + '"' : '') + '>' + dash0 + '</td>';
      for (var si = 1; si < timedIdx.length; si++) {
        var a0 = timedIdx[si - 1], b0 = timedIdx[si];
        var e0 = timeAt(no, tab, a0), e1 = timeAt(no, tab, b0);
        var dkm = st[b0][2] - st[a0][2], dt = e1[1] - e0[2];
        var v = (dkm > 0 && dt > 0) ? num(Math.round(dkm * 60 / dt)) : dash0;
        spdCell[a0 + 1] = '<td class="r sp" rowspan="' + (b0 - a0) + '">' + v + '</td>';
      }
      // 末个办客站之后的行（理论上只剩不办客站）
      if (tN < st.length - 1) {
        spdCell[tN + 1] = '<td class="r sp" rowspan="' + (st.length - 1 - tN) + '">' + dash0 + '</td>';
      }
    }

    var rows = st.map(function (s, idx) {
      var line = lnName(s[1]);
      var parts = line.split('/');
      var prevParts = idx ? lnName(st[idx - 1][1]).split('/') : [];
      // 换线站：本站挂多条线（枢纽），或与上一站完全没有共同线路
      var chg = idx > 0 && (parts.length > 1 ||
        !parts.some(function (p) { return prevParts.indexOf(p) >= 0; }));
      var cls = 'ln' + (parts.length > 1 ? ' split' : '');
      var trCls = [];
      if (chg) trCls.push('chg');
      if (idx === st.length - 1) trCls.push('term');
      if (idx === aIdx || idx === bIdx) trCls.push('pick');
      else if (bIdx > aIdx && idx > aIdx && idx < bIdx) trCls.push('seg');

      var pick = '';
      if (idx === aIdx) pick = bIdx >= 0 ? '<span class="tag ok">上车</span>' : '<span class="tag ok">本站</span>';
      else if (idx === bIdx) pick = '<span class="tag ok">下车</span>';

      var e = timeAt(no, tab, idx);
      var dash = '<span class="dash">—</span>';

      return '<tr' + (trCls.length ? ' class="' + trCls.join(' ') + '"' : '') + '>' +
        '<td class="n">' + (idx + 1) + '</td>' +
        '<td><div class="st"><span class="dot"></span>' + stLink(s[0]) +
        (chg ? '<span class="tag">换线</span>' : '') + pick + '</div></td>' +
        '<td class="tm">' + (e ? fmtT(e[1]) : dash) + '</td>' +
        '<td class="tm">' + (e ? fmtT(e[2]) : dash) + '</td>' +
        '<td class="' + cls + '">' + lnLink(line) + '</td>' +
        '<td class="r">' + num(s[2]) + '</td>' +
        (spdCell[idx] || '') + '</tr>';
    }).join('');

    var hasT = !!(TM[no] && TM[no][tab] && TM[no][tab].length);
    var note = hasT ? '<div class="note">到点 / 发点为办客站时刻，<b>+1</b> 表示次日；' +
      '「—」为途经不办客站（无到发时刻）。均速列为相邻两个办客站之间的平均时速，停站时间不计。</div>' : '';

    out.innerHTML = '<section class="card' + (MAP_OPEN ? '' : ' mapoff') + '">' + head +
      '<div class="chips" id="chips"></div>' +
      strip + tabs + note +
      '<div class="cols"><div class="colmain"><div class="tw"><table><thead><tr><th class="n">#</th><th>车站</th>' +
      '<th class="tm">到点</th><th class="tm">发点</th><th>线路</th>' +
      '<th class="r">里程 km</th>' + (timedIdx.length ? '<th class="r sp">均速 km/h</th>' : '') +
      '</tr></thead><tbody>' + rows + '</tbody></table></div></div>' +
      '<aside class="mapcol" id="mapcol"></aside></div></section>';

    fillChips(no);
    fillTrainMap(no, tab);
    paintLiveRows(no, tab);
    if (typeof setInterval === 'function') {
      if (liveTimer) clearInterval(liveTimer);
      liveTimer = setInterval(function () { paintLiveRows(no, tab); }, 1000);
    }

    var tb = out.querySelector('.tabs');
    if (tb) {
      tb.addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (!b) return;
        S.tab = +b.getAttribute('data-i');
        paint();
      });
    }
    document.title = no + ' ' + stName(first[0]) + '→' + stName(last[0]) + ' · 列车经由查询';
  }

  function resultsView() {
    var raw = S.raw || S.q || '';
    if (META && /[局段司]/.test(raw)) {
      var bm = matchBu(raw);
      if (bm.total) {
        S = { kind: 'bu', q: raw, bu: raw, raw: raw };
        setHash('#?q=' + encodeURIComponent(raw));
        return buView(raw);
      }
    }
    var t = matchTrains(norm(raw));
    var st = matchStations(raw);
    var ln = matchLines(raw);
    var bu = META ? matchBu(raw) : { list: [], total: 0 };
    var total = t.total + st.total + ln.total + bu.total;

    if (!total) {
      if (!META) {
        out.innerHTML = '<section class="card"><div class="err">正在加载担当数据…</div></section>';
        loadMeta(function () { if (S.kind === 'results') paint(); });
        return;
      }
      return notFound(raw);
    }

    /* 只有一个车次命中时直接展开，省一次点击 */
    if (t.total === 1 && !st.total && !ln.total && !bu.total) {
      var only = t.list[0];
      S = { kind: 'train', no: only, tab: 0, hl: null, raw: raw };
      setHash('#' + encodeURIComponent(only));
      return trainView();
    }

    /* 只命中一个担当时直接展开担当页 */
    if (bu.total === 1 && !t.total && !st.total && !ln.total) {
      var onlyBu = bu.list[0];
      S = { kind: 'bu', bu: onlyBu, q: onlyBu, raw: raw };
      setHash('#?q=' + encodeURIComponent(onlyBu), true);
      return buView(onlyBu);
    }

    var html = '<section class="card"><div class="head">' +
      '<span class="no sm">搜索</span><span class="route">' + esc(raw) + '</span>' +
      '<span class="meta">' + num(total) + ' 条结果</span></div>';

    if (t.total) {
      html += '<div class="grp">车次<span class="cnt">' + num(t.total) + '</span></div><ul class="res">' +
        t.list.slice(0, MAX).map(function (no) { return resTrain(no); }).join('') + '</ul>';
      if (t.total > MAX) html += '<div class="more">仅显示前 ' + MAX + ' 条车次</div>';
    }

    if (st.total) {
      var idx = ensureIndex();
      html += '<div class="grp">车站<span class="cnt">' + num(st.total) + '</span></div><ul class="res">' +
        st.list.slice(0, MAX).map(function (id) {
          return '<li><a href="#" data-go="' + esc(ST[id]) + '"><b>' + esc(ST[id]) + '</b>' +
            '<span class="rt">查看途经车次</span>' +
            '<span class="rm">' + num((idx[id] || []).length) + ' 个车次</span></a></li>';
        }).join('') + '</ul>';
      if (st.total > MAX) html += '<div class="more">仅显示前 ' + MAX + ' 个车站</div>';
    }

    if (ln.total) {
      html += '<div class="grp">线路<span class="cnt">' + num(ln.total) + '</span></div><ul class="res">' +
        ln.list.slice(0, MAX).map(function (id) {
          return '<li><a href="#" data-go="' + esc(LN[id]) + '"><b>' + esc(LN[id]) + '</b>' +
            '<span class="rt">查看该线路车次</span></a></li>';
        }).join('') + '</ul>';
      if (ln.total > MAX) html += '<div class="more">仅显示前 ' + MAX + ' 条线路</div>';
    }

    if (bu.total) {
      html += '<div class="grp">担当<span class="cnt">' + num(bu.total) + '</span></div><ul class="res">' +
        bu.list.slice(0, MAX).map(function (n) {
          return '<li><a href="#" data-go="' + esc(n) + '"><b>' + esc(n) + '</b>' +
            '<span class="rt">查看担当车次</span>' +
            '<span class="rm">' + num((BU_SET[n] || []).length) + ' 个车次</span></a></li>';
        }).join('') + '</ul>';
      if (bu.total > MAX) html += '<div class="more">仅显示前 ' + MAX + ' 个担当</div>';
    }

    out.innerHTML = html + '</section>';
    document.title = raw + ' · 列车经由查询';
  }

  function stationView() {
    var sid = S.st, name = ST[sid];
    var idx = ensureIndex();
    var list = (idx[sid] || []).slice().sort(cmp);
    var m = META && META.stations && META.stations[name];

    var html = '<section class="card"><div class="head">' +
      '<span class="no sm">车站</span><span class="route">' + stLink(sid) + '</span>' +
      '<span class="meta" id="smeta">' + (m ? esc(m[0]) + ' · ' + esc(m[1]) + ' · ' + esc(m[4]) + ' · ' : '') +
      '途经 ' + num(list.length) + ' 个车次</span></div>' +
      '<div class="chips" id="schips"></div>';

    if (!list.length) {
      html += '<div class="err">没有车次途经该站。</div>';
    } else {
      html += '<ul class="res">' + list.slice(0, MAX_LIST).map(function (no) {
        var info = atStation(no, sid);
        var e = timeAt(no, info.vi, info.k);
        return '<li><a href="#" data-k="' + esc(no) + '" data-hl="' + sid + '"><b>' + esc(no) + '</b>' +
          '<span class="rt">' + esc(stName(info.from)) + ' → ' + esc(stName(info.to)) + '</span>' +
          (e ? '<span class="tm">' + fmtT(e[1]) + ' / ' + fmtT(e[2]) + '</span>' : '') +
          '<span class="rm">第 ' + (info.k + 1) + ' 站 · ' + num(info.km) + ' km</span></a></li>';
      }).join('') + '</ul>';
      if (list.length > MAX_LIST) {
        html += '<div class="more">仅显示前 ' + MAX_LIST + ' 条，共 ' + num(list.length) + ' 条</div>';
      }
    }

    out.innerHTML = html + '</section>';
    fillStationChips(sid);
    document.title = name + ' 途经车次 · 列车经由查询';
  }

  function buView(q) {
    var raw = String(q || '').trim();
    if (!META) {
      out.innerHTML = '<section class="card"><div class="head"><span class="no sm">担当</span>' +
        '<span class="route">' + esc(raw) + '</span></div>' +
        '<div class="err">正在加载担当数据…</div></section>';
      loadMeta(function () { if (S.kind === 'bu') paint(); });
      document.title = raw + ' 担当 · 列车经由查询';
      return;
    }
    ensureBu();
    var exact = BU_SET[raw] ? raw : null;
    var names = exact ? [raw] : matchBu(raw).list;
    var set = {};
    names.forEach(function (n) {
      (BU_SET[n] || []).forEach(function (no) { set[no] = 1; });
    });
    var list = Object.keys(set).sort(cmp);
    var head = '<div class="head"><span class="no sm">担当</span>' +
      '<span class="route">' + esc(raw) + '</span>' +
      '<span class="meta">' +
      (exact ? '' : names.length + ' 个担当 · ') +
      num(list.length) + ' 个车次</span></div>';
    var chips = '';
    if (!exact && names.length) {
      chips = '<div class="chips">' + names.slice(0, 30).map(function (n) {
        return '<a class="chip" href="#" data-go="' + esc(n) + '">' + esc(n) +
          ' ' + num((BU_SET[n] || []).length) + '</a>';
      }).join('') + '</div>';
    }
    var html = '<section class="card">' + head + chips;
    if (!list.length) {
      html += '<div class="err">没有找到担当「' + esc(raw) + '」的车次。</div>';
    } else {
      html += '<ul class="res">' + list.slice(0, MAX_LIST).map(function (no) {
        var v = TR[no][0];
        return '<li><a href="#" data-k="' + esc(no) + '"><b>' + esc(no) + '</b>' +
          '<span class="rt">' + esc(stName(v[0][0])) + ' → ' + esc(stName(v[v.length - 1][0])) + '</span>' +
          '<span class="rm">' + v.length + ' 站 · ' + num(v[v.length - 1][2]) + ' km</span></a></li>';
      }).join('') + '</ul>';
      if (list.length > MAX_LIST) {
        html += '<div class="more">仅显示前 ' + MAX_LIST + ' 条，共 ' + num(list.length) + ' 条</div>';
      }
    }
    out.innerHTML = html + '</section>';
    document.title = raw + ' 担当 · 列车经由查询';
  }

  function lineView() {
    var name = S.ln;
    var list = trainsOnLine(name);
    var via = LST[name] || null;
    var parts = name.split('/');
    var km = via && via.length ? via[via.length - 1][1] - via[0][1] : 0;

    var html = '<section class="card' + (MAP_OPEN ? '' : ' mapoff') + '"><div class="head">' +
      '<span class="no sm">线路</span><span class="route">' + esc(name) + '</span>' +
      mapBtn() +
      '<span class="meta">' + (via ? num(via.length) + ' 站 · ' + num(km) + ' km · ' : '') +
      num(list.length) + ' 个车次</span></div>' +
      '<div class="chips" id="lchips"></div>' +
      '<div class="facts" id="lfacts"></div>';

    var body = '';

    /* 站点线路名里的 "A/B"：先说明它只是换线标记，再给出两条真实线路的入口 */
    if (parts.length > 1) {
      body += '<div class="note">「' + esc(name) + '」是换线站上的线路标记（两条线拼在一起），' +
        '不是独立线路。可分别查看：' + parts.map(function (p) {
          return '<a href="#" data-go="' + esc(p) + '">' + esc(p) + '</a>';
        }).join(' / ') + '</div>';
    }

    if (via && via.length) {
      body += '<div class="grp">线路经由<span class="cnt">' + num(via.length) + ' 站</span></div>' +
        '<div class="tw"><table class="via"><thead><tr><th class="n">#</th><th>车站</th>' +
        '<th class="r">里程 km</th></tr></thead><tbody>' +
        via.map(function (s, idx) {
          return '<tr><td class="n">' + (idx + 1) + '</td><td>' + stLinkName(s[0]) + '</td>' +
            '<td class="r">' + num(s[1]) + '</td></tr>';
        }).join('') +
        '</tbody></table></div>';
    }

    if (!list.length) {
      body += '<div class="err">没有车次经由此线路。</div>';
    } else {
      body += '<div class="grp">经停车次<span class="cnt">' + num(list.length) + '</span></div>' +
        '<ul class="res">' + list.slice(0, MAX_LIST).map(function (x) {
          var v = TR[x.no][0];
          return '<li><a href="#" data-k="' + esc(x.no) + '"><b>' + esc(x.no) + '</b>' +
            '<span class="rt">' + esc(stName(v[0][0])) + ' → ' + esc(stName(v[v.length - 1][0])) + '</span>' +
            '<span class="rm">经 ' + x.n + ' 站</span></a></li>';
        }).join('') + '</ul>';
      if (list.length > MAX_LIST) {
        body += '<div class="more">仅显示前 ' + MAX_LIST + ' 条，共 ' + num(list.length) + ' 条</div>';
      }
    }

    out.innerHTML = html + '<div class="cols"><div class="colmain">' + body + '</div>' +
      '<aside class="mapcol" id="mapcol"></aside></div></section>';
    fillLineChips(name);
    fillLineFacts(name);
    fillLineMap(name);
    loadRail(function () { fillLineFacts(name); });
    document.title = name + ' 线路 · 列车经由查询';
  }

  function pairView() {
    var aId = S.a, bId = S.b;
    var an = ST[aId], bn = ST[bId];
    var list = pairSearch(aId, bId);

    var html = '<section class="card"><div class="head">' +
      '<span class="no sm">区段</span>' +
      '<span class="route">' + stLink(aId) + '<i>→</i>' + stLink(bId) + '</span>' +
      '<span class="meta">' + num(list.length) + ' 个车次</span></div>';

    if (!list.length) {
      html += '<div class="err">没有车次同时途经 <b>' + esc(an) + '</b> 和 <b>' + esc(bn) +
        '</b>（且顺序为先 ' + esc(an) + ' 后 ' + esc(bn) + '）。</div>';
    } else {
      html += '<ul class="res">' + list.slice(0, MAX_LIST).map(function (x) {
        var ea = timeAt(x.no, x.vi, x.from), eb = timeAt(x.no, x.vi, x.to);
        var tt = '';
        if (ea || eb) {
          tt = (ea ? fmtT(ea[2]) : '—') + ' → ' + (eb ? fmtT(eb[1]) : '—');
          if (ea && eb && eb[1] >= ea[2]) tt += ' · ' + durTxt(eb[1] - ea[2]);
        }
        return '<li><a href="#" data-k="' + esc(x.no) + '" data-pf="' + aId + '" data-pt="' + bId + '">' +
          '<b>' + esc(x.no) + '</b>' +
          '<span class="rt">' + esc(an) + ' → ' + esc(bn) + '</span>' +
          (tt ? '<span class="tm">' + tt + '</span>' : '') +
          '<span class="rm">区间 ' + num(x.km) + ' km · ' + x.n + ' 站</span></a></li>';
      }).join('') + '</ul>';
      if (list.length > MAX_LIST) {
        html += '<div class="more">仅显示前 ' + MAX_LIST + ' 条，共 ' + num(list.length) + ' 条</div>';
      }
    }

    out.innerHTML = html + '</section>';
    document.title = an + '→' + bn + ' · 列车经由查询';
  }

  function notFound(raw) {
    var sug = suggest(raw).slice(0, 12);
    var html = '<section class="card"><div class="err">没找到与 <b>' + esc(raw) +
      '</b> 相关的车次、车站或线路';
    if (sug.length) {
      html += '<div style="margin-top:10px">你是不是想查：' + sug.map(function (it) {
        return '<a href="#" data-go="' + esc(it.v) + '">' + esc(it.v) + '</a>';
      }).join(' · ') + '</div>';
    }
    out.innerHTML = html + '</div></section>';
    document.title = '未找到 · 列车经由查询';
  }

  function empty() {
    out.innerHTML = '<section class="card"><div class="empty">' +
      '<div class="big">🚄</div>' +
      '<div>输入车次、车站或线路后按回车，例如 ' +
      ['D366', 'G1', '武汉', '京广线'].map(function (k) {
        return '<a href="#" data-go="' + k + '">' + k + '</a>';
      }).join('、') +
      '</div><div class="more2">也可以查区间：' +
      ['武汉 自贡', '北京南 上海虹桥'].map(function (k) {
        return '<a href="#" data-go="' + k + '">' + k + '</a>';
      }).join(' · ') + '</div></div></section>';
    document.title = '列车经由查询';
  }

  /* ---------------- 导航 ---------------- */
  function openTrain(no, hl) {
    if (!TR[no]) {
      S = { kind: 'results', q: norm(no), raw: no };
      paint();
      setHash('#?q=' + encodeURIComponent(no), true);
      return;
    }
    S = { kind: 'train', no: no, tab: 0, hl: hl || null, raw: no };
    q.value = no;
    hideAc();
    paint();
    setHash('#' + encodeURIComponent(no), true);
  }

  function go(raw) {
    var p = parse(raw);
    hideAc();
    S = p;
    if (p.kind === 'empty') {
      paint();
      setHash(location.pathname + location.search);
      return;
    }
    q.value = p.kind === 'train' ? p.no : p.raw;
    paint();
    setHash(p.kind === 'train' ? '#' + encodeURIComponent(p.no)
      : '#?q=' + encodeURIComponent(p.raw), true);
  }

  function syncFromHash() {
    var p = fromHash();
    S = p;
    paint();
    q.value = p.kind === 'train' ? p.no : (p.raw || '');
  }

  /* ---------------- 事件 ---------------- */
  q.addEventListener('input', function () {
    var v = q.value.trim();
    showAc(suggest(v));
    if (!v) {
      S = { kind: 'empty', raw: '' };
      paint();
      setHash(location.pathname + location.search);
    }
  });

  q.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveAc(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveAc(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0 && items[active]) go(items[active].v);
      else go(q.value);
    } else if (e.key === 'Escape') { hideAc(); }
  });

  goBtn.addEventListener('click', function () { go(q.value); });

  clr.addEventListener('click', function () {
    q.value = '';
    hideAc();
    S = { kind: 'empty', raw: '' };
    paint();
    setHash(location.pathname + location.search);
    q.focus();
  });

  ac.addEventListener('mousedown', function (e) {
    var li = e.target.closest('li');
    if (li) { e.preventDefault(); go(li.getAttribute('data-i')); }
  });

  out.addEventListener('mouseover', function (e) {
    var t = e.target.closest('[data-hl]');
    if (t) hlLine(t.getAttribute('data-hl'));
  });

  out.addEventListener('mouseout', function (e) {
    var t = e.target.closest('[data-hl]');
    if (t && !(e.relatedTarget && t.contains(e.relatedTarget))) clearHl();
  });

  out.addEventListener('click', function (e) {
    var mb = e.target.closest('[data-map]');
    if (mb) { e.preventDefault(); toggleMap(); return; }
    var pe = e.target.closest('[data-pop]');
    if (pe) { e.preventDefault(); openPop(pe.getAttribute('data-pop'), pe); return; }
    var a = e.target.closest('a');
    if (!a) return;
    var k = a.getAttribute('data-k');
    if (k) {
      e.preventDefault();
      var pf = a.getAttribute('data-pf'), pt = a.getAttribute('data-pt'), hs = a.getAttribute('data-hl');
      var hl = null;
      if (pf != null && pt != null) hl = { from: +pf, to: +pt };
      else if (hs != null) hl = { from: +hs };
      openTrain(k, hl);
      return;
    }
    var g = a.getAttribute('data-go');
    if (g != null) { e.preventDefault(); go(g); }
  });

  document.addEventListener('click', function (e) {
    if (!ac.contains(e.target) && e.target !== q) hideAc();
    /* 浮窗：点外面关掉（触发浮窗的元素自己会重新打开，交给 out 的处理器） */
    if (pop && !pop.hidden && !pop.contains(e.target) &&
        !(e.target.closest && e.target.closest('[data-pop]'))) closePop();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && pop && !pop.hidden) closePop();
  });

  window.addEventListener('scroll', function (e) {
    if (pop && !pop.hidden && !(e.target && e.target.closest && e.target.closest('.pop'))) closePop();
  }, true);

  window.addEventListener('resize', closePop);
  window.addEventListener('resize', function () {
    clearTimeout(mapTimer);
    mapTimer = setTimeout(function () {
      if (mapRender && MAP_OPEN) mapRender();
    }, 160);
  });

  window.addEventListener('hashchange', syncFromHash);
  window.addEventListener('popstate', syncFromHash);

  /* ---------------- 初始化 ---------------- */
  hint.innerHTML = '共 <b>' + num(KEYS.length) + '</b> 个车次 · ' + num(ST.length) +
    ' 个车站 · ' + num(N_LN) + ' 条线路，支持车次、站名、拼音、线路与「A 到 B」区间查询';
  hint.querySelector('b').addEventListener('click', function () { q.focus(); });

  ft.innerHTML = '构建于 ' + esc(D.built);

  syncFromHash();

  /* 附加信息（车站档案 / 车底）后台加载：不挡首屏，浮窗和拼音搜索都靠它 */
  loadMeta(function () {
    ensurePy();
    /* 直接打开 #?q=bj 这类拼音链接时，首屏还没有 meta，到位后补一次 */
    if (S.kind === 'results') paint();
    if (!ac.hidden && q.value.trim()) showAc(suggest(q.value));
  });

  /* 首屏已经渲染完，收起加载遮罩（见 index.html 里的 #loading） */
  var ld = document.getElementById('loading');
  if (ld && ld.parentNode) {
    var close = function () {
      ld.className = 'loading off';
      setTimeout(function () { if (ld.parentNode) ld.parentNode.removeChild(ld); }, 400);
    };
    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(function () { window.requestAnimationFrame(close); });
    } else {
      close();
    }
  }
})();
