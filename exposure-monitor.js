/*
 * ExposureMonitor — 本地持仓 CSV 轮询与状态层
 *
 * 独立于 index.html 的分片还原链路：不读取、不修改任何 template 分片，
 * 只负责按固定间隔轮询一份持仓 CSV，解析校验后在页面顶部渲染
 * 状态栏（颜色 + 文案）与净敞口区。
 *
 * CSV 格式（含表头，逗号分隔）：
 *   品种,方向,手数,合约规模,保证金
 *   EURUSD,多,1,100000,500
 *
 * 品种为 6 位字母：前 3 位基准币，后 3 位计价币。
 * 多头：基准币记正、计价币记负；空头相反。手数 × 合约规模后按币种求和即净敞口。
 *
 * 对外 API（window.ExposureMonitor）：
 *   start({url, interval, loader})  开始轮询（loader 可自定义，返回 Promise<string>）
 *   stop()                          停止自动轮询
 *   poll()                          立即触发一次轮询，返回 Promise
 *   setSource(string|function)      切换被轮询的文件路径或自定义 loader
 *   getState()                      当前状态码，如 'OK' / 'MISSING' / ...
 *
 * 默认自动启动：读取 URL 查询参数 ?csv=<路径>&interval=<毫秒>，
 * 默认 positions.csv、3000ms。在加载本脚本前设置
 * window.EXPOSURE_MONITOR_MANUAL = true 可关闭自动启动（测试页使用）。
 */
(function () {
  'use strict';

  var EXPECTED_HEADER = ['品种', '方向', '手数', '合约规模', '保证金'];

  var DIRECTIONS = {
    '多': 1, '买入': 1, 'long': 1, 'buy': 1,
    '空': -1, '卖出': -1, 'short': -1, 'sell': -1
  };

  /* 五种异常/特殊状态 + 正常态，各自独立的颜色与文案 */
  var STATES = {
    INIT:         { text: '正在初始化…',                  color: '#8b949e' },
    OK:           { text: '数据正常',                     color: '#3fb950' },
    MISSING:      { text: '持仓文件缺失或不可读取',       color: '#f85149' },
    EMPTY:        { text: '持仓文件内容为空',             color: '#d29922' },
    BAD_HEADER:   { text: 'CSV 表头不符',                 color: '#bc8cff' },
    BAD_ROW:      { text: '持仓行数据非法',               color: '#ff7b45' },
    NO_POSITIONS: { text: '无持仓（表头合法，无持仓行）', color: '#58a6ff' }
  };

  var BAR_HEIGHT = 76;

  function trim(s) { return String(s).trim(); }

  function el(id) { return document.getElementById(id); }

  /* ---------------- CSV 解析与校验 ---------------- */

  function parseCsv(text) {
    text = String(text == null ? '' : text).replace(/^﻿/, '');

    var lines = text.split(/\r\n|\r|\n/);
    var nonEmpty = [];
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim() !== '') nonEmpty.push({ no: i + 1, raw: lines[i] });
    }

    if (nonEmpty.length === 0) {
      return { code: 'EMPTY', detail: '文件没有任何内容' };
    }

    var headerFields = nonEmpty[0].raw.split(',').map(trim);
    var headerOk = headerFields.length === EXPECTED_HEADER.length;
    if (headerOk) {
      for (var h = 0; h < EXPECTED_HEADER.length; h++) {
        if (headerFields[h] !== EXPECTED_HEADER[h]) { headerOk = false; break; }
      }
    }
    if (!headerOk) {
      return {
        code: 'BAD_HEADER',
        detail: '期望表头「' + EXPECTED_HEADER.join(',') + '」，实际为「' + headerFields.join(',') + '」'
      };
    }

    if (nonEmpty.length === 1) {
      return { code: 'NO_POSITIONS', detail: '表头合法，但文件中没有任何持仓行' };
    }

    var rows = [];
    for (var r = 1; r < nonEmpty.length; r++) {
      var line = nonEmpty[r];
      var f = line.raw.split(',').map(trim);

      if (f.length !== EXPECTED_HEADER.length) {
        return { code: 'BAD_ROW', detail: '第 ' + line.no + ' 行：应有 ' + EXPECTED_HEADER.length + ' 个字段，实际 ' + f.length + ' 个' };
      }
      for (var k = 0; k < EXPECTED_HEADER.length; k++) {
        if (f[k] === '') {
          return { code: 'BAD_ROW', detail: '第 ' + line.no + ' 行：字段「' + EXPECTED_HEADER[k] + '」缺失' };
        }
      }
      if (!/^[A-Za-z]{6}$/.test(f[0])) {
        return { code: 'BAD_ROW', detail: '第 ' + line.no + ' 行：品种「' + f[0] + '」不是 6 位字母' };
      }
      var dirKey = f[1].toLowerCase();
      var dir = DIRECTIONS[f[1]] !== undefined ? DIRECTIONS[f[1]] : DIRECTIONS[dirKey];
      if (dir === undefined) {
        return { code: 'BAD_ROW', detail: '第 ' + line.no + ' 行：方向「' + f[1] + '」无法识别（应为 多/空）' };
      }
      var lots = Number(f[2]);
      var contractSize = Number(f[3]);
      var margin = Number(f[4]);
      if (!isFinite(lots) || lots <= 0) {
        return { code: 'BAD_ROW', detail: '第 ' + line.no + ' 行：手数「' + f[2] + '」不是正数' };
      }
      if (!isFinite(contractSize) || contractSize <= 0) {
        return { code: 'BAD_ROW', detail: '第 ' + line.no + ' 行：合约规模「' + f[3] + '」不是正数' };
      }
      if (!isFinite(margin) || margin < 0) {
        return { code: 'BAD_ROW', detail: '第 ' + line.no + ' 行：保证金「' + f[4] + '」不是非负数值' };
      }

      rows.push({
        symbol: f[0].toUpperCase(),
        dir: dir,
        lots: lots,
        contractSize: contractSize,
        margin: margin
      });
    }

    return { code: 'OK', rows: rows };
  }

  /* 多头：基准币 +、计价币 -；空头相反。手数 × 合约规模后按币种求和。 */
  function computeExposure(rows) {
    var net = {};
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var base = row.symbol.slice(0, 3);
      var quote = row.symbol.slice(3, 6);
      var amount = row.lots * row.contractSize;
      net[base] = (net[base] || 0) + row.dir * amount;
      net[quote] = (net[quote] || 0) - row.dir * amount;
    }
    return net;
  }

  /* ---------------- UI ---------------- */

  var uiBuilt = false;

  function buildUI() {
    if (uiBuilt || !document.body) return;
    uiBuilt = true;

    var spacer = document.createElement('div');
    spacer.id = 'exposure-monitor-spacer';
    spacer.style.height = BAR_HEIGHT + 'px';

    var bar = document.createElement('div');
    bar.id = 'exposure-monitor-bar';
    bar.setAttribute('style',
      'position:fixed;top:0;left:0;right:0;z-index:2147483000;' +
      'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.35);');
    bar.innerHTML =
      '<div id="em-status" style="display:flex;align-items:center;gap:10px;padding:8px 16px;' +
        'color:#0d1117;font-weight:600;background:' + STATES.INIT.color + ';">' +
        '<span id="em-dot" style="width:10px;height:10px;border-radius:50%;background:rgba(0,0,0,.35);flex:none;"></span>' +
        '<span id="em-state">' + STATES.INIT.text + '</span>' +
        '<span id="em-detail" style="font-weight:400;opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>' +
        '<span style="flex:1"></span>' +
        '<span id="em-updated" style="font-weight:400;white-space:nowrap;">最后更新：—</span>' +
      '</div>' +
      '<div id="em-panel" style="background:#161b22;color:#c9d1d9;border-bottom:1px solid #30363d;' +
        'padding:8px 16px;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;">' +
        '<span style="color:#8b949e;flex:none;">净敞口</span>' +
        '<span id="em-exposure" style="color:#8b949e;">— 无可用敞口数据 —</span>' +
      '</div>';

    document.body.insertBefore(spacer, document.body.firstChild);
    document.body.appendChild(bar);
  }

  function fmt(v) {
    var r = Math.round(v * 100) / 100;
    if (Object.is(r, -0)) r = 0;
    var s = Math.abs(r).toLocaleString('en-US', { maximumFractionDigits: 2 });
    return (r > 0 ? '+' : (r < 0 ? '−' : '')) + s;
  }

  var currentState = 'INIT';

  function render(code, detail, exposure) {
    buildUI();
    if (!uiBuilt) return;
    currentState = code;

    var st = STATES[code] || STATES.INIT;
    el('em-status').style.background = st.color;
    el('em-state').textContent = st.text;
    el('em-detail').textContent = detail || '';

    var exp = el('em-exposure');
    if (code === 'OK' && exposure) {
      el('em-updated').textContent = '最后更新：' + new Date().toLocaleTimeString();
      exp.innerHTML = '';
      exp.style.color = '';
      var keys = Object.keys(exposure).sort();
      for (var i = 0; i < keys.length; i++) {
        var ccy = keys[i];
        var v = exposure[ccy];
        var chip = document.createElement('span');
        chip.setAttribute('style',
          'display:inline-block;margin:2px 6px 2px 0;padding:2px 10px;border-radius:6px;' +
          'background:#0d1117;border:1px solid #30363d;font-family:ui-monospace,monospace;');
        chip.textContent = ccy + ' ' + fmt(v);
        chip.style.color = v > 0 ? '#3fb950' : (v < 0 ? '#f85149' : '#8b949e');
        exp.appendChild(chip);
      }
    } else {
      /* 异常态一律清空敞口区，不得沿用上一次的敞口 */
      exp.innerHTML = '';
      exp.textContent = '— 无可用敞口数据 —';
      exp.style.color = '#8b949e';
    }
  }

  /* ---------------- 轮询 ---------------- */

  var current = { url: 'positions.csv', interval: 3000, loader: null };
  var timer = null;
  var polling = false;

  function defaultLoader(url) {
    return fetch(url, { cache: 'no-store' }).then(function (resp) {
      if (!resp.ok) {
        var e = new Error('HTTP ' + resp.status + '（' + url + '）');
        e.code = 'MISSING';
        throw e;
      }
      return resp.text();
    }, function (netErr) {
      var e = new Error('无法读取 ' + url + '：' + netErr);
      e.code = 'MISSING';
      throw e;
    });
  }

  function poll() {
    if (polling) return Promise.resolve(currentState);
    polling = true;

    var load = current.loader
      ? current.loader
      : function () { return defaultLoader(current.url); };

    return Promise.resolve()
      .then(load)
      .then(function (text) {
        var result = parseCsv(text);
        if (result.code === 'OK') {
          render('OK', '已加载 ' + result.rows.length + ' 条持仓', computeExposure(result.rows));
        } else {
          render(result.code, result.detail, null);
        }
      }, function (err) {
        render('MISSING', (err && err.message) ? err.message : String(err), null);
      })
      .then(function () {
        polling = false;
        return currentState;
      }, function () {
        polling = false;
        return currentState;
      });
  }

  function start(options) {
    options = options || {};
    if (options.url) { current.url = options.url; current.loader = null; }
    if (options.loader) { current.loader = options.loader; }
    if (options.interval > 0) current.interval = options.interval;

    stop();
    buildUI();
    if (currentState === 'INIT') render('INIT', '轮询目标：' + (current.loader ? '自定义数据源' : current.url), null);
    poll();
    timer = setInterval(poll, current.interval);
  }

  function stop() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function setSource(src) {
    if (typeof src === 'function') {
      current.loader = src;
    } else {
      current.url = String(src);
      current.loader = null;
    }
  }

  window.ExposureMonitor = {
    start: start,
    stop: stop,
    poll: poll,
    setSource: setSource,
    getState: function () { return currentState; },
    /* 导出纯函数，便于测试页或控制台直接验证解析逻辑 */
    _parseCsv: parseCsv,
    _computeExposure: computeExposure
  };

  /* 默认自动启动（可用 window.EXPOSURE_MONITOR_MANUAL = true 关闭） */
  function autoStart() {
    if (window.EXPOSURE_MONITOR_MANUAL) return;
    var url = 'positions.csv';
    var interval = 3000;
    try {
      var q = new URLSearchParams(window.location.search);
      if (q.get('csv')) url = q.get('csv');
      var iv = parseInt(q.get('interval'), 10);
      if (iv > 0) interval = iv;
    } catch (e) { /* 忽略查询参数解析失败，使用默认值 */ }
    start({ url: url, interval: interval });
  }

  /*
   * 注意：index.html 的还原脚本在 DOMContentLoaded 上注册（head 解析期），
   * 本脚本以 defer 方式加载、在解析完成后执行，注册顺序在其后，
   * 因此本监听器保证在还原逻辑（可能替换 document.body）之后运行。
   */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoStart);
  } else {
    autoStart();
  }
})();
