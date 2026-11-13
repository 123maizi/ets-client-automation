/* ============================================================
 *  ETS 一键完成 / 全满分 (autocomp)  v2
 *  注入点: http://localhost:8080/static/index.js 追加 loader
 *  依赖: window.EtsHelper (原生签名) + 页面 fetch
 *  快捷键: F2 = 一键完成   F3 = 状态/自检   F4 = 停止
 * ============================================================ */
(function () {
  'use strict';
  if (window.__ETSX && window.__ETSX.v === 2) return;
  var TAG = 'ETSX';
  var DEF = {
    AUTO_MAXOUT: true,      // 拦截页面自身请求时把分数改成满分
    AUTO_RUN: false,        // false=只靠按钮触发；true=页面加载后自动执行
    USE_TIME: 1,            // 上报用时(秒)
    CONCURRENCY: 2,         // 同时处理几份作业
    PER_REQUEST_DELAY: 300, // 单次请求间隔(ms)
    MIN_DELAY: 120,         // 自适应加速下限(ms)
    FULL_SCORE: 5           // 单题满分(服务端按 real = total/5 归一化)
  };
  var _usr = window.ETSX_CONF || {};
  var CONF = {};
  (function () {
    for (var k in DEF) CONF[k] = (k in _usr) ? _usr[k] : DEF[k];
  })();
  window.ETSX_CONF = CONF;

  function log() {
    try {
      var a = Array.prototype.slice.call(arguments).map(function (x) {
        if (typeof x === 'string') return x;
        try { return JSON.stringify(x); } catch (e) { return String(x); }
      });
      console.log(TAG + '|' + a.join('|'));
    } catch (e) {}
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function md5hex16() {
    var s = ''; for (var i = 0; i < 16; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)];
    return s;
  }
  function nowStr() {
    var d = new Date(), p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function b64utf8(str) {
    var bytes = new Uint8Array(new TextEncoder().encode(str)), s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function b64decodeUtf8(b) { try { return decodeURIComponent(escape(atob(b))); } catch (e) { return null; } }

  /* ---------- token / base ---------- */
  var state = { token: null, base: 'https://api.ets100.com', ver: '5.7.9', v: 2, busy: false, stop: false, unsupported: 0, failStreak: 0, stats: { req: 0, ok: 0, fail: 0 } };
  function parseJwt(t) { try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { return null; } }
  function scan(store) {
    var out = [];
    try {
      for (var i = 0; i < store.length; i++) {
        var k = store.key(i), v = store.getItem(k);
        if (!v) continue;
        var m = v.match(/eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/);
        if (m) out.push({ key: k, token: m[0], jwt: parseJwt(m[0]) });
      }
    } catch (e) {}
    return out;
  }
  function pickToken() {
    var c = scan(localStorage).concat(scan(sessionStorage));
    if (!c.length) return null;
    c.sort(function (a, b) { return ((b.jwt && b.jwt.create) || 0) - ((a.jwt && a.jwt.create) || 0); });
    return c[0].token;
  }
  function initEnv() {
    try {
      var cfg = JSON.parse(localStorage.getItem('clientConfig') || '{}');
      if (cfg.VITE_BASE_URL) state.base = cfg.VITE_BASE_URL;
      state.ver = cfg.C_Version || localStorage.getItem('C_Version') || state.ver;
    } catch (e) {}
    state.token = pickToken();
  }

  /* ---------- 原生签名 ---------- */
  function signBody(body, time) {
    return new Promise(function (resolve) {
      try {
        var h = new window.EtsHelper({});
        var done = false, timer = null;
        function finish(v) { if (done) return; done = true; if (timer) clearTimeout(timer); resolve(v); }
        timer = setTimeout(function () { finish(null); }, 4000);
        function tryV1() {
          if (typeof h.encode_api_body !== 'function') return finish(null);
          h.encode_api_body({ body: body, time: time }, function (sg) {
            finish(sg ? { sign: sg, pid: 'pcWin', protocol: 'v1' } : null);
          });
        }
        if (typeof h.encode_api_body_v2 === 'function') {
          h.encode_api_body_v2({ body: body, time: time }, function (raw) {
            try {
              var o = JSON.parse(raw);
              if (o && o.sign) return finish({ sign: o.sign, pid: o.pid || 'pcWin', key_id: o.key_id, sign_version: o.sign_version, protocol: 'v2' });
            } catch (e) {}
            tryV1();
          });
        } else tryV1();
      } catch (e) { log('sign-error', String(e)); resolve(null); }
    });
  }

  /* ---------- 通用请求 ---------- */
  async function etsPost(r, params, _retry) {
    initEnv();
    var a = { sign_response: 1, sn: 'test', system: 4, global_client_version: state.ver };
    if (state.token) a.token = state.token;
    var arr = [{ r: r, params: Object.assign({}, a, params || {}) }];
    var body = b64utf8(JSON.stringify(arr));
    var time = String(Date.now());
    var sign = await signBody(body, time);
    if (!sign || !sign.sign) { var out0 = { code: -999, msg: 'sign fail' }; state.stats.fail++; return out0; }
    state.stats.req++;
    var url = state.base + (r.charAt(0) === '/' ? r : '/' + r);
    var payload = JSON.stringify({ body: body, head: { version: '1.0', sign: sign.sign, pid: sign.pid || 'pcWin', time: time, time_second: Number(time) } });
    var txt = await new Promise(function (resolve, reject) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', url, true);
        x.setRequestHeader('Accept', 'application/json, text/plain, */*');
        x.setRequestHeader('Content-Type', 'application/json');
        x.onload = function () { resolve(x.responseText || ''); };
        x.onerror = function () { reject(new Error('xhr error status=' + x.status)); };
        x.ontimeout = function () { reject(new Error('timeout')); };
        x.timeout = 20000;
        x.send(payload);
      } catch (e) { reject(e); }
    }).catch(function (e) {
      if (!_retry) { return null; }
      throw e;
    });
    if (txt === null) { await sleep(400); return etsPost(r, params, true); }
    var json;
    try { json = JSON.parse(txt); } catch (e) { throw new Error('bad json status/len: ' + txt.length + ' ' + txt.slice(0, 120)); }
    var out = json[0] || json;
    if (out && out.code === 0) state.stats.ok++; else state.stats.fail++;
    return out;
  }

  /* ---------- 满分改写 ---------- */
  var FULL = CONF.FULL_SCORE;
  function detailFull(extra) {
    var d = {
      accuracy_score: '100.000000', fluency_score: '100.000000',
      integrity_score: '100.000000', standard_score: '100.000000',
      total_score: FULL, real_score: FULL, category: 'read_word', rate_scale: 0
    };
    if (extra && extra.category) d.category = extra.category;
    return JSON.stringify(d);
  }
  function maxOutParams(p) {
    if (!p || typeof p !== 'object') return;
    var q = parseFloat(p.question_type_score);
    var full = isFinite(q) && q > 0 ? q : FULL;
    if ('real_score' in p || p.score_detail) { p.real_score = full; }
    if ('score' in p) p.score = full;
    if ('correct' in p) p.correct = 1;
    if ('score_rate' in p) p.score_rate = 1;
    if (typeof p.score_detail === 'string') {
      try {
        var d = JSON.parse(p.score_detail);
        d.accuracy_score = '100.000000'; d.fluency_score = '100.000000';
        d.integrity_score = '100.000000'; d.standard_score = '100.000000';
        d.total_score = full; d.real_score = full; d.rate_scale = d.rate_scale || 0;
        delete d.except_info; delete d.is_rejected;
        p.score_detail = JSON.stringify(d);
      } catch (e) {}
    }
    if (Array.isArray(p.detail)) {
      p.detail.forEach(function (it) {
        if (!it) return;
        if ('point' in it) it.point = it.point > 0 ? it.point : 1;
        if ('score_rate' in it) it.score_rate = 1;
        if ('answer' in it && !it.answer) it.answer = '';
        if (typeof it.score_detail === 'string') {
          try {
            var x = JSON.parse(it.score_detail);
            x.score = 100;
            if (x.choose === undefined) x.choose = it.answer || '';
            it.score_detail = JSON.stringify(x);
          } catch (e) {}
        }
      });
    }
    if (Array.isArray(p.info)) p.info.forEach(function (it) { if (it) { it.real_score = full; it.score = full; if (typeof it.score_detail === 'string') { try { var y = JSON.parse(it.score_detail); y.total_score = full; y.real_score = full; it.score_detail = JSON.stringify(y); } catch (e) {} } } });
    if (Array.isArray(p.list)) p.list.forEach(function (it) { if (it) { if ('score' in it) it.score = full; if ('real_score' in it) it.real_score = full; } });
  }

  /* ---------- hook 原生签名：改 body 再签名 ---------- */
  function hookSign() {
    if (!window.EtsHelper || window.EtsHelper.prototype.__etsx) return;
    var proto = window.EtsHelper.prototype;
    ['encode_api_body', 'encode_api_body_v2'].forEach(function (m) {
      if (typeof proto[m] !== 'function') return;
      var orig = proto[m];
      proto[m] = new Proxy(orig, {
        apply: function (target, thisArg, args) {
          try {
            var obj = args[0];
            if (CONF.AUTO_MAXOUT && obj && obj.body) {
              var txt = b64decodeUtf8(obj.body);
              if (txt) {
                var arr = JSON.parse(txt);
                if (Array.isArray(arr)) {
                  var changed = false;
                  arr.forEach(function (item) {
                    if (!item || !item.r) return;
                    var r = String(item.r);
                    if (/sync|submit|score|commit|report|mark/i.test(r)) {
                      maxOutParams(item.params); changed = true;
                    }
                  });
                  if (changed) obj.body = b64utf8(JSON.stringify(arr));
                }
              }
            }
          } catch (e) {}
          return Reflect.apply(target, thisArg, args);
        }
      });
      proto.__etsx = true;
    });
    log('hook', 'encode_api_body hooked');
  }

  /* ---------- hook XHR：拿响应明文 ---------- */
  function hookXHR() {
    if (window.__etsx_xhr) return;
    window.__etsx_xhr = true;
    var XO = window.XMLHttpRequest, op = XO.prototype.open, se = XO.prototype.send;
    XO.prototype.open = function (m, u) { this.__u = u; return op.apply(this, arguments); };
    XO.prototype.send = function () {
      var self = this;
      try {
        if (self.__u && /api\.ets100\.com/.test(self.__u)) {
          self.addEventListener('load', function () {
            try {
              var t = self.responseText || '';
              var j = JSON.parse(t); var o = j[0] || j;
              var r = (window.__ETSX_LASTREQ || {}).r || self.__u;
              if (window.__etsx_lastResp) window.__etsx_lastResp[r] = o;
              log('app-resp', { r: r, code: o && o.code, keys: o && o.body && Object.keys(o.body).slice(0, 12) });
            } catch (e) {}
          });
        }
      } catch (e) {}
      return se.apply(this, arguments);
    };
  }
  function hookReqLog() {
    // 记录页面自己发出的请求明文体（用于学习字段）
    var XO = window.XMLHttpRequest, se = XO.prototype.send;
    if (window.__etsx_reqlog) return;
    window.__etsx_reqlog = true;
    XO.prototype.send = function (data) {
      try {
        if (typeof data === 'string' && data.indexOf('"body"') >= 0) {
          var o = JSON.parse(data);
          var txt = b64decodeUtf8(o.body);
          if (txt) {
            var arr = JSON.parse(txt);
            window.__ETSX_LASTREQ = arr[0];
          }
        }
      } catch (e) {}
      return se.apply(this, arguments);
    };
  }

  /* ---------- 一键完成 ---------- */
  function parentId() {
    try {
      var st = JSON.parse(localStorage.getItem('userInfo') || '{}');
      var u = st.userInfo || st.user_info || st;
      var ec = st.ecardInfo || st.ecard_info || {};
      var v = (u && (u.parent_id || u.parentId)) || ec.parent_id || ec.parent_account_id;
      return v === undefined || v === null || v === '' ? undefined : String(v);
    } catch (e) { return undefined; }
  }
  function hwListParams(extra) {
    return Object.assign({
      version: 11, parent_account_id: parentId(), status: 1, offset: 0, limit: 20,
      get_all_count: 1, get_to_do_count: 1, get_to_overtime_count: 1,
      check_pass: 1, show_old_homework: 1, get_audio_task: 1,
      use_https: 1, use_homework_privilege: 1
    }, extra || {});
  }
  function buildSyncParams(hw, c, order, tplAudio) {
    var full = FULL;
    var cat = c.first_type_name === '单词' || String(c.group_name || '').indexOf('单词') >= 0 ? 'read_word' : 'read_sentence';
    return {
      resource_id: String(hw.resource_id),
      real_score: full, score: full,
      set_id: String(hw.set_id),
      entity_id: String(c.real_id || c.id),
      order: String(order),
      serial_id: '', mistake_id: '',
      upload_file_id: '', upload_file_url: (tplAudio && tplAudio.audio) || '',
      spx_file_url: '', mark_trace_id: '',
      detail_file_id: '', detail_file_url: (tplAudio && tplAudio.detail_file) || '',
      score_detail: detailFull({ category: cat }),
      mark_service: 1,
      seq_id: md5hex16(),
      version: '2',
      homework_id: String(hw.id),
      auto_submit: 1, correct: 1, exam_id: null,
      client_time: nowStr()
    };
  }
  async function finishOne(hw, ti) {
    log('hw-start', { idx: ti, id: hw.id, name: hw.name, fc: hw.first_column_id, complete: hw.complete });
    tip('正在完成：' + hw.name);
    try { await etsPost('g/homework/checkstart', { homework_id: String(hw.id) }); } catch (e) { log('checkstart-err', String(e)); }
    var info = null;
    try { info = await etsPost('/m/homework/info', { resource_id: String(hw.resource_id), homework_id: Number(hw.id), first_column_id: String(hw.first_column_id), version: 2, pk: 0 }); } catch (e) { log('info-err', String(e)); }
    var tplAudio = (info && info.body && info.body.score && info.body.score[0]) || null;
    var last = (info && info.body && info.body.complete) || 0;
    var st = hw.struct || (hw.structs && hw.structs[0]) || {};
    var contents = st.contents || [];
    log('hw-contents', { id: hw.id, n: contents.length, done: last });
    if (!contents.length) return;
    var sent = 0;

    for (var round = 0; round < 4 && last < 100 && !state.stop; round++) {
      var roundStart = last;
      for (var i = 0; i < contents.length; i++) {
        if (state.stop || last >= 100) break;
        var c = contents[i];
        var single = c.read_type === 1 || /单词/.test(String(c.first_type_name || '')) || /单词/.test(String(c.group_name || ''));
        var maxOrd = round === 0 ? (single ? 1 : 40) : 2;   // 首轮单词类 1 次；补漏轮最多试到 order=2
        var grew = false;

        for (var ord = 1; ord <= maxOrd; ord++) {
          if (state.stop) return;
          var params = buildSyncParams(hw, c, ord, tplAudio);
          params.seq_id = md5hex16();
          var r = null, attempt = 0, errCode = 0;
          while (attempt < 3 && !r) {
            try {
              r = await etsPost('/m/audio/sync-v2', params);
              if (r && r.code !== 0) { errCode = r.code; r = null; attempt++; await sleep(350); }
            } catch (e) { attempt++; await sleep(350); }
          }
          if (!r) {
            log('sync-fail', { ent: params.entity_id, ord: ord, code: errCode, attempt: attempt });
            state.failStreak = (state.failStreak || 0) + 1;
            if (errCode === 400 || errCode === 401) {
              state.unsupported = (state.unsupported || 0) + 1;
              tip('该作业被服务端拒绝(' + errCode + ')，已跳过：' + hw.name);
              return;
            }
            break;
          }
          state.failStreak = 0;
          sent++;
          var complete = (r.body && r.body.complete) || 0;
          if (complete > last) { last = complete; grew = true; }
          if (complete >= 100) break;
          if (!grew && round === 0) break;
          await sleep(CONF.PER_REQUEST_DELAY);
        }
        if (i % 5 === 0) tip('正在完成：' + hw.name + '\n进度 ' + last + '% (' + (i + 1) + '/' + contents.length + ')' + (round ? ' · 补漏第' + round + '轮' : ''));
        await sleep(CONF.PER_REQUEST_DELAY);
      }
      log('round-done', { id: hw.id, round: round, from: roundStart, to: last, sent: sent });
      if (last >= 100) break;
      if (last === roundStart) { log('no-progress', { id: hw.id, round: round, at: last }); break; }
    }

    try { await etsPost('m/homework/submit', { id: Number(hw.id), homework_id: Number(hw.id), resource_id: String(hw.resource_id), first_column_id: String(hw.first_column_id), version: 2, use_time: CONF.USE_TIME }); } catch (e) {}
    try {
      var after = await etsPost('/m/homework/info', { resource_id: String(hw.resource_id), homework_id: Number(hw.id), first_column_id: String(hw.first_column_id), version: 2, pk: 0 });
      var ab = (after && after.body) || {};
      log('hw-done', { id: hw.id, point: ab.point, avg: ab.avg_point, complete: ab.complete, pass: ab.pass, sent: sent });
      tip(hw.name + ' → ' + (ab.complete || 0) + '% / ' + (ab.point || 0) + '分');
    } catch (e) {}
  }

  async function oneClick() {
    if (state.busy) { log('busy'); return; }
    state.busy = true; state.stop = false; state.unsupported = 0; state.failStreak = 0; state.okStreak = 0; state.stats = { req: 0, ok: 0, fail: 0 };
    CONF.PER_REQUEST_DELAY = 300;
    try {
      initEnv();
      log('oneclick-start', { token: state.token ? 'yes' : 'NO', base: state.base });
      if (!state.token) { log('no-token'); tip('未获取到登录 token，请重新登录'); return; }
      var r = await etsPost('g/homework/list', hwListParams());
      if (!r || r.code !== 0) { log('list-fail', { code: r && r.code, msg: r && r.msg, pid: parentId() }); tip('作业列表获取失败：' + (r && r.msg || '')); return; }
      var all = (r.body && r.body.data) || [];
      var todo = all.filter(function (x) {
        if (!x || (x.complete || 0) >= 100 || x.mock) return false;
        if (x.expire && x.end && Number(x.end) * 1000 < Date.now()) return false;
        var ents = (x.struct && x.struct.contents) || (x.structs && x.structs[0] && x.structs[0].contents) || [];
        return ents.length > 0;   // 选择题/词汇类（无 entity）不碰，避免占用限一次机会
      });
      var skippedNoEntity = all.filter(function (x) {
        if (!x || (x.complete || 0) >= 100) return false;
        var ents = (x.struct && x.struct.contents) || (x.structs && x.structs[0] && x.structs[0].contents) || [];
        return ents.length === 0;
      }).length;
      if (skippedNoEntity) log('skip-no-entity', { n: skippedNoEntity });
      log('list', { all: all.length, todo: todo.length });
      tip('待完成 ' + todo.length + ' 份，开始执行…');
      var idx = 0;
      var queue = todo.slice();
      var conc = Math.max(1, Math.min(CONF.CONCURRENCY || 2, todo.length || 1));
      var workers = [];
      for (var w = 0; w < conc; w++) {
        workers.push((async function () {
          while (queue.length && !state.stop) {
            var hw = queue.shift();
            try { await finishOne(hw, idx++); } catch (e) { log('hw-throw', { id: hw && hw.id, err: String(e) }); }
          }
        })());
      }
      await Promise.all(workers);
      log('oneclick-done', state.stats);
      tip('执行结束：请求 ' + state.stats.req + '，成功 ' + state.stats.ok + (state.unsupported ? ('\n跳过 ' + state.unsupported + ' 份（服务端拒绝，可能是班级考试模式或账号受限）') : ''));
    } catch (e) { log('oneclick-throw', String(e)); }
    finally { state.busy = false; }
  }

  /* ---------- 页面内自动答题（选择题/词汇题） ---------- */
  function hwId() {
    try {
      var st = JSON.parse(localStorage.getItem('homeworkStore') || '{}');
      return st.homework_id || null;
    } catch (e) { return null; }
  }
  function findHw(list, id) {
    var d = (list && list.body && list.body.data) || [];
    for (var i = 0; i < d.length; i++) if (String(d[i].id) === String(id)) return d[i];
    return null;
  }
  function optText(q, an) {
    try {
      var arr = JSON.parse(q.option);
      for (var i = 0; i < arr.length; i++) if (arr[i].option_name === an) return arr[i].option_value;
    } catch (e) {}
    return null;
  }
  async function autoAnswer() {
    try {
      var id = hwId();
      if (!id) { log('no-homework-id'); tip('没有取到当前作业 ID'); return; }
      var list = await etsPost('g/homework/list', hwListParams());
      var hw = findHw(list, id);
      if (!hw) { log('hw-not-in-list', id); tip('作业不在列表中：' + id); return; }
      var st = await etsPost('g/homework/struct', { id: Number(id), resource_id: String(hw.resource_id), first_column_id: String(hw.first_column_id) });
      var qs = (st.body && (st.body.word_question || st.body.question)) || [];
      if (!qs.length) { log('no-questions'); tip('该作业没有可自动作答的题目'); return; }
      log('auto-answer-start', { id: id, n: qs.length, fc: hw.first_column_id });
      tip('自动答题：' + qs.length + ' 题');
      var idx = function (a) { return ({ A: 0, B: 1, C: 2, D: 3, E: 4 }[a] || 0); };
      var last = -1, same = 0, done = 0;
      for (var guard = 0; guard < 300; guard++) {
        if (state.stop) { log('auto-answer-stopped'); break; }
        var txt = document.body.innerText || '';
        var m = txt.match(/(\d+)\/(\d+)/);
        if (!m) { log('no-progress'); break; }
        var cur = parseInt(m[1]) - 1;
        if (cur >= qs.length) { log('all-answered'); break; }
        if (cur === last) { same++; if (same > 10) { log('stuck', cur); break; } } else { same = 0; last = cur; }
        var q = qs[cur];
        var val = optText(q, q.answer);
        var items = Array.prototype.slice.call(document.querySelectorAll('.container-items-item'));
        var el = null;
        if (items.length && items[idx(q.answer)]) el = items[idx(q.answer)];
        if (!el && val) {
          var cand = Array.prototype.filter.call(document.querySelectorAll('div,span,p,li,button'), function (e) {
            return e.children.length === 0 && (e.textContent || '').trim() === val;
          });
          if (cand.length) { el = cand[0]; for (var u = 0; u < 2; u++) if (el.parentElement) el = el.parentElement; }
        }
        if (!el) { await sleep(700); continue; }
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        done++;
        if (done % 5 === 0) tip('自动答题 ' + cur + '/' + qs.length);
        await sleep(1100);
      }
      log('auto-answer-done', { answered: done });
      tip('自动答题结束：已点 ' + done + ' 题');
    } catch (e) { log('auto-answer-err', String(e)); }
  }

  /* ---------- 悬浮按钮 ---------- */
  function tip(msg) {
    try {
      var t = document.getElementById('etsx-tip');
      if (!t) return;
      t.style.display = 'block';
      t.textContent = String(msg).slice(0, 300);
    } catch (e) {}
  }
  function buildUI() {
    try {
      if (document.getElementById('etsx-btn')) return;
      var box = document.createElement('div');
      box.id = 'etsx-box';
      box.style.cssText = 'position:fixed;right:16px;bottom:120px;z-index:2147483647;display:flex;flex-direction:column;gap:8px;align-items:flex-end;user-select:none';

      var row = document.createElement('div');
      row.id = 'etsx-row';
      row.style.cssText = 'display:flex;gap:8px;align-items:center;cursor:move';

      var btn = document.createElement('button');
      btn.id = 'etsx-btn';
      btn.textContent = '⚡ 一键完成';
      btn.style.cssText = 'padding:11px 20px;border-radius:24px;border:none;background:linear-gradient(135deg,#22c55e,#15803d);color:#fff;font-size:15px;font-weight:700;cursor:pointer;box-shadow:0 8px 22px rgba(34,197,94,.45);letter-spacing:1px';

      var stopBtn = document.createElement('button');
      stopBtn.id = 'etsx-stop';
      stopBtn.textContent = '■';
      stopBtn.title = '停止';
      stopBtn.style.cssText = 'display:none;width:36px;height:36px;border-radius:50%;border:none;background:#ef4444;color:#fff;font-size:15px;cursor:pointer;box-shadow:0 6px 16px rgba(239,68,68,.4)';

      var tipEl = document.createElement('div');
      tipEl.id = 'etsx-tip';
      tipEl.style.cssText = 'max-width:320px;padding:7px 11px;border-radius:10px;background:rgba(0,0,0,.78);color:#fff;font-size:12px;line-height:1.55;display:none;white-space:pre-wrap;word-break:break-all';

      btn.onclick = function () {
        if (state.busy) { tip('正在执行中…'); return; }
        state.stop = false;
        tip('开始一键完成…');
        stopBtn.style.display = 'inline-block';
        oneClick().then(function () {
          stopBtn.style.display = 'none';
          tip('执行结束：请求 ' + state.stats.req + ' / 成功 ' + state.stats.ok +
              (state.unsupported ? ('\n跳过 ' + state.unsupported + ' 份（服务端拒绝）') : ''));
        }, function (e) {
          stopBtn.style.display = 'none';
          tip('出错了：' + e);
        });
      };
      stopBtn.onclick = function () { state.stop = true; tip('已请求停止…'); };

      // 拖动
      (function () {
        var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
        row.addEventListener('mousedown', function (e) {
          if (e.target === btn) { /* 允许点击 */ }
          dragging = true;
          sx = e.clientX; sy = e.clientY;
          var r = box.getBoundingClientRect();
          ox = r.left; oy = r.top;
          box.style.right = 'auto'; box.style.bottom = 'auto';
          box.style.left = ox + 'px'; box.style.top = oy + 'px';
          e.preventDefault();
        });
        window.addEventListener('mousemove', function (e) {
          if (!dragging) return;
          box.style.left = (ox + e.clientX - sx) + 'px';
          box.style.top = (oy + e.clientY - sy) + 'px';
        });
        window.addEventListener('mouseup', function () { dragging = false; });
      })();

      row.appendChild(btn);
      row.appendChild(stopBtn);
      box.appendChild(row);
      box.appendChild(tipEl);
      (document.body || document.documentElement).appendChild(box);
      log('ui-ready');
    } catch (e) { log('ui-err', String(e)); }
  }

  /* ---------- 快捷键 ---------- */
  function bindKeys() {
    document.addEventListener('keydown', function (e) {
      try {
        if (e.key === 'F2') { e.preventDefault(); log('key-F2'); oneClick(); }
        if (e.key === 'F3') { e.preventDefault(); initEnv(); log('status', { token: state.token ? parseJwt(state.token) : null, base: state.base, ver: state.ver, stats: state.stats, href: location.href, cfg: CONF }); }
        if (e.key === 'F4') { state.stop = true; log('key-F4-stop'); }
        if (e.key === 'F5') { e.preventDefault(); log('key-F5-autoanswer'); autoAnswer(); }
        if (e.ctrlKey && e.shiftKey && (e.key === 'E' || e.key === 'e')) { e.preventDefault(); log('key-ctrl-shift-e'); autoRun(true); }
      } catch (err) {}
    }, true);
    log('keys', 'F2=一键完成(听说类) F5=自动答题(词汇/选择) F3=状态 F4=停止');
  }

  /* ---------- 自动执行 ---------- */
  var autoRan = false;
  function autoRun(force) {
    if (autoRan && !force) return;
    autoRan = true;
    var h = location.hash || '';
    log('auto-run', { hash: h });
    try {
      if (/homeworkWordQuestion|WordQuestion|\/pk\?|examQuestion|question\?/i.test(h)) { autoAnswer(); return; }
    } catch (e) {}
    oneClick();
  }

  /* ---------- 启动 ---------- */
  function boot() {
    hookXHR(); hookReqLog(); hookSign(); bindKeys(); initEnv();
    window.ETSX = { v: 2, state: state, conf: CONF, etsPost: etsPost, oneClick: oneClick, autoAnswer: autoAnswer, maxOutParams: maxOutParams, log: log, pickToken: pickToken };
    log('boot', { href: location.href, token: state.token ? 'yes' : 'no', base: state.base, ver: state.ver });
    buildUI();
    if (CONF.AUTO_RUN !== false) setTimeout(function () { autoRun(false); }, 2500);
  }
  if (window.EtsHelper) boot();
  else {
    var n = 0, iv = setInterval(function () {
      if (window.EtsHelper) { clearInterval(iv); boot(); }
      else if (++n > 900) clearInterval(iv);
    }, 100);
  }
})();
