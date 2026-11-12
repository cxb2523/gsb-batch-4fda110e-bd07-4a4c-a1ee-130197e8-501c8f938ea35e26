/* 0xStudy Agentic 钱包简易 — production UI.
   Only talks to the same-origin agentic-wallet API behind Caddy auth. */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const BASE = "api/";
  const BOOK_KEY = "agentic-address-book-v2";
  const THEME_KEY = "agentic-theme";
  const OKX_ADDRESS = "";
  const WBNB_ADDRESS = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
  const COLORS = ["#d4654a", "#4f6f9f", "#7c6a9f", "#2f8f7a", "#b07a12", "#a35476", "#3f6294"];

  const state = {
    portfolio: null,
    wallet: "all",
    view: "assets",
    historyWallet: "w1",
    historyCache: {},
    historyPending: {},
    historyFilter: "all",
    hideLow: true,
    showAll: false,
    riskFilter: "all",
    search: "",
    countdown: 3,
    historyTick: 0,
    loading: false,
    sell: null,
    send: null,
    walletAdd: null,
    walletLogin: null,
    book: loadBook(),
    quoteSeq: 0
  };

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtUsd = (raw) => {
    let v = Number(raw) || 0;
    const sign = v < 0 ? "-" : "";
    v = Math.abs(v);
    if (v >= 1000) return sign + "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (v >= 1) return sign + "$" + v.toFixed(2);
    if (v >= 0.01) return sign + "$" + v.toFixed(4);
    if (v === 0) return sign + "$0.00";
    return sign + "$" + Number(v.toPrecision(3)).toString();
  };
  const trim = (v, d = 4) => Number(v).toFixed(d).replace(/\.?0+$/, "");
  const fmtQty = (raw) => {
    const v = Number(raw) || 0;
    if (v >= 1e9) return trim(v / 1e9, 2) + "B";
    if (v >= 1e6) return trim(v / 1e6, 2) + "M";
    if (v >= 1e4) return trim(v / 1e3, 1) + "K";
    if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
    if (v >= 1) return trim(v, 4);
    if (v >= 0.001) return trim(v, 4);
    if (v >= 0.000001) return trim(v, 6);
    return trim(v, 8);
  };
  const fmtPrice = (raw) => {
    const p = Number(raw) || 0;
    if (p >= 1000) return "$" + p.toLocaleString("en-US", { maximumFractionDigits: 0 });
    if (p >= 1) return "$" + trim(p, 2);
    if (p >= 0.001) return "$" + trim(p, 6);
    if (p === 0) return "—";
    return "$" + p.toPrecision(4).replace(/0+$/, "").replace(/\.$/, "");
  };
  const fmtPct = (v) => {
    const n = Number(v) || 0;
    if (Math.abs(n) < 0.005) return "0.00%";
    return (n > 0 ? "+" : "") + n.toFixed(2) + "%";
  };
  const fmtLiq = (v) => {
    const n = Number(v) || 0;
    if (n >= 1e9) return "$" + trim(n / 1e9, 2) + "B";
    if (n >= 1e6) return "$" + trim(n / 1e6, 1) + "M";
    if (n >= 1e3) return "$" + trim(n / 1e3, 1) + "K";
    return "$" + n.toFixed(0);
  };
  const shortAddr = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
  const timeAgo = (iso) => {
    if (!iso) return "—";
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "—";
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 10) return "刚刚";
    if (s < 60) return s + " 秒前";
    if (s < 3600) return Math.floor(s / 60) + " 分钟前";
    if (s < 86400) return Math.floor(s / 3600) + " 小时前";
    return Math.floor(s / 86400) + " 天前";
  };
  const localTime = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  };
  const walletById = (id) => (state.portfolio?.wallets || []).find((w) => w.id === id) || { id, label: id, color: "#8a93a5" };
  const walletTag = (w) => `<span class="wallet-tag" style="--wc:${w.color || "#8a93a5"}" title="${esc(w.label || w.id)}">${esc(String(w.id || "").toUpperCase())}</span>`;

  async function api(path, options = {}) {
    const opts = { cache: "no-store", ...options };
    opts.headers = { ...(opts.headers || {}), "X-Requested-With": "agentic" };
    if (opts.body && typeof opts.body !== "string") {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(BASE + path, opts);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 300) }; }
    if (!res.ok) throw new Error(data?.error || "请求失败 (" + res.status + ")");
    return data;
  }

  function toast(title, sub = "", type = "success") {
    const el = document.createElement("div");
    el.className = "toast " + (type === "error" ? "error" : "");
    el.innerHTML = `<span class="t-ico"><svg class="icon"><use href="#${type === "error" ? "i-alert" : "i-check"}"></use></svg></span><div><strong>${esc(title)}</strong>${sub ? `<span>${esc(sub)}</span>` : ""}</div>`;
    $("#toasts").appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; el.style.transition = ".2s"; }, 3600);
    setTimeout(() => el.remove(), 3900);
  }

  /* ---------------- theme / book ---------------- */
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch {}
    $("#themeBtn").innerHTML = `<svg class="icon"><use href="#${theme === "dark" ? "i-sun" : "i-moon"}"></use></svg>`;
  }
  function initTheme() {
    let theme = "light";
    try { theme = localStorage.getItem(THEME_KEY) || "light"; } catch {}
    applyTheme(theme === "dark" ? "dark" : "light");
  }
  function loadBook() {
    try {
      const raw = localStorage.getItem(BOOK_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr.filter((x) => /^0x[a-fA-F0-9]{40}$/.test(x.address || ""));
      }
    } catch {}
    return /^0x[a-fA-F0-9]{40}$/.test(OKX_ADDRESS)
      ? [{ name: "OKX 地址", address: OKX_ADDRESS, color: "#0b7f5b" }]
      : [];
  }
  function saveBook(arr) {
    state.book = arr;
    try { localStorage.setItem(BOOK_KEY, JSON.stringify(arr)); } catch {}
  }

  /* ---------------- scope ---------------- */
  function scopeTokens() {
    const p = state.portfolio;
    if (!p) return [];
    if (state.wallet === "all") return p.tokens || [];
    const out = [];
    for (const t of p.tokens || []) {
      const h = (t.holders || []).find((x) => x.wallet === state.wallet);
      if (!h) continue;
      const value = Number(h.value) || 0;
      out.push({ ...t, qty: h.qty, value, hidden: Boolean(t.risk?.hidden || value < 1), holders: [h] });
    }
    return out;
  }
  function scopeSummary() {
    const tokens = scopeTokens();
    const total = tokens.reduce((s, t) => s + (Number(t.value) || 0), 0);
    const visible = tokens.filter((t) => !t.hidden).reduce((s, t) => s + (Number(t.value) || 0), 0);
    return { tokens, total, visible, hidden: total - visible, hiddenCount: tokens.filter((t) => t.hidden).length };
  }
  function filteredTokens() {
    let list = scopeTokens().slice();
    if (state.hideLow && !state.showAll) list = list.filter((t) => !t.hidden);
    if (state.riskFilter === "safe") list = list.filter((t) => t.risk?.level === "safe");
    if (state.riskFilter === "warn") list = list.filter((t) => t.risk?.level !== "safe");
    const q = state.search.trim().toLowerCase();
    if (q) list = list.filter((t) => String(t.symbol).toLowerCase().includes(q) || String(t.address).toLowerCase().includes(q) || String(t.name || "").toLowerCase().includes(q));
    list.sort((a, b) => Number(b.value) - Number(a.value));
    return list;
  }
  function historyEntry(wallet) {
    return state.historyCache[wallet] || null;
  }
  // Per-wallet cache keys.  The "all" entry is an aggregate response; it is
  // preferred when present, otherwise we merge what per-wallet snapshots hold.
  function historyWalletKeys() {
    return (state.portfolio?.wallets || []).map((w) => w.id).filter((id) => historyEntry(id));
  }
  function historyFor(wallet) {
    if (wallet === "all") {
      const aggregate = historyEntry("all");
      if (aggregate) return aggregate.items || [];
      const seen = new Set();
      const out = [];
      for (const w of historyWalletKeys()) {
        const entry = historyEntry(w);
        for (const item of (entry?.items) || []) {
          const key = (item.wallet || "") + ":" + (item.txHash || "");
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(item);
        }
      }
      out.sort((a, b) => String(b.time || "").localeCompare(String(a.time || "")));
      return out;
    }
    return (historyEntry(wallet)?.items) || [];
  }
  function historyMeta(wallet) {
    const empty = { ok: null, error: null, updatedAt: null, attemptedAt: null, stale: false, errors: [], wallets: {}, refreshing: false };
    if (wallet !== "all") {
      const e = historyEntry(wallet);
      if (!e) return { ...empty, refreshing: Boolean(state.historyPending[wallet]) };
      return {
        ok: e.ok ?? null,
        error: e.error || null,
        updatedAt: e.updatedAt || null,
        attemptedAt: e.attemptedAt || null,
        stale: Boolean(e.stale),
        errors: e.errors || (e.error ? [{ wallet, error: e.error }] : []),
        wallets: e.wallets || {},
        refreshing: Boolean(e.refreshing || state.historyPending[wallet]),
      };
    }
    const aggregate = historyEntry("all");
    if (aggregate) {
      return {
        ok: aggregate.ok ?? null,
        error: aggregate.error || null,
        updatedAt: aggregate.updatedAt || null,
        attemptedAt: aggregate.attemptedAt || null,
        stale: Boolean(aggregate.stale),
        errors: aggregate.errors || [],
        wallets: aggregate.wallets || {},
        refreshing: Boolean(aggregate.refreshing || state.historyPending.all),
      };
    }
    let updatedAt = null;
    let attemptedAt = null;
    let ok = null;
    let stale = false;
    const errors = [];
    const wallets = {};
    let any = false;
    for (const w of historyWalletKeys()) {
      const e = historyEntry(w);
      if (!e) continue;
      any = true;
      Object.assign(wallets, e.wallets || {});
      if (e.updatedAt && (!updatedAt || Date.parse(e.updatedAt) > Date.parse(updatedAt))) updatedAt = e.updatedAt;
      if (e.attemptedAt && (!attemptedAt || Date.parse(e.attemptedAt) > Date.parse(attemptedAt))) attemptedAt = e.attemptedAt;
      stale = stale || Boolean(e.stale);
      if (e.ok === false) {
        ok = false;
        if (e.error) errors.push({ wallet: w, error: e.error });
      } else if (e.ok === true && ok !== false) {
        ok = true;
      }
    }
    return { ok: any ? ok : null, error: errors[0]?.error || null, updatedAt, attemptedAt, stale, errors, wallets, refreshing: false };
  }
  const syncTime = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  /* ---------------- render ---------------- */
  function render() {
    if (!state.portfolio) return;
    renderWalletTabs();
    renderSummary();
    renderWalletManage();
    renderKeepalive();
    renderRiskSummary();
    renderAssets();
    renderHistoryScope();
    renderAgenticAddresses();
  }

  function sessionLabel(w) {
    if (w.sessionBlocked) return "地址不一致";
    if (w.sessionStatus === "online" || w.status === "online") return "在线";
    if (w.sessionStatus === "checking" || w.status === "checking") return "检测中";
    return "已退出";
  }

  function renderWalletTabs() {
    const p = state.portfolio;
    const active = state.view === "history" ? state.historyWallet : state.wallet;
    const wallets = p.wallets || [];
    const all = `<button class="wallet-tab ${active === "all" ? "is-active" : ""}" data-wallet="all" type="button"><span class="dot" style="--wc:#1b2230"></span>全部钱包 <b>${fmtUsd(p.totalUsd)}</b></button>`;
    const rest = wallets.map((w) => `
      <button class="wallet-tab ${active === w.id ? "is-active" : ""}" data-wallet="${w.id}" type="button">
        <span class="dot" style="--wc:${w.color}"></span>${esc(w.label)}
        <b>${fmtUsd(w.balanceUsd)}</b>
        ${w.status === "online" ? "" : `<small class="off">${esc(sessionLabel(w))}</small>`}
      </button>`).join("");
    $("#walletTabs").innerHTML = all + rest;
  }

  function renderSummary() {
    const p = state.portfolio;
    const s = scopeSummary();
    $("#totalUsd").textContent = fmtUsd(p.totalUsd);
    $("#visibleUsd").textContent = fmtUsd(s.visible);
    $("#hiddenUsd").textContent = fmtUsd(s.hidden);
    $("#scopeLine").textContent = `${state.wallet === "all" ? "全部钱包" : walletById(state.wallet).label} · 价格实时校正 · 最优池保护`;
    const balanceAge = Number(p.balanceAge) || 0;
    const marketAge = Number(p.marketAge) || 0;
    const stale = balanceAge > 15 || marketAge > 60;
    $("#dataDot").classList.toggle("stale", stale);
    $("#dataFreshness").textContent = stale
      ? `数据延迟 ${Math.max(Math.round(balanceAge), Math.round(marketAge))}s`
      : "3 秒刷新";
    $("#balanceAge").textContent = p.balanceAge ?? "—";
    $("#lastUpdated").textContent = "缓存 " + timeAgo(p.updatedAt);
  }

  function renderWalletManage() {
    const wallets = state.portfolio?.wallets || [];
    if (!wallets.length) {
      $("#walletManageList").innerHTML = `<div class="manage-empty">还没有钱包。添加后即可查看资产和交易。</div><button class="manage-add" data-add-wallet="1" type="button"><svg class="icon"><use href="#i-plus"></use></svg>添加第一个钱包</button>`;
      return;
    }
    const rows = wallets.map((w) => `
      <div class="manage-row">
        <span class="manage-dot" style="--wc:${w.color}"></span>
        <div class="manage-main">
          <div class="manage-name"><button class="manage-name-btn" data-rename-wallet="${esc(w.id)}" type="button" title="点击修改名称">${esc(w.label)} <svg class="icon"><use href="#i-pen"></use></svg></button><small class="${w.status === "online" ? "" : "off"}">${w.stale ? "缓存 · " : ""}${esc(sessionLabel(w))}${w.status === "offline" || w.sessionBlocked ? " · 需要重新登录或移除" : ""}</small><button class="trade-toggle ${w.trade ? "on" : "off"}" data-trade-wallet="${esc(w.id)}" type="button" title="${w.trade ? "当前可交易，点击设为只读" : "当前只读，点击开启交易"}">${w.trade ? "交易开" : "只读"}</button>${w.status === "offline" || w.sessionBlocked ? `<button class="relogin-btn" data-relogin-wallet="${esc(w.id)}" type="button">重新登录</button>` : ""}</div>
          <div class="manage-sub">${esc(w.id)} · ${esc(shortAddr(w.address))}</div>
        </div>
        <div class="manage-val">${fmtUsd(w.balanceUsd)}</div>
        <button class="manage-copy" data-copy="${esc(w.address)}" type="button" aria-label="复制 ${esc(w.label)} 的完整地址" title="复制完整地址：${esc(w.address)}"><svg class="icon"><use href="#i-copy"></use></svg></button>
        <button class="manage-del" data-del-wallet="${esc(w.id)}" type="button" aria-label="从看板移除 ${esc(w.label)}" title="从看板移除（不登出会话）"><svg class="icon"><use href="#i-trash"></use></svg></button>
      </div>`).join("");
    $("#walletManageList").innerHTML = rows + `<button class="manage-add" data-add-wallet="1" type="button"><svg class="icon"><use href="#i-plus"></use></svg>添加钱包</button>`;
  }

  function renderKeepalive() {
    const ka = state.portfolio.keepalive?.wallets || {};
    const wallets = state.portfolio.wallets || [];
    const checked = wallets.filter((w) => ka[w.id]).length;
    const online = wallets.filter((w) => !w.sessionBlocked && ka[w.id]?.status === "CONNECTED").length;
    const allOk = wallets.length > 0 && online === wallets.length;
    const entry = $("#keepaliveBtn");
    entry.classList.toggle("ok", allOk);
    entry.classList.toggle("bad", checked > 0 && !allOk);
    $("#keepaliveTop").textContent = `${online}/${wallets.length}`;
    entry.title = !checked ? "等待首次保活检查" : allOk ? `全部 ${wallets.length} 个会话正常` : `${wallets.length - online} 个会话异常，点击查看`;
    $("#keepaliveModalList").innerHTML = wallets.length ? wallets.map((w) => {
      const k = ka[w.id];
      const status = k?.status || "UNKNOWN";
      const ok = status === "CONNECTED" && !w.sessionBlocked;
      const label = w.sessionBlocked ? "地址不一致" : ok ? "在线" : status === "UNCONNECTED" ? "已退出" : status === "UNKNOWN" ? "未知" : status;
      return `<div class="ka-row ${ok ? "" : "off"}"><span class="ka-dot ${ok ? "" : "off"}"></span><span class="ka-name">${esc(w.label)}</span><span class="ka-state">${esc(label)}</span><span class="ka-time">${k?.at ? timeAgo(k.at) : "未检查"}</span>${ok ? "" : `<button class="ka-login" data-relogin-wallet="${esc(w.id)}" type="button">重新登录</button>`}</div>`;
    }).join("") : `<div class="manage-empty">暂无会话</div>`;
  }

  function renderRiskSummary() {
    const tokens = scopeTokens();
    const hidden = tokens.filter((t) => t.hidden);
    const count = (label) => hidden.filter((t) => t.risk?.label === label).length;
    const lowValue = hidden.filter((t) => (Number(t.value) || 0) < 1).length;
    const pills = [
      ["小额", lowValue],
      ["低流动性", count("低流动性")],
      ["貔貅/高税", count("貔貅") + count("高税")],
      ["无池子", count("无池子") + count("未审计")]
    ];
    const panel = $("#riskPanel");
    panel.innerHTML = `<div class="risk-panel-grid">${pills.map(([label, n]) => `<div class="risk-pill"><strong>${n}</strong><span>${esc(label)}</span></div>`).join("")}</div><p class="rail-note">貔貅/高税来自 honeypot.is 模拟；低流动性按最深池 < $1,000 判断。点“风险过滤”随时收起。</p>`;
  }

  function renderAssets() {
    const s = scopeSummary();
    const list = filteredTokens();
    const wallets = state.portfolio.wallets || [];
    $("#resultCount").textContent = `${list.length} 个资产`;
    $("#assetEmpty").hidden = list.length > 0;
    $("#assetEmptyTitle").textContent = !wallets.length ? "还没有钱包" : "当前过滤下没有资产";
    if (!wallets.length) {
      $("#assetRows").innerHTML = `<div class="empty" style="border:0"><div class="empty-mark">○</div><strong>还没有钱包</strong><span>点右侧“钱包管理 → 添加钱包”，用币安 App 扫码即可。</span><div style="margin-top:18px"><button class="btn primary" data-add-wallet="1" type="button"><svg class="icon"><use href="#i-plus"></use></svg>添加第一个钱包</button></div></div>`;
      $("#filterNotice").hidden = true;
      $("#riskPanel").hidden = true;
      $("#assetEmpty").hidden = true;
      return;
    }
    $("#filterNotice").hidden = false;
    $("#noticeText").textContent = state.showAll
      ? `已显示全部：${s.tokens.length} 项，风险项已标红；${fmtUsd(s.hidden)} 属于过滤项`
      : `默认隐藏 ${s.hiddenCount} 项 · ${fmtUsd(s.hidden)}（价值 <$1、低流动性、貔貅/高税）`;
    $("#noticeShow").textContent = state.showAll ? "恢复过滤" : "显示全部";
    $("#assetRows").innerHTML = list.map(assetRow).join("");
    $("#assetEmpty").hidden = list.length !== 0;
  }

  function assetRow(t) {
    const holders = t.holders || [];
    const risk = Number(t.value) < 1 && t.hidden ? { level: "warn", label: "小额" } : (t.risk || { level: "safe", label: "正常" });
    const tags = holders.slice(0, 5).map((h) => walletTag(walletById(h.wallet))).join("");
    const more = holders.length > 5 ? `<button class="wallet-more" data-holders="${esc(t.address)}" type="button">+${holders.length - 5}</button>` : "";
    const pool = t.dex ? `${t.dex === "pancakeswap" ? "PancakeSwap" : t.dex}${t.labels?.length ? " " + String(t.labels[0]).toUpperCase() : ""}` : "无池子";
    const tax = t.tax || {};
    const buyTax = tax.buy == null ? "?" : tax.buy;
    const sellTax = tax.sell == null ? "?" : tax.sell;
    return `
      <div class="asset-row" data-address="${esc(t.address)}">
        <div class="cell-asset">
          <div class="asset-title-line"><span class="asset-symbol">${esc(t.symbol)}</span><span class="asset-name">${esc(t.name && t.name !== t.symbol ? t.name : "")}</span><span class="risk-badge ${esc(risk.level)}">${esc(risk.label)}</span></div>
          <div class="asset-meta">
            <span class="ca" title="${esc(t.address)}">${esc(shortAddr(t.address))}</span>
            <button class="copy" data-copy="${esc(t.address)}" type="button" title="复制合约地址"><svg class="icon"><use href="#i-copy"></use></svg></button>
          </div>
          <div class="wallet-tags" data-holders="${esc(t.address)}" role="button" tabindex="0" title="查看持有这个资产的钱包">${tags}${more}</div>
        </div>
        <div class="price">${fmtPrice(t.price)}</div>
        <div class="balance">${fmtQty(t.qty)} ${esc(t.symbol)}</div>
        <div class="value">${fmtUsd(t.value)}</div>
        <div class="liq"><b>${t.liquidity ? fmtLiq(t.liquidity) : "—"}</b><small>${esc(pool)}</small></div>
        <div class="tax-cell ${Number(tax.sell) > 10 ? "high" : ""}">卖 ${sellTax}% / 买 ${buyTax}%</div>
        <div class="actions">
          <div class="sell-group"><button class="sell-main" data-sell="${esc(t.address)}" data-pct="50" type="button">卖出</button><button class="sell-caret" data-menu="${esc(t.address)}" type="button" aria-label="卖出比例"><svg class="icon"><use href="#i-chevron"></use></svg></button></div>
          <div class="mobile-pcts"><button data-sell="${esc(t.address)}" data-pct="20" type="button">20%</button><button data-sell="${esc(t.address)}" data-pct="50" type="button">50%</button><button data-sell="${esc(t.address)}" data-pct="100" type="button">100%</button></div>
          <button class="row-text" data-send="${esc(t.address)}" type="button" title="发送"><svg class="icon"><use href="#i-send"></use></svg>发送</button>
          <button class="kline-btn" data-kline="${esc(t.address)}" data-exchange="okx" type="button"><img src="assets/okx.png" alt="">OKX K线</button>
          <button class="kline-btn" data-kline="${esc(t.address)}" data-exchange="binance" type="button"><img src="assets/binance.png" alt="">币安 K线</button>
        </div>
      </div>`;
  }

  function renderHistoryScope() {
    const w = state.historyWallet === "all" ? "全部钱包" : walletById(state.historyWallet).label;
    $("#historyScope").textContent = `${w} · 默认按钱包查看 · 最近 3 个月`;
    $$("#historyFilter button").forEach((b) => b.classList.toggle("is-active", b.dataset.hfilter === state.historyFilter));
  }

  function renderHistory() {
    const all = historyFor(state.historyWallet);
    const meta = historyMeta(state.historyWallet);
    const items = all.filter((x) => state.historyFilter === "all" || x.kind === state.historyFilter);
    $("#historyCount").textContent = all.length;
    $("#historyOk").textContent = all.filter((x) => x.status === "confirmed").length;
    $("#historyBad").textContent = all.filter((x) => x.status !== "confirmed").length;
    $("#historyUpdatedTop").textContent = meta.updatedAt ? syncTime(meta.updatedAt) : "—";
    renderHistoryBanner(meta);
    $("#historyEmpty").hidden = items.length > 0 || Boolean(meta.error);
    $("#historyRows").innerHTML = items.map((x) => {
      const kindClass = x.kind === "发送" ? "send" : x.kind === "接收" ? "receive" : x.kind === "交易" ? "trade" : "contract";
      const statusClass = x.status === "confirmed" ? "confirmed" : x.status === "failed" ? "failed" : "pending";
      const statusText = x.status === "confirmed" ? "已确认" : x.status === "failed" ? "失败" : "待确认";
      const snapshot = x.fetchedAt ? syncTime(x.fetchedAt) : "—";
      return `<div class="history-row${x.stale ? " is-stale" : ""}">
        <div class="h-time"><strong>${esc(localTime(x.time))}</strong><small>抓取 ${esc(snapshot)}${x.stale ? " · 旧数据" : ""}</small></div>
        <div class="h-wallet">${walletTag(walletById(x.wallet))}${esc(x.walletLabel || x.wallet)}</div>
        <div><span class="kind ${kindClass}">${esc(x.kind)}</span></div>
        <div class="h-asset"><strong>${esc(x.amount || (x.txType === "contract_call" ? "合约调用" : "—"))}</strong><small>${esc(x.counterparty ? "对手方 " + x.counterparty : x.contractAddress ? "合约 " + shortAddr(x.contractAddress) : (x.symbol || ""))}</small></div>
        <div class="h-status"><span class="status ${statusClass}">${statusText}</span>${x.stale ? `<span class="fresh-badge stale">旧数据</span>` : ""}</div>
        <div>${x.txHash ? `<a class="tx-link" href="https://bscscan.com/tx/${esc(x.txHash)}" target="_blank" rel="noopener">${esc(shortAddr(x.txHash))}<svg class="icon"><use href="#i-external"></use></svg></a>` : `<span class="tx-link">—</span>`}</div>
      </div>`;
    }).join("");
    $("#historyUpdated").textContent = meta.updatedAt ? "抓取 " + syncTime(meta.updatedAt) : "—";
  }

  function renderHistoryBanner(meta) {
    const el = $("#historyNotice");
    if (!el) return;
    if (meta.ok !== false) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    const failedAt = meta.attemptedAt ? syncTime(meta.attemptedAt) : "—";
    const lastOk = meta.updatedAt ? syncTime(meta.updatedAt) : null;
    const reason = meta.errors.length > 1
      ? meta.errors.map((e) => `${walletById(e.wallet).label || e.wallet}：${e.error}`).join("；")
      : (meta.error || "原因未知");
    const shown = lastOk
      ? `当前显示的是上次成功抓取的数据（${esc(lastOk)}），不是本次结果。`
      : "当前没有可显示的记录，本次抓取也没有成功。";
    el.hidden = false;
    el.className = "notice error history-notice";
    el.innerHTML = `<svg class="icon"><use href="#i-alert"></use></svg>
      <span><strong>本次抓取失败（${esc(failedAt)}）</strong>${esc(reason)}。${shown}</span>`;
  }

  /* ---------------- load ---------------- */
  async function loadPortfolio() {
    if (state.loading) return;
    state.loading = true;
    try {
      const p = await api("portfolio");
      state.portfolio = p;
      if (state.wallet !== "all" && !p.wallets.some((w) => w.id === state.wallet)) state.wallet = "all";
      if (state.historyWallet !== "all" && !p.wallets.some((w) => w.id === state.historyWallet)) state.historyWallet = p.wallets[0]?.id || "all";
      render();
      if (!state.historyCache[state.historyWallet] && !state.historyPending[state.historyWallet]) prefetchHistories();
    } catch (e) {
      toast("读取资产失败", String(e.message || e), "error");
    } finally {
      state.loading = false;
      state.countdown = 3;
    }
  }

  async function loadHistory(wallet, silent = false, force = false) {
    if (!wallet) return;
    // Never stack a second request for the wallet already being fetched: join
    // the in-flight promise instead.
    if (state.historyPending[wallet]) return state.historyPending[wallet];
    if (!silent && !historyFor(wallet).length) $("#historyRows").innerHTML = `<div class="skeleton-row"></div><div class="skeleton-row"></div>`;
    const qs = "history?wallet=" + encodeURIComponent(wallet) + "&limit=120" + (force ? "&refresh=1" : "");
    state.historyPending[wallet] = (async () => {
      try {
        const h = await api(qs);
        state.historyCache[wallet] = h;
        // The merged "all" snapshot would otherwise keep a stale aggregate
        // (including a failure marker from an earlier attempt); drop it so the
        // next "all" view refetches.  Merging per-wallet entries still works.
        if (wallet !== "all") delete state.historyCache.all;
        if (state.view === "history" && state.historyWallet === wallet) renderHistory();
        if (h.ok === false && !silent) toast("记录抓取失败", String(h.error || "BAW 未返回记录"), "error");
        return h;
      } catch (e) {
        // Keep the previous snapshot: a transport error must not blank the page,
        // but it must still be visible as a failed attempt.
        const reason = String(e.message || e);
        const prev = historyEntry(wallet);
        state.historyCache[wallet] = {
          items: prev?.items || [],
          ok: false,
          error: reason,
          updatedAt: prev?.updatedAt || null,
          attemptedAt: new Date().toISOString(),
          stale: Boolean(prev?.items?.length),
          wallets: prev?.wallets || {},
          errors: [{ wallet, error: reason }],
        };
        if (state.view === "history" && state.historyWallet === wallet) renderHistory();
        if (!silent) toast("读取记录失败", reason, "error");
        return null;
      } finally {
        delete state.historyPending[wallet];
      }
    })();
    return state.historyPending[wallet];
  }

  async function prefetchHistories() {
    const wallets = state.portfolio?.wallets || [];
    // Viewing "all" uses the aggregate response; viewing one wallet loads that
    // wallet plus the others (so tab switching paints instantly).
    const ids = state.historyWallet && state.historyWallet !== "all"
      ? [...new Set([state.historyWallet, ...wallets.map((w) => w.id)])]
      : ["all"];
    for (const id of ids) {
      if (state.historyCache[id] || state.historyPending[id]) continue;
      await loadHistory(id, true);
    }
    if (state.view === "history") renderHistory();
  }

  function setView(view) {
    state.view = view;
    $("#assetsView").hidden = view !== "assets";
    $("#historyView").hidden = view !== "history";
    $("#bookView").hidden = view !== "book";
    $("#overviewBar").hidden = view === "book";
    $("#walletBar").hidden = view === "book";
    $("#bookTab").classList.toggle("is-active", view === "book");
    $("#assetsTab").classList.toggle("is-active", view === "assets");
    $("#historyTab").classList.toggle("is-active", view === "history");
    if (view === "history") {
      state.historyTick = 0;
      if (state.wallet !== "all") state.historyWallet = state.wallet;
      else if (!state.historyWallet) state.historyWallet = state.portfolio?.wallets?.[0]?.id || "all";
      renderWalletTabs();
      renderHistoryScope();
      const cached = historyFor(state.historyWallet);
      if (cached.length) renderHistory();
      else $("#historyRows").innerHTML = `<div class="skeleton-row"></div><div class="skeleton-row"></div>`;
      loadHistory(state.historyWallet, cached.length > 0);
    } else if (view === "book") {
      renderBook();
    } else {
      render();
    }
  }

  /* ---------------- copy / wallet ---------------- */
  function copyText(text) {
    const done = () => toast("已复制", text);
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch { toast("复制失败", "请手动复制", "error"); }
    ta.remove();
  }

  function openKline(address, exchange) {
    const t = findToken(address);
    if (!t) return;
    const ca = t.native ? WBNB_ADDRESS : t.address;
    const url = exchange === "binance"
      ? `https://web3.binance.com/zh-CN/token/bsc/${ca}`
      : `https://web3.okx.com/zh-hans/token/bsc/${ca}`;
    window.open(url, "_blank", "noopener");
  }

  function openHolders(address) {
    const t = findToken(address);
    if (!t) return;
    $("#holdersTitle").textContent = `${t.symbol} 持仓钱包`;
    $("#holdersList").innerHTML = (t.holders || []).map((h) => {
      const w = walletById(h.wallet);
      return `<div class="holder-row">${walletTag(w)}<div class="holder-name">${esc(w.label)}<div class="holder-addr">${esc(w.address || "")}</div></div><div class="holder-val">${fmtQty(h.qty)} ${esc(t.symbol)}<small>${fmtUsd(h.value)}</small></div></div>`;
    }).join("") || `<div class="book-empty">没有找到持仓钱包</div>`;
    $("#holdersModal").classList.add("is-open");
    $("#holdersModal").setAttribute("aria-hidden", "false");
  }

  function renderBook() {
    const list = state.book || [];
    $("#bookList").innerHTML = list.length ? list.map((x) => `
      <div class="book-row">
        <div class="book-main">
          <div class="book-name">${esc(x.name)} <span class="book-tag">本机</span></div>
          <div class="book-addr">${esc(x.address)}</div>
        </div>
        <div class="book-actions">
          <button class="book-btn" data-copy="${esc(x.address)}" type="button"><svg class="icon"><use href="#i-copy"></use></svg>复制</button>
          <button class="book-btn" data-book-edit="${esc(x.address)}" type="button"><svg class="icon"><use href="#i-pen"></use></svg>修改</button>
          <button class="book-btn" data-book-send="${esc(x.address)}" type="button"><svg class="icon"><use href="#i-send"></use></svg>发送</button>
          <button class="book-btn danger" data-book-del="${esc(x.address)}" type="button"><svg class="icon"><use href="#i-trash"></use></svg>删除</button>
        </div>
      </div>`).join("") : `<div class="book-empty">还没有地址，点右上角“添加地址”。</div>`;
    renderAgenticAddresses();
    if (state.send) renderSendBookPicks();
  }

  function renderSendBookPicks() {
    const box = $("#sendBookPicks");
    if (!box) return;
    const list = (state.book || []).filter((x) => /^0x[a-fA-F0-9]{40}$/.test(String(x.address || "")));
    if (!list.length) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.hidden = false;
    box.innerHTML = `<span class="send-book-label">地址簿</span>` + list.slice(0, 6).map((x) => `
      <button class="send-book-chip" type="button" data-send-book="${esc(x.address)}" title="${esc(x.address)}">
        ${esc(x.name)}<small>${esc(shortAddr(x.address))}</small>
      </button>`).join("");
  }

  function renderAgenticAddresses() {
    const box = $("#agenticAddressList");
    if (!box) return;
    const wallets = state.portfolio?.wallets || [];
    box.innerHTML = wallets.length ? wallets.map((w) => {
      const addr = String(w.address || "");
      const valid = /^0x[a-fA-F0-9]{40}$/.test(addr);
      return `<div class="agentic-row" data-address="${esc(addr)}">
        <div class="agentic-main">
          <div class="agentic-name">${esc(w.label)} <span>${esc(w.id)}</span></div>
          <div class="agentic-full">${esc(addr || "地址未读取")}</div>
        </div>
        <div class="agentic-actions">
          <button class="book-btn" data-copy="${esc(addr)}" type="button" ${valid ? "" : "disabled"}>复制地址</button>
          <button class="book-btn" data-receive="${esc(w.id)}" type="button" ${valid ? "" : "disabled"}>二维码收款</button>
        </div>
      </div>`;
    }).join("") : `<div class="book-empty">当前没有已连接钱包</div>`;
  }

  function renderOwnWalletPicks() {
    const box = $("#ownWalletPicks");
    if (!box) return;
    const wallets = state.portfolio?.wallets || [];
    box.innerHTML = wallets.length ? wallets.map((w) => {
      const addr = String(w.address || "");
      return `<button class="own-wallet-pick" data-own-wallet="${esc(w.id)}" type="button" title="${esc(addr)}">
        <b>${esc(w.label)}</b><small>${esc(shortAddr(addr))}</small>
      </button>`;
    }).join("") : `<span class="field-note">还没有钱包</span>`;
  }

  function openReceive(walletId) {
    const w = walletById(walletId);
    if (!w || !/^0x[a-fA-F0-9]{40}$/.test(String(w.address || ""))) {
      toast("地址未读取", "刷新后再试，不要手动输入地址", "error");
      return;
    }
    state.receiveAddress = w.address;
    $("#receiveWalletName").textContent = `${w.label} · ${w.id}`;
    $("#receiveAddress").textContent = w.address;
    $("#receiveQR").alt = `收款地址 ${w.address}`;
    $("#receiveQR").hidden = false;
    $("#receiveQRError").hidden = true;
    $("#receiveQR").src = "api/qr?text=" + encodeURIComponent(w.address);
    $("#copyReceiveAddress").textContent = "复制完整地址";
    $("#receiveModal").classList.add("is-open");
    $("#receiveModal").setAttribute("aria-hidden", "false");
  }

  function showBookForm(show, entry = null) {
    state.bookEditing = entry ? entry.address : null;
    $("#bookForm").hidden = !show;
    $("#bookName").value = entry ? entry.name : "";
    $("#bookAddress").value = entry ? entry.address : "";
    if (show) setTimeout(() => $("#bookName")?.focus(), 50);
  }

  function editBookEntry(address) {
    const entry = (state.book || []).find((x) => x.address.toLowerCase() === String(address).toLowerCase());
    if (entry) showBookForm(true, entry);
  }

  function saveBookEntry() {
    const name = $("#bookName").value.trim() || "未命名地址";
    const address = $("#bookAddress").value.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return toast("地址格式不对", "需要 0x 开头的 40 位地址", "error");
    const old = state.bookEditing;
    const base = state.book.filter((x) => x.address.toLowerCase() !== address.toLowerCase() && x.address.toLowerCase() !== String(old || "").toLowerCase());
    const color = (state.book.find((x) => x.address.toLowerCase() === String(old || "").toLowerCase()) || {}).color || COLORS[state.book.length % COLORS.length];
    saveBook([...base, { name, address, color }]);
    showBookForm(false);
    renderBook();
    toast("已保存地址", "仅保存在当前浏览器", "success");
  }

  function openWalletModal(reloginId = null) {
    const w = reloginId ? walletById(reloginId) : null;
    state.walletAdd = null;
    state.walletLogin = w ? w.id : null;
    $("#walletLabel").value = "";
    $("#walletLabelField").hidden = Boolean(w);
    $("#walletTitle").textContent = w ? `重新登录 ${w.label}` : "添加 Agentic 钱包";
    $("#walletSubtitle").textContent = w ? "扫码重新授权同一个 BAW 会话，不会新建钱包编号" : "用币安 App 扫码授权新会话";
    $("#walletStart").textContent = w ? "生成重新登录二维码" : "生成扫码二维码";
    $("#walletQR").hidden = true;
    $("#walletQRBox").innerHTML = "";
    $("#walletStatus").textContent = w
      ? `当前 ${w.id} 已退出。扫码后只恢复 ${w.id} 的会话，不会变成 W11 之类的编号。`
      : "扫码后会自动创建独立 BAW 会话，不会导入私钥。新钱包默认只读，添加后可在钱包管理开启交易。";
    $("#walletWaiting").textContent = "等待扫码…";
    $("#walletStart").disabled = false;
    $("#walletModal").classList.add("is-open");
    $("#walletModal").setAttribute("aria-hidden", "false");
    setTimeout(() => (w ? $("#walletStart") : $("#walletLabel"))?.focus(), 100);
  }

  async function startWalletAdd() {
    const label = $("#walletLabel").value.trim();
    const loginId = state.walletLogin;
    $("#walletStart").disabled = true;
    $("#walletStatus").textContent = loginId ? `正在为 ${loginId} 生成重新登录二维码…` : "正在生成二维码…";
    try {
      const r = loginId
        ? await api("wallets/" + encodeURIComponent(loginId) + "/relogin", { method: "POST", body: {} })
        : await api("wallets/start", { method: "POST", body: { label } });
      if (!r.ok) throw new Error(r.error || "生成失败");
      state.walletAdd = { slot: r.slot, timer: null, relogin: Boolean(loginId) };
      $("#walletQR").hidden = false;
      $("#walletQRBox").innerHTML = r.qrSvg || "";
      $("#walletPairing").textContent = r.pairingCode || "—";
      $("#walletExpiry").textContent = r.expiresIn ? Math.max(0, Math.round(r.expiresIn / 60)) + " 分钟" : "—";
      $("#walletUrl").href = r.url || "#";
      $("#walletStatus").textContent = loginId
        ? `请用币安 App 扫码，重新授权 ${loginId}；二维码不会创建新钱包。`
        : `钱包 ${r.slot} 已创建会话目录，请用币安 App 扫码。`;
      $("#walletWaiting").textContent = "等待扫码…";
      state.walletAdd.timer = setInterval(pollWalletAdd, 1600);
    } catch (e) {
      $("#walletStatus").textContent = String(e.message || e);
      $("#walletStart").disabled = false;
    }
  }

  async function pollWalletAdd() {
    if (!state.walletAdd) return;
    try {
      const r = await api("wallets/pending?slot=" + encodeURIComponent(state.walletAdd.slot));
      if (r.status === "added") {
        const wasRelogin = state.walletAdd.relogin;
        clearInterval(state.walletAdd.timer);
        $("#walletWaiting").textContent = wasRelogin ? "已重新登录，正在刷新资产…" : "已添加，正在刷新资产…";
        toast(wasRelogin ? "会话已恢复" : "钱包已添加", `${r.wallet?.label || state.walletAdd.slot} 已上线`, "success");
        state.walletAdd = null;
        state.walletLogin = null;
        state.historyCache = {};
        setTimeout(() => closeModal("wallet"), 900);
        loadPortfolio();
        return;
      }
      if (r.status === "expired" || r.status === "failed") {
        clearInterval(state.walletAdd.timer);
        state.walletAdd = null;
        $("#walletWaiting").textContent = r.error || "二维码已过期，请重新生成。";
        $("#walletStart").disabled = false;
      }
    } catch {}
  }

  async function deleteWallet(id) {
    const w = walletById(id);
    if (!confirm(`从看板移除「${w.label}」？\n只移除显示，不登出 BAW 会话；之后可重新添加。`)) return;
    try {
      await api("wallets/" + encodeURIComponent(id), { method: "DELETE" });
      if (state.wallet === id) state.wallet = "all";
      if (state.historyWallet === id) state.historyWallet = "all";
      delete state.historyCache[id];
      delete state.historyCache.all;
      toast("已移除钱包", w.label, "success");
      loadPortfolio();
    } catch (e) {
      toast("移除失败", String(e.message || e), "error");
    }
  }

  async function toggleWalletTrade(id) {
    const w = walletById(id);
    if (!w) return;
    const next = !w.trade;
    if (next && !confirm(`开启「${w.label}」的交易权限？\n开启后可执行卖出和发送。`)) return;
    try {
      await api("wallets/" + encodeURIComponent(id) + "/trade", { method: "POST", body: { trade: next } });
      w.trade = next;
      render();
      toast(next ? "交易权限已开启" : "已设为只读", w.label, "success");
    } catch (e) {
      toast("修改失败", String(e.message || e), "error");
    }
  }

  async function renameWallet(id) {
    const w = walletById(id);
    if (!w) return;
    const label = prompt("修改钱包名称（只影响这个看板）", w.label);
    if (label == null) return;
    const clean = label.trim();
    if (!clean) return toast("名称不能为空", "", "error");
    try {
      await api("wallets/" + encodeURIComponent(id) + "/rename", { method: "POST", body: { label: clean.slice(0, 30) } });
      w.label = clean.slice(0, 30);
      render();
      toast("名称已修改", clean, "success");
    } catch (e) {
      toast("修改失败", String(e.message || e), "error");
    }
  }

  /* ---------------- sell ---------------- */
  function findToken(address) {
    return (state.portfolio?.tokens || []).find((t) => String(t.address).toLowerCase() === String(address).toLowerCase());
  }

  function openSell(address, pct = 50) {
    const token = findToken(address);
    if (!token) return toast("找不到代币", "刷新后再试", "error");
    let holders = token.holders || [];
    if (state.wallet !== "all") holders = holders.filter((h) => h.wallet === state.wallet);
    if (!holders.length) return toast("没有可卖的钱包", "切换钱包后再试", "error");
    const selected = state.wallet !== "all" ? [state.wallet] : [holders[0].wallet];
    state.sell = { token, holders, wallets: selected, mode: "pct", amount: "", pct: Number(pct) || 50, slippage: null, autoSlip: true, quote: null, quoteLoading: false };
    $("#sellSymbolBig").textContent = String(token.symbol || "?").toUpperCase();
    $("#sellTitle").textContent = `卖出 ${token.symbol}`;
    $("#sellSub").textContent = `${holders.length} 个钱包持有 · ${fmtQty(token.qty)} ${token.symbol}`;
    $("#sellForm").hidden = false;
    $("#sellProgress").hidden = true;
    $("#sellConfirm").disabled = true;
    $("#sellConfirm").textContent = "正在报价…";
    $("#customPct").value = "";
    $("#sellAmountInput").value = "";
    $("#sellSymbolUnit").textContent = token.symbol;
    $("#slipInput").value = "1";
    $("#autoSlipText").textContent = "—";
    $("#sellPhone").hidden = true;
    $("#taxAlert").hidden = true;
    $("#quoteTax").textContent = "—";
    $$("#sellMode button").forEach((b) => b.classList.toggle("is-active", b.dataset.smode === "pct"));
    $("#sellPctBox").hidden = false;
    $("#sellAmountBox").hidden = true;
    renderSellWallets();
    renderSellPct();
    updateSellHint();
    $("#sellModal").classList.add("is-open");
    $("#sellModal").setAttribute("aria-hidden", "false");
    fetchQuote();
  }

  function renderSellWallets() {
    if (!state.sell) return;
    const { token, holders, wallets } = state.sell;
    $("#sellWallets").innerHTML = holders.map((h) => {
      const w = walletById(h.wallet);
      return `<label class="pick ${wallets.includes(h.wallet) ? "is-on" : ""}">
        <input type="checkbox" data-sell-wallet="${h.wallet}" ${wallets.includes(h.wallet) ? "checked" : ""}>
        <span class="pick-box"><svg class="icon"><use href="#i-check"></use></svg></span>
        ${walletTag(w)}
        <span class="pick-name"><strong>${esc(w.label)}</strong><small>${esc(shortAddr(w.address))}</small></span>
        <span class="pick-bal">${fmtQty(h.qty)} ${esc(token.symbol)}<small>${fmtUsd(h.value)}</small></span>
      </label>`;
    }).join("");
  }

  function renderSellPct() {
    if (!state.sell) return;
    $$("#sellPcts button").forEach((b) => b.classList.toggle("is-active", state.sell.mode === "pct" && Number(b.dataset.pct) === Number(state.sell.pct)));
    $$("#sellMode button").forEach((b) => b.classList.toggle("is-active", b.dataset.smode === state.sell.mode));
    $("#sellPctBox").hidden = state.sell.mode !== "pct";
    $("#sellAmountBox").hidden = state.sell.mode !== "amount";
    updateSellHint();
  }

  function sellTotalQty() {
    if (!state.sell) return 0;
    return state.sell.holders.filter((h) => state.sell.wallets.includes(h.wallet)).reduce((s, h) => s + Number(h.qty), 0);
  }

  function updateSellHint() {
    if (!state.sell) return;
    const { token, wallets, mode, amount, pct } = state.sell;
    const total = sellTotalQty();
    $("#sellQtyHint").textContent = `合计 ${fmtQty(total)} ${token.symbol} · ${fmtUsd(total * Number(token.price))}`;
    $$("#sellPcts button").forEach((b) => {
      const q = total * Number(b.dataset.pct) / 100;
      const sub = b.querySelector("[data-pct-qty]");
      if (sub) sub.textContent = fmtQty(q);
    });
    $("#customPctQty").textContent = Number(pct) > 0 ? fmtQty(total * Number(pct) / 100) : "—";
    if (mode === "amount") {
      const n = Number(amount);
      const approx = total > 0 && n > 0 ? n / total * 100 : 0;
      $("#sellAmountNote").textContent = n > 0 ? `约占总持仓 ${approx.toFixed(2)}% · 合计 ${fmtQty(total)} ${token.symbol}` : `合计 ${fmtQty(total)} ${token.symbol}`;
    }
    $("#sellConfirm").textContent = `确认卖出 · ${wallets.length} 个钱包`;
  }

  let quoteTimer = null;
  function scheduleQuote() {
    if (state.sell) {
      state.sell.quote = null;
      $("#sellConfirm").disabled = true;
      $("#quoteGuard").className = "guard";
      $("#quoteGuard").textContent = "数量/钱包已变化，等待新报价…";
    }
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(fetchQuote, 180);
  }

  async function fetchQuote() {
    if (!state.sell) return;
    state.sell.quote = null;
    $("#sellConfirm").disabled = true;
    const { token, wallets, mode, amount, pct, autoSlip, slippage } = state.sell;
    if (!wallets.length) {
      $("#quoteAmount").textContent = "—";
      $("#quoteGuard").className = "guard warn";
      $("#quoteGuard").textContent = "至少选择一个钱包";
      $("#sellConfirm").disabled = true;
      return;
    }
    if (mode === "amount" && !(Number(amount) > 0)) {
      $("#quoteAmount").textContent = "—";
      $("#quoteGuard").className = "guard warn";
      $("#quoteGuard").textContent = "请输入卖出数量";
      $("#sellConfirm").disabled = true;
      return;
    }
    const wallet = wallets.slice().sort((a, b) => {
      const ha = state.sell.holders.find((h) => h.wallet === a);
      const hb = state.sell.holders.find((h) => h.wallet === b);
      return Number(hb?.value || 0) - Number(ha?.value || 0);
    })[0];
    const totalQty = sellTotalQty();
    const repQty = state.sell.holders.find((h) => h.wallet === wallet)?.qty || 0;
    const quoteQty = mode === "amount" && totalQty > 0 ? Number(amount) * Number(repQty) / totalQty : null;
    const seq = ++state.quoteSeq;
    state.sell.quoteLoading = true;
    $("#quoteGuard").className = "guard";
    $("#quoteGuard").textContent = "正在向 BAW 要报价…";
    $("#sellConfirm").disabled = true;
    try {
      const q = await api("quote", {
        method: "POST",
        body: { wallet, token: token.address, pct: mode === "pct" ? pct : null, qty: quoteQty, slippage: autoSlip ? "auto" : Number(slippage || 1) }
      });
      if (seq !== state.quoteSeq || !state.sell) return;
      state.sell.quote = q;
      if (q.ok) {
        const quote = q;
        const pctNum = Number(quote.slippagePct) || 0;
        if (autoSlip && pctNum > 0) {
          state.sell.slippage = Math.max(0.1, Math.min(50, pctNum));
          $("#slipInput").value = state.sell.slippage;
          $("#autoSlipText").textContent = pctNum.toFixed(pctNum < 1 ? 1 : 0) + "%";
        }
        const sellQty = mode === "amount" ? Number(amount) : totalQty * (Number(pct) / 100);
        const ratio = Number(quote.fromAmount) ? Number(quote.toAmount) / Number(quote.fromAmount) : 0;
        const estimate = sellQty * ratio;
        $("#quoteAmount").innerHTML = `≈ ${fmtQty(estimate)} <span>${esc(quote.toSymbol || "USDT")}</span>`;
        $("#quoteSub").textContent = mode === "amount"
          ? `按数量卖 · ${wallets.length} 个钱包合计 · 以 ${esc(walletById(wallet).label)} 为例`
          : `按 ${esc(quote.fromSymbol || token.symbol)} 报价 · ${wallets.length} 个钱包合计 · 以 ${esc(walletById(wallet).label)} 为例`;
        $("#quotePrice").textContent = fmtPrice(quote.marketPrice);
        $("#quotePool").textContent = `${quote.pool?.dex || "—"}${quote.pool?.labels?.length ? " " + quote.pool.labels[0].toUpperCase() : ""}`;
        $("#quotePair").textContent = quote.pool?.pair ? shortAddr(quote.pool.pair) : "—";
        $("#quoteLiquidity").textContent = fmtLiq(quote.pool?.liquidity || 0);
        const tax = quote.tax || {};
        const buyTax = tax.buy == null ? "?" : tax.buy;
        const sellTax = tax.sell == null ? "?" : tax.sell;
        const taxUnknown = quote.taxUnknown === true;
        $("#quoteTax").textContent = taxUnknown ? "买 ? / 卖 ?（未检测）" : `买 ${buyTax}% / 卖 ${sellTax}%`;
        $("#quoteTax").style.color = (taxUnknown || Number(tax.sell) > 10) ? "var(--red)" : "";
        $("#taxAlert").hidden = !(taxUnknown || Number(tax.sell) > 10);
        $("#taxAlert").textContent = taxUnknown
          ? "注意：该代币交易税尚未检测完成。仍然可以继续，但确认卖出时会额外弹窗提醒；成交后请核对实际到账。"
          : Number(tax.sell) > 10 ? `注意：该代币卖出税为 ${sellTax}%，成交后实际到账会明显减少；确认卖出时会再弹一次确认。` : "";
        const dev = Number(quote.deviationPct) || 0;
        $("#quoteDeviation").textContent = fmtPct(dev);
        $("#quoteDeviation").style.color = quote.guard === "blocked" ? "var(--red)" : quote.guard === "warn" ? "var(--amber)" : "var(--green)";
        const guard = $("#quoteGuard");
        if (quote.guard === "blocked") {
          guard.className = "guard danger";
          guard.textContent = `报价比最优池低 ${Math.abs(dev).toFixed(2)}%，已自动拦截，不提交。`;
          $("#sellConfirm").disabled = true;
        } else if (quote.guard === "warn") {
          guard.className = "guard warn";
          guard.textContent = `BAW 报价比最优池低 ${Math.abs(dev).toFixed(2)}%，仍可卖，但到手会少一点。`;
          $("#sellConfirm").disabled = false;
        } else {
          guard.className = "guard ok";
          guard.textContent = `已对齐最优池（偏差 ${fmtPct(dev)}），可提交。`;
          $("#sellConfirm").disabled = false;
        }
        $("#slipNote").textContent = quote.guard === "blocked" ? "报价异常，建议刷新后重新打开；不要强行卖出。" : `池子推荐 ${pctNum.toFixed(1)}%；新币开盘可手动调高。`;
        $("#slipNote").className = quote.guard === "blocked" ? "field-note" : "field-note safe";
      } else {
        $("#quoteAmount").textContent = "报价失败";
        $("#quoteSub").textContent = q.error || "BAW 没有返回报价";
        $("#quoteGuard").className = "guard danger";
        $("#quoteGuard").textContent = q.error || "BAW 没有返回报价";
        $("#sellConfirm").disabled = true;
        $("#taxAlert").hidden = true;
        if (q.needsPhoneConfirm) $("#sellPhone").hidden = false;
      }
    } catch (e) {
      if (seq !== state.quoteSeq) return;
      $("#quoteAmount").textContent = "报价失败";
      $("#quoteGuard").className = "guard danger";
      $("#quoteGuard").textContent = String(e.message || e);
      $("#sellConfirm").disabled = true;
    } finally {
      if (seq === state.quoteSeq) state.sell.quoteLoading = false;
      const via = $("#quoteVia");
      if (via) via.textContent = wallets.length > 1 ? "以 " + walletById(wallet).label + " 为例" : "";
    }
  }

  async function submitSell() {
    if (!state.sell || !state.sell.quote?.ok || state.sell.quote.guard === "blocked") return;
    const s = state.sell;
    const tax = s.quote?.tax || {};
    const taxUnknown = s.quote?.taxUnknown === true;
    if (taxUnknown) {
      if (!confirm("该代币交易税尚未检测完成。\n可能包含买入税/卖出税，实际到账可能明显减少。\n确认继续卖出？")) return;
    }
    if (Number(tax.sell) > 10) {
      if (!confirm(`该代币卖出税为 ${tax.sell}%（买入税 ${tax.buy ?? "?"}%）。\n税后实际到账会明显减少，确认继续卖出？`)) return;
    }
    $("#sellForm").hidden = true;
    $("#sellProgress").hidden = false;
    $("#sellProgress").innerHTML = `<div class="progress-head"><strong>正在提交 ${s.wallets.length} 笔卖出</strong><span>逐号提交，请稍候</span></div>${s.wallets.map((w) => `<div class="leg"><span class="leg-ico"><svg class="icon"><use href="#i-clock"></use></svg></span><span class="leg-main"><strong>${esc(walletById(w).label)}</strong><small>准备中</small></span><span class="leg-state">排队</span></div>`).join("")}`;
    try {
      const task = await api("sell", {
        method: "POST",
        body: {
          walletIds: s.wallets,
          token: s.token.address,
          amount: s.mode === "amount" ? s.amount : null,
          pct: s.mode === "amount" ? null : s.pct,
          slippage: s.slippage || 1,
          taxAck: Number(tax.sell) > 10,
          taxUnknownAck: taxUnknown,
          idempotencyKey: s.idem || (s.idem = "sell-" + Date.now() + "-" + Math.random().toString(36).slice(2))
        }
      });
      pollTask(task.id, "sell");
    } catch (e) {
      $("#sellProgress").innerHTML = `<div class="guard danger">${esc(e.message || e)}</div>`;
    }
  }

  async function pollTask(id, kind) {
    const modal = kind === "sell" ? $("#sellModal") : $("#sendModal");
    const progress = kind === "sell" ? $("#sellProgress") : $("#sendProgress");
    const deadline = Date.now() + 240000;
    let last = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 900));
      let task;
      try { task = await api("task/" + encodeURIComponent(id)); } catch { continue; }
      if (!modal.classList.contains("is-open")) return;
      last = task;
      const terminal = ["submitted", "partial", "failed", "needs_confirm", "unknown"].includes(task.status);
      const head = `<div class="progress-head"><strong>${task.status === "submitted" ? "已提交" : task.status === "needs_confirm" ? "等待手机确认" : task.status === "partial" ? "部分成功" : task.status === "unknown" ? "结果待核实" : task.status === "failed" ? "失败" : "正在提交"}</strong><span>${esc(task.status)}</span></div>`;
      progress.innerHTML = head + (task.legs || []).map((leg) => {
        const status = leg.status === "submitted" ? "done" : leg.status === "needs_confirm" || leg.status === "unknown" ? "wait" : leg.status === "failed" ? "fail" : "";
        const text = leg.status === "submitted" ? "已提交" : leg.status === "needs_confirm" ? "需手机确认" : leg.status === "unknown" ? "结果待核实" : leg.status === "failed" ? "失败" : "进行中";
        return `<div class="leg ${status}"><span class="leg-ico"><svg class="icon"><use href="#${status === "done" ? "i-check" : status === "fail" ? "i-alert" : "i-clock"}"></use></svg></span><span class="leg-main"><strong>${esc(walletById(leg.wallet).label)}</strong><small>${esc(leg.txHash || (leg.orderId ? "订单 " + leg.orderId : leg.error || leg.qty || "准备中"))}</small></span><span class="leg-state">${text}</span></div>`;
      }).join("") + `<p class="modal-note">任务 ID：${esc(task.id || id)}</p>` + (task.error ? `<p class="modal-note">错误：${esc(String(task.error).split("\n").filter(Boolean).slice(-1)[0])}</p>` : "") + (["unknown", "failed", "needs_confirm"].includes(task.status) ? `<button class="text-btn" type="button" data-task-recheck="${esc(task.id || id)}" data-task-kind="${esc(kind)}">重新查询任务</button>` : "");
      if (!terminal) continue;
      if (task.status === "needs_confirm") {
        if (kind === "sell") $("#sellPhone").hidden = false;
        toast("需要到手机确认", "请打开币安 App 确认这笔交易", "error");
        break;
      }
      setTimeout(loadPortfolio, 500);
      setTimeout(() => loadHistory(state.wallet, true), 1000);
      if (task.status === "submitted") {
        toast(kind === "sell" ? "卖出已提交" : "发送已提交", "余额会在几秒内刷新", "success");
        setTimeout(() => closeModal(kind), 1200);
      } else if (task.status === "partial") {
        toast("部分成功，请逐笔核对", "不要重复提交；先查看失败的钱包和交易记录", "error");
      } else if (task.status === "unknown") {
        toast("提交结果待核实", "服务曾重启或超时，请按任务 ID / 交易哈希核对，不要盲目重试", "error");
      } else {
        toast(kind === "sell" ? "卖出失败" : "发送失败", "看弹窗里的逐号失败原因；不要重复提交", "error");
      }
      break;
    }
    if (last && !["submitted", "partial", "failed", "needs_confirm", "unknown"].includes(last.status)) {
      progress.insertAdjacentHTML("beforeend", `<p class="modal-note">轮询超时，提交结果待核实。任务 ID：${esc(last.id || id)}。请先核对钱包记录，不要重复提交。</p>`);
      toast("提交结果待核实", "请按任务 ID / 交易哈希核对后再操作", "error");
    }
  }

  /* ---------------- send ---------------- */
  function openSend(address, presetRecipient = "") {
    let token = address ? findToken(address) : null;
    if (!token) token = (state.portfolio?.tokens || []).find((t) => String(t.symbol).toUpperCase() === "BNB") || (state.portfolio?.tokens || [])[0];
    if (!token) return toast("没有可发送资产", "刷新后再试", "error");
    let holders = token.holders || [];
    if (state.wallet !== "all") holders = holders.filter((h) => h.wallet === state.wallet);
    if (!holders.length) return toast("没有可发送的钱包", "切换钱包后再试", "error");
    const usable = holders.filter((h) => {
      const w = walletById(h.wallet);
      return w?.status === "online" && w?.trade && !w?.sessionBlocked;
    });
    let selected = [];
    if (state.wallet !== "all" && usable.some((h) => h.wallet === state.wallet)) selected = [state.wallet];
    else if (usable.length) selected = [usable[0].wallet];
    if (!usable.length) toast("没有可用发送钱包", "持有钱包已退出、只读或地址不一致；先在钱包管理处理", "error");
    state.send = { token, holders, wallets: selected, mode: "manual", amount: "", pct: null, recipient: presetRecipient || "" };
    $("#sendSymbolBig").textContent = String(token.symbol || "?").toUpperCase();
    $("#sendTitle").textContent = `发送 ${token.symbol}`;
    $("#sendSymbolUnit").textContent = token.symbol;
    $("#sendAmountInput").value = "";
    $("#recipientInput").value = state.send.recipient;
    $("#sendForm").hidden = false;
    $("#sendProgress").hidden = true;
    renderOwnWalletPicks();
    renderSendWallets();
    renderSendBookPicks();
    renderSendSummary();
    $("#sendModal").classList.add("is-open");
    $("#sendModal").setAttribute("aria-hidden", "false");
    setTimeout(() => $("#recipientInput")?.focus(), 100);
  }

  function renderSendWallets() {
    if (!state.send) return;
    const { token, holders, wallets } = state.send;
    $("#sendWallets").innerHTML = holders.map((h) => {
      const w = walletById(h.wallet);
      const blocked = w.sessionBlocked || w.status !== "online" || !w.trade;
      const reason = w.sessionBlocked ? "地址不一致，需重新登录"
        : w.status !== "online" ? "会话已退出，需重新登录"
        : !w.trade ? "只读，需先开启交易" : esc(shortAddr(w.address));
      return `<label class="pick ${wallets.includes(h.wallet) ? "is-on" : ""} ${blocked ? "is-off" : ""}">
        <input type="checkbox" data-send-wallet="${h.wallet}" ${wallets.includes(h.wallet) ? "checked" : ""} ${blocked ? "disabled" : ""}>
        <span class="pick-box"><svg class="icon"><use href="#i-check"></use></svg></span>
        ${walletTag(w)}
        <span class="pick-name"><strong>${esc(w.label)}</strong><small>${reason}</small></span>
        <span class="pick-bal">${fmtQty(h.qty)} ${esc(token.symbol)}<small>${fmtUsd(h.value)}</small></span>
      </label>`;
    }).join("");
    $$("#sendPcts button").forEach((b) => b.classList.toggle("is-active", state.send.mode === "pct" && Number(b.dataset.spct) === Number(state.send.pct)));
  }

  function renderSendSummary() {
    if (!state.send) return;
    const { token, holders, wallets, mode, amount, pct, recipient } = state.send;
    const selected = holders.filter((h) => wallets.includes(h.wallet));
    const manual = Number(amount);
    const perManual = mode === "manual" ? manual : 0;
    const total = mode === "manual"
      ? perManual * selected.length
      : selected.reduce((s, h) => s + Number(h.qty), 0) * Number(pct) / 100;
    const validAmount = mode === "manual" ? perManual > 0 : Number(pct) > 0;
    $("#sendTokenLabel").textContent = token.symbol;
    $("#sendAddressLabel").textContent = recipient || "未填写";
    $("#sendWalletLabel").textContent = `${selected.length} 个`;
    $("#sendTotalLabel").textContent = validAmount ? `${fmtQty(total)} ${token.symbol}` : "—";
    $("#sendQtyHint").textContent = mode === "manual"
      ? (validAmount ? `每号 ${fmtQty(perManual)} · 合计 ${fmtQty(total)}` : "手动输入数量")
      : (validAmount ? `合计 ${fmtQty(total)}` : "选择百分比");
    $("#sendConfirm").textContent = selected.length ? `确认发送 · ${selected.length} 个钱包` : "没有可用钱包";
    $("#sendConfirm").disabled = !recipient || !/^0x[a-fA-F0-9]{40}$/.test(recipient) || !selected.length || !validAmount;
  }

  async function submitSend() {
    if (!state.send || !/^0x[a-fA-F0-9]{40}$/.test(state.send.recipient) || !state.send.wallets.length) return;
    const s = state.send;
    $("#sendForm").hidden = true;
    $("#sendProgress").hidden = false;
    $("#sendProgress").innerHTML = `<div class="progress-head"><strong>正在提交 ${s.wallets.length} 笔发送</strong><span>逐号提交</span></div>${s.wallets.map((w) => `<div class="leg"><span class="leg-ico"><svg class="icon"><use href="#i-clock"></use></svg></span><span class="leg-main"><strong>${esc(walletById(w).label)}</strong><small>准备中</small></span><span class="leg-state">排队</span></div>`).join("")}`;
    try {
      const task = await api("send", {
        method: "POST",
        body: {
          walletIds: s.wallets,
          token: s.token.address,
          amount: s.mode === "manual" ? s.amount : null,
          pct: s.mode === "manual" ? null : s.pct,
          recipient: s.recipient,
          idempotencyKey: s.idem || (s.idem = "send-" + Date.now() + "-" + Math.random().toString(36).slice(2))
        }
      });
      pollTask(task.id, "send");
    } catch (e) {
      $("#sendProgress").innerHTML = `<div class="guard danger">${esc(e.message || e)}</div>`;
    }
  }

  /* ---------------- events ---------------- */
  function bind() {
    $("#themeBtn").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
    $("#bookTab").addEventListener("click", () => setView("book"));
    $("#riskToggle").addEventListener("click", () => { const p = $("#riskPanel"); p.hidden = !p.hidden; });
    $("#keepaliveBtn").addEventListener("click", () => { $("#keepaliveModal").classList.add("is-open"); $("#keepaliveModal").setAttribute("aria-hidden", "false"); });
    $("#assetsTab").addEventListener("click", () => setView("assets"));
    $("#historyTab").addEventListener("click", () => setView("history"));
    $("#copyReceiveAddress").addEventListener("click", () => { if (state.receiveAddress) copyText(state.receiveAddress); });
    $("#receiveQR").addEventListener("error", () => {
      $("#receiveQR").hidden = true;
      $("#receiveQRError").hidden = false;
    });
    $("#bookAddBtn").addEventListener("click", () => showBookForm(true));
    $("#bookCancel").addEventListener("click", () => showBookForm(false));
    $("#bookSave").addEventListener("click", saveBookEntry);
    $("#addWalletBtn").addEventListener("click", () => openWalletModal());
    $("#railAddWallet").addEventListener("click", () => openWalletModal());
    $("#walletStart").addEventListener("click", startWalletAdd);
    $("#hideLow").addEventListener("change", (e) => { state.hideLow = e.target.checked; state.showAll = !e.target.checked; render(); });
    $("#noticeShow").addEventListener("click", () => { state.showAll = !state.showAll; $("#hideLow").checked = !state.showAll; render(); });
    $("#searchInput").addEventListener("input", (e) => { state.search = e.target.value; renderAssets(); });
    $("#riskFilter").addEventListener("click", (e) => {
      const b = e.target.closest("[data-filter]");
      if (!b) return;
      state.riskFilter = b.dataset.filter;
      $$("#riskFilter button").forEach((x) => x.classList.toggle("is-active", x === b));
      renderAssets();
    });
    $("#historyFilter").addEventListener("click", (e) => {
      const b = e.target.closest("[data-hfilter]");
      if (!b) return;
      state.historyFilter = b.dataset.hfilter;
      $$("#historyFilter button").forEach((x) => x.classList.toggle("is-active", x === b));
      renderHistory();
    });
    $("#historyRefresh").addEventListener("click", (e) => {
      const btn = e.currentTarget;
      if (btn.disabled) return;
      btn.disabled = true;
      // A repeated click while a fetch is in flight is collapsed by loadHistory.
      loadHistory(state.historyWallet, false, true).finally(() => { btn.disabled = false; });
    });

    document.addEventListener("click", (e) => {
      const add = e.target.closest("[data-add-wallet]");
      if (add) { openWalletModal(); return; }
      const del = e.target.closest("[data-del-wallet]");
      if (del) { deleteWallet(del.dataset.delWallet); return; }
      const rename = e.target.closest("[data-rename-wallet]");
      if (rename) { renameWallet(rename.dataset.renameWallet); return; }
      const tradeToggle = e.target.closest("[data-trade-wallet]");
      if (tradeToggle) { toggleWalletTrade(tradeToggle.dataset.tradeWallet); return; }
      const receive = e.target.closest("[data-receive]");
      if (receive) { openReceive(receive.dataset.receive); return; }
      const ownWallet = e.target.closest("[data-own-wallet]");
      if (ownWallet && state.send) {
        const w = walletById(ownWallet.dataset.ownWallet);
        if (!w || !/^0x[a-fA-F0-9]{40}$/.test(String(w.address || ""))) return toast("地址未读取", "刷新后再试", "error");
        state.send.recipient = w.address;
        $("#recipientInput").value = w.address;
        renderSendSummary();
        if (state.send.wallets.includes(w.id)) toast("注意", "收款地址也是本次发送钱包之一，请核对", "error");
        return;
      }
      const resources = e.target.closest("[data-open-resources]");
      if (resources) { $("#resourcesModal").classList.add("is-open"); $("#resourcesModal").setAttribute("aria-hidden", "false"); return; }
      const recheck = e.target.closest("[data-task-recheck]");
      if (recheck) { pollTask(recheck.dataset.taskRecheck, recheck.dataset.taskKind || "send"); return; }
      const relogin = e.target.closest("[data-relogin-wallet]");
      if (relogin) { openWalletModal(relogin.dataset.reloginWallet); return; }
      const sendBook = e.target.closest("[data-send-book]");
      if (sendBook && state.send) {
        const address = sendBook.dataset.sendBook;
        if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return toast("地址无效", "", "error");
        state.send.recipient = address;
        $("#recipientInput").value = address;
        renderSendSummary();
        return;
      }
      const bookSend = e.target.closest("[data-book-send]");
      if (bookSend) { openSend(null, bookSend.dataset.bookSend); return; }
      const bookEdit = e.target.closest("[data-book-edit]");
      if (bookEdit) { editBookEntry(bookEdit.dataset.bookEdit); return; }
      const bookDel = e.target.closest("[data-book-del]");
      if (bookDel) {
        if (!confirm("从地址簿删除这个地址？")) return;
        saveBook(state.book.filter((x) => x.address.toLowerCase() !== bookDel.dataset.bookDel.toLowerCase()));
        renderBook();
        toast("已删除地址", "", "success");
        return;
      }
      const holders = e.target.closest("[data-holders]");
      if (holders) { openHolders(holders.dataset.holders); return; }
      const okx = e.target.closest("#useOkxAddress");
      if (okx && state.send) {
        const saved = (state.book || []).find((x) => /okx/i.test(x.name) && /^0x[a-fA-F0-9]{40}$/.test(String(x.address || "")));
        const address = saved?.address || OKX_ADDRESS;
        if (!/^0x[a-fA-F0-9]{40}$/.test(String(address || ""))) return toast("还没有 OKX 地址", "先在地址簿添加，或直接手动粘贴", "error");
        state.send.recipient = address;
        $("#recipientInput").value = address;
        renderSendSummary();
        return;
      }
      if (e.target.closest("#openBookFromSend")) { closeModal("send"); setView("book"); return; }
      const w = e.target.closest("[data-wallet]");
      if (w) {
        const id = w.dataset.wallet;
        if (state.view === "history") {
          state.historyWallet = id;
          renderWalletTabs();
          renderHistoryScope();
          const cached = historyFor(id);
          if (cached.length) renderHistory();
          else $("#historyRows").innerHTML = `<div class="skeleton-row"></div><div class="skeleton-row"></div>`;
          loadHistory(id, cached.length > 0);
        } else {
          state.wallet = id;
          render();
        }
        return;
      }
      const copy = e.target.closest("[data-copy]");
      if (copy) { copyText(copy.dataset.copy); return; }
      const sell = e.target.closest("[data-sell]");
      if (sell) { openSell(sell.dataset.sell, Number(sell.dataset.pct) || 50); return; }
      const menu = e.target.closest("[data-menu]");
      if (menu) { openRowMenu(menu.dataset.menu, menu); return; }
      const send = e.target.closest("[data-send]");
      if (send) { openSend(send.dataset.send); return; }
      const kline = e.target.closest("[data-kline]");
      if (kline) {
        openKline(kline.dataset.kline, kline.dataset.exchange || "okx");
        return;
      }
      if (!e.target.closest("#rowMenu") && !e.target.closest("[data-menu]")) $("#rowMenu")?.remove();
    });

    $$("[data-close]").forEach((el) => el.addEventListener("click", () => closeModal(el.dataset.close)));

    $("#sellWallets").addEventListener("change", (e) => {
      const input = e.target.closest("[data-sell-wallet]");
      if (!input || !state.sell) return;
      if (input.checked) state.sell.wallets = [...new Set([...state.sell.wallets, input.dataset.sellWallet])];
      else state.sell.wallets = state.sell.wallets.filter((w) => w !== input.dataset.sellWallet);
      state.sell.wallets = state.sell.wallets.filter((w) => state.sell.holders.some((h) => h.wallet === w));
      renderSellWallets(); updateSellHint(); fetchQuote();
    });
    $("#sellMode").addEventListener("click", (e) => {
      const b = e.target.closest("[data-smode]");
      if (!b || !state.sell) return;
      state.sell.mode = b.dataset.smode;
      if (state.sell.mode === "pct") $("#sellAmountInput").value = "";
      renderSellPct();
      updateSellHint();
      fetchQuote();
    });
    $("#sellPcts").addEventListener("click", (e) => {
      const b = e.target.closest("[data-pct]");
      if (!b || !state.sell) return;
      state.sell.mode = "pct";
      state.sell.pct = Number(b.dataset.pct);
      $("#customPct").value = "";
      renderSellPct(); updateSellHint(); fetchQuote();
    });
    $("#customPct").addEventListener("input", (e) => {
      if (!state.sell) return;
      const n = Math.max(0.1, Math.min(100, Number(e.target.value) || 0));
      if (!n) return;
      state.sell.mode = "pct";
      state.sell.pct = n;
      $$("#sellPcts button").forEach((b) => b.classList.remove("is-active"));
      updateSellHint(); scheduleQuote();
    });
    $("#sellAmountInput").addEventListener("input", (e) => {
      if (!state.sell) return;
      state.sell.mode = "amount";
      state.sell.amount = e.target.value.trim();
      renderSellPct();
      updateSellHint();
      scheduleQuote();
    });
    $("#slipInput").addEventListener("input", (e) => {
      if (!state.sell) return;
      state.sell.autoSlip = false;
      state.sell.slippage = Math.max(0.1, Math.min(50, Number(e.target.value) || 0));
      $("#slipNote").textContent = state.sell.slippage > 20 ? "滑点偏高，可能被夹。" : "手动滑点；报价由 BAW 重新获取。";
      scheduleQuote();
    });
    $("#autoSlip").addEventListener("click", () => { if (state.sell) { state.sell.autoSlip = true; fetchQuote(); } });
    $$(".slip-quick button").forEach((b) => b.addEventListener("click", () => {
      if (!state.sell) return;
      state.sell.autoSlip = false;
      state.sell.slippage = Number(b.dataset.slip);
      $("#slipInput").value = state.sell.slippage;
      fetchQuote();
    }));
    $("#sellAllWallets").addEventListener("click", () => {
      if (!state.sell) return;
      state.sell.wallets = state.sell.holders.map((h) => h.wallet);
      renderSellWallets(); updateSellHint(); fetchQuote();
    });
    $("#sellConfirm").addEventListener("click", submitSell);

    $("#sendWallets").addEventListener("change", (e) => {
      const input = e.target.closest("[data-send-wallet]");
      if (!input || !state.send) return;
      if (input.checked) state.send.wallets = [...new Set([...state.send.wallets, input.dataset.sendWallet])];
      else state.send.wallets = state.send.wallets.filter((w) => w !== input.dataset.sendWallet);
      state.send.wallets = state.send.wallets.filter((w) => state.send.holders.some((h) => h.wallet === w));
      renderSendWallets(); renderSendSummary();
    });
    $("#sendPcts").addEventListener("click", (e) => {
      const b = e.target.closest("[data-spct]");
      if (!b || !state.send) return;
      state.send.mode = "pct";
      state.send.pct = Number(b.dataset.spct);
      state.send.amount = "";
      $("#sendAmountInput").value = "";
      renderSendWallets(); renderSendSummary();
    });
    $("#sendAmountInput").addEventListener("input", (e) => {
      if (!state.send) return;
      state.send.mode = "manual";
      state.send.amount = e.target.value.trim();
      state.send.pct = null;
      renderSendWallets(); renderSendSummary();
    });
    $("#sendAllWallets").addEventListener("click", () => {
      if (!state.send) return;
      state.send.wallets = state.send.holders.map((h) => h.wallet);
      renderSendWallets(); renderSendSummary();
    });
    $("#recipientInput").addEventListener("input", (e) => {
      if (!state.send) return;
      state.send.recipient = e.target.value.trim();
      renderSendSummary();
    });
    $("#sendConfirm").addEventListener("click", submitSend);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        $$(".modal.is-open").forEach((m) => closeModal(m.id.replace("Modal", "")));
        $("#rowMenu")?.remove();
      }
    });
  }

  function closeModal(name) {
    const el = $("#" + name + "Modal");
    if (!el) return;
    el.classList.remove("is-open");
    el.setAttribute("aria-hidden", "true");
    if (name === "sell") { $("#sellForm").hidden = false; $("#sellProgress").hidden = true; state.sell = null; }
    if (name === "send") { $("#sendForm").hidden = false; $("#sendProgress").hidden = true; state.send = null; }
    if (name === "wallet") {
      if (state.walletAdd?.timer) clearInterval(state.walletAdd.timer);
      state.walletAdd = null;
      state.walletLogin = null;
      $("#walletStart").disabled = false;
    }
  }

  function openRowMenu(address, anchor) {
    $("#rowMenu")?.remove();
    const token = findToken(address);
    if (!token) return;
    const menu = document.createElement("div");
    menu.id = "rowMenu";
    menu.className = "row-menu";
    menu.innerHTML = `<button data-sell="${esc(address)}" data-pct="20" type="button">卖出 20%<span>20%</span></button><button data-sell="${esc(address)}" data-pct="50" type="button">卖出 50%<span>50%</span></button><button data-sell="${esc(address)}" data-pct="100" type="button">全部卖出<span>100%</span></button><button data-sell="${esc(address)}" data-pct="0" type="button">自定义比例…<span>⋯</span></button>`;
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(window.innerWidth - 228, r.right - 220)) + "px";
    menu.style.top = Math.min(window.innerHeight - 220, r.bottom + 7) + "px";
    menu.addEventListener("click", (e) => {
      e.stopPropagation();
      const b = e.target.closest("[data-sell]");
      if (b) {
        const pct = Number(b.dataset.pct) || 50;
        menu.remove();
        openSell(address, pct);
        if (!Number(b.dataset.pct)) setTimeout(() => $("#customPct")?.focus(), 120);
      }
    });
  }

  function tick() {
    state.countdown -= 1;
    if (state.countdown <= 0) {
      state.countdown = 3;
      if (!document.hidden) loadPortfolio();
    }
    if (state.view === "history" && !document.hidden) {
      state.historyTick += 1;
      if (state.historyTick >= 7) {
        state.historyTick = 0;
        loadHistory(state.historyWallet, true);
      }
    }
    const el = $("#balanceAge");
    if (el && state.portfolio) el.textContent = state.portfolio.balanceAge ?? "—";
  }

  initTheme();
  bind();
  renderBook();
  loadPortfolio();
  setInterval(tick, 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { state.countdown = 3; loadPortfolio(); } });
})();
