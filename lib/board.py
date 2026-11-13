"""sourceboard board — 把搜索或抓取结果做成一张本机网页看板。

一页三层：
  1. 这次搜了什么：每个平台搜到几条、走的哪条通道、花了多少、哪里没搜到（失败的排在最前）。
  2. 结论：你的 Agent 读完资料后写的结论（Markdown 文件，用 --conclusion 加进来）。
  3. 资料卡片：封面、标题、作者、数据、原链接；能排序、筛选；每张卡可以标“留 / 不要”、写备注，
     底部“生成回复”把选择汇总成文字，贴回给 Agent 接着干。

页面是单个 HTML 文件，样式和脚本都在文件里。封面用平台的网络地址，过几天可能失效。
所有抓回来的文字都当纯文本显示，不会被当成网页代码执行。
"""
import argparse
import html
import json
import re
import subprocess
import sys
from pathlib import Path

import sbconfig

PLATFORMS = {'douyin': '抖音', 'xiaohongshu': '小红书', 'bilibili': 'B站', 'wechat': '公众号', 'wechat_channels': '视频号', 'weibo': '微博', 'zhihu': '知乎', 'x': 'X',
             'youtube': 'YouTube', 'tiktok': 'TikTok', 'instagram': 'Instagram', 'threads': 'Threads', 'linkedin': 'LinkedIn', 'reddit': 'Reddit', 'bluesky': 'Bluesky',
             'telegram': 'Telegram', 'medium': 'Medium', 'substack': 'Substack', 'pinterest': 'Pinterest', 'facebook': 'Facebook', 'generic': '网页'}
LABELS = {'views': '播放', 'reads': '阅读', 'impressions': '曝光', 'likes': '点赞', 'comments': '评论', 'collects': '收藏', 'shares': '分享', 'followers': '粉丝',
          'following': '关注', 'posts': '作品', 'votes': '赞同', 'replies': '回复', 'reposts': '转发', 'quotes': '引用', 'score': '得分', 'upvote_ratio': '好评率',
          'danmaku': '弹幕', 'coins': '投币', 'favorites': '收藏', 'saves': '收藏', 'downloads': '下载', 'bookmarks': '书签'}
CAPS = {'content': '正文', 'stats': '数据', 'comments': '评论', 'media': '图片视频', 'subtitles': '字幕'}
STATUS = {'success': '搜到了', 'true_zero': '没有结果', 'index_partial': '只拿到一部分', 'not_attempted': '没有去取', 'connector_failed': '接口出错',
          'auth_failed': '钥匙或余额有问题', 'rate_limited': '被限流'}
CAP_STATUS = {'success': '有', 'index_partial': '部分', 'true_zero': '为零', 'not_attempted': '没取', 'connector_failed': '失败', 'auth_failed': '要钥匙', 'rate_limited': '被限流'}

esc = lambda s: html.escape(str(s if s is not None else ''), quote=True)


def markdown(text):
    """够用的 Markdown：标题、列表、粗体、链接、段落。先整体转义，再加标签。"""
    def inline(s):
        s = esc(s)
        s = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', s)
        s = re.sub(r'`([^`]+)`', r'<code>\1</code>', s)
        return re.sub(r'\[([^\]]+)\]\((https?://[^\s)]+)\)', r'<a target="_blank" rel="noopener noreferrer" href="\2">\1</a>', s)
    out, in_list = [], None
    def close():
        nonlocal in_list
        if in_list:
            out.append(f'</{in_list}>')
            in_list = None
    for line in str(text or '').splitlines():
        s = line.strip()
        if not s:
            close()
            continue
        m = re.match(r'(#{1,4})\s+(.*)', s)
        b = re.match(r'[-*]\s+(.*)', s)
        n = re.match(r'\d+[.、)]\s*(.*)', s)
        if m:
            close()
            out.append(f'<h3>{inline(m.group(2))}</h3>')
        elif b or n:
            kind = 'ul' if b else 'ol'
            if in_list != kind:
                close()
                out.append(f'<{kind}>')
                in_list = kind
            out.append(f'<li>{inline((b or n).group(1))}</li>')
        else:
            close()
            out.append(f'<p>{inline(s)}</p>')
    close()
    return ''.join(out)


def source_rows(sources):
    bad = [s for s in sources if s.get('status') not in ('success', 'true_zero', 'index_partial')]
    good = [s for s in sources if s not in bad]
    rows = []
    for s in bad + good:
        cls = 'bad' if s in bad else 'zero' if s.get('status') == 'true_zero' else 'ok'
        cost = '缓存，没再扣费' if s.get('cache_hit') else f'${float(s.get("cost_usd") or 0):.3f}'
        rows.append(f'<tr class="{cls}"><td>{esc(s.get("name") or PLATFORMS.get(s.get("platform"), s.get("platform")))}</td>'
                    f'<td>{esc(STATUS.get(s.get("status"), s.get("status")))}{"：" + str(s.get("count")) + " 条" if s.get("count") else ""}</td>'
                    f'<td>{esc(s.get("channel"))}</td><td>{esc(cost)}</td><td>{esc(s.get("note"))}</td></tr>')
    return ''.join(rows), bad


PAGE = '''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>
:root{color-scheme:dark;--bg:#101317;--panel:#1a2029;--panel2:#222a35;--line:#323d4b;--tx:#e6e9ee;--mut:#9eabb9;--acc:#7cc0ff;--ok:#4cc38a;--warn:#f0b72f;--bad:#ff8177}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:16px/1.65 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;padding-bottom:86px}
.wrap{max-width:1500px;margin:0 auto;padding:22px 20px}h1{font-size:26px;margin:4px 0}h2{font-size:19px;margin:26px 0 10px}h3{font-size:16.5px;margin:12px 0 6px}
.mut{color:var(--mut)}a{color:var(--acc);overflow-wrap:anywhere}p{margin:8px 0;overflow-wrap:anywhere}
.alert{background:#2a1a17;border:1px solid #7a3b33;border-radius:10px;padding:10px 16px;margin:14px 0}
table{border-collapse:collapse;width:100%;font-size:14.5px}th,td{border:1px solid var(--line);padding:6px 9px;text-align:left;vertical-align:top}th{background:var(--panel2)}
tr.bad td:nth-child(2){color:var(--bad);font-weight:600}tr.zero td:nth-child(2){color:var(--warn)}tr.ok td:nth-child(2){color:var(--ok)}
.box{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 18px}
.tools{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:10px 0 16px}
select,input[type=search],textarea{font:inherit;background:#161c24;color:var(--tx);border:1px solid #4a5868;border-radius:6px;padding:6px 8px}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:18px;align-items:start}
article{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}article.keep{border-color:var(--ok)}article.drop{opacity:.45}
article>img{width:100%;height:190px;object-fit:cover;background:#0a0d11;display:block}.body{padding:14px 16px}
.plat{color:var(--mut);font-size:13px}.ttl{font-size:17.5px;line-height:1.45;margin:6px 0;font-weight:600}.metrics{color:#cbdcee;font-size:14px}
.ex{color:#bcc6d1;font-size:14.5px;white-space:pre-line;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}
.caps{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.caps span{font-size:12px;background:#2b3644;padding:1px 7px;border-radius:4px;color:#c5d0dc}
.pick{display:flex;gap:8px;margin-top:10px;align-items:center}.pick button{flex:none}.pick input{flex:1;min-width:0;font:inherit;font-size:14px;background:#12171d;color:var(--tx);border:1px solid var(--line);border-radius:6px;padding:5px 8px}
button{font:inherit;font-size:14.5px;background:var(--panel2);color:var(--tx);border:1px solid #47566a;border-radius:7px;padding:5px 12px;cursor:pointer}
button.on-keep{background:#1d5c3d;border-color:var(--ok)}button.on-drop{background:#5a2a26;border-color:var(--bad)}button.pri{background:#1f6feb;border-color:#1f6feb}
details{margin-top:8px}summary{cursor:pointer;color:var(--mut);font-size:14px}ol{padding-left:20px;max-height:320px;overflow:auto;font-size:14.5px}li{margin:8px 0}small{display:block;color:var(--mut)}
.bar{position:fixed;left:0;right:0;bottom:0;background:#0b0e12;border-top:1px solid var(--line);padding:10px 16px;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap}
#outbox{display:none}#reply{width:100%;min-height:200px}
@media(max-width:480px){main{grid-template-columns:1fr}.wrap{padding:14px 12px}}
</style></head><body><div class="wrap">
<h1>__TITLE__</h1>
<p class="mut">__SUB__</p>
__ALERT__
<h2>一、这次__WHAT__了什么</h2>
__SOURCES__
<h2>二、结论</h2>
<div class="box">__CONCLUSION__</div>
<h2>三、资料（共 <span id="total"></span> 条<span id="shown"></span>）</h2>
<p class="mut">没拿到的数据留空，不填 0。封面用的是平台的网络地址，过几天可能失效。想让 Agent 接着处理某几条：点“留”或“不要”，可以写备注，最后点底部“生成回复”，把文字贴回对话。</p>
<div class="tools"><label>平台 <select id="f-plat"><option value="">全部</option></select></label>
<label>排序 <select id="f-sort"><option value="">原顺序</option></select></label>
<select id="f-order"><option value="desc">从高到低</option><option value="asc">从低到高</option></select>
<input type="search" id="f-q" placeholder="在标题、作者、正文里找">
<label><input type="checkbox" id="f-keep"> 只看标了“留”的</label></div>
<main id="cards"></main>
<div id="outbox"><h2>回复内容（可以改，改完点复制）</h2><textarea id="reply"></textarea><p><button class="pri" id="copy">复制</button> <span id="cmsg" class="mut"></span></p></div>
</div>
<div class="bar"><span id="prog"></span><button class="pri" id="gen">生成回复</button><button id="clr">清空选择</button></div>
<script id="data" type="application/json">__DATA__</script>
<script>
(function(){
var D=JSON.parse(document.getElementById('data').textContent),items=D.items||[],P=D.platform_names,L=D.stat_labels,CS=D.cap_status,CN=D.cap_names;
var KEY='sourceboard:'+D.page_path,state={};
try{state=JSON.parse(localStorage.getItem(KEY)||'{}')||{}}catch(e){state={}}
function save(){try{localStorage.setItem(KEY,JSON.stringify(state))}catch(e){}}
function el(tag,cls,text){var n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined&&text!==null)n.textContent=text;return n}
function fmt(v){var n=Number(v);if(v===null||v===undefined||v===''||!isFinite(n))return String(v);var a=Math.abs(n);if(a>=1e8)return (n/1e8).toFixed(2)+'亿';if(a>=1e4)return (n/1e4).toFixed(1)+'万';return n%1?String(Math.round(n*100)/100):String(n)}
function when(s){s=String(s||'');if(s.length>=16&&s.charAt(10)==='T'){var d=new Date(s);if(!isNaN(d)){var z=function(n){return (n<10?'0':'')+n};return d.getFullYear()+'-'+z(d.getMonth()+1)+'-'+z(d.getDate())+' '+z(d.getHours())+':'+z(d.getMinutes())}return s.slice(0,16).replace('T',' ')}return s||'日期未返回'}
function link(url,label){if(/^https?:\\/\\//.test(url||'')){var a=el('a',null,label);a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a}return el('span',null,label)}
function metrics(st){var parts=[];Object.keys(st||{}).forEach(function(k){if(st[k]!==null&&st[k]!==undefined)parts.push((L[k]||k)+' '+fmt(st[k]))});return parts.join(' · ')}
var area=document.getElementById('cards'),plats={},sorts={};
items.forEach(function(it,i){
  it._i=i;plats[it.platform]=1;Object.keys(it.stats||{}).forEach(function(k){sorts[k]=1});
  var c=el('article');c.dataset.id=it.id;it._el=c;
  if(/^https?:\\/\\//.test(it.cover||'')||/^file:/.test(it.cover||'')){var im=el('img');im.loading='lazy';im.referrerPolicy='no-referrer';im.alt='';im.src=it.cover;im.onerror=function(){this.remove()};c.appendChild(im)}
  var b=el('div','body');c.appendChild(b);
  b.appendChild(el('div','plat','['+it.id+'] '+(P[it.platform]||it.platform)+' · '+when(it.published_at)));
  b.appendChild(el('div','ttl',it.title||'标题未返回'));
  if(it.author)b.appendChild(el('div','mut',it.author));
  var m=metrics(it.stats);if(m)b.appendChild(el('div','metrics',m));
  if(it.text&&String(it.text).length>String(it.title||'').length+8)b.appendChild(el('p','ex',String(it.text).slice(0,500)));
  var ln=el('p');ln.appendChild(link(it.url,'原链接'));if(it.local){ln.appendChild(document.createTextNode('　'));var la=el('a',null,'本地全文');la.href=it.local;ln.appendChild(la)}b.appendChild(ln);
  if(it.caps){var cp=el('div','caps');Object.keys(it.caps).forEach(function(k){cp.appendChild(el('span',null,(CN[k]||k)+'：'+(CS[it.caps[k]]||it.caps[k])))});b.appendChild(cp)}
  if(it.profile){var pd=el('details');pd.open=true;pd.appendChild(el('summary',null,'账号资料'));pd.appendChild(el('p',null,it.profile.bio||''));var pm=metrics(it.profile.stats);if(pm)pd.appendChild(el('p','metrics',pm));b.appendChild(pd)}
  if(it.sub_items&&it.sub_items.length){var sd=el('details');sd.appendChild(el('summary',null,'最近作品（'+it.sub_items.length+'）'));var ol=el('ol');it.sub_items.forEach(function(s){var li=el('li');li.appendChild(link(s.url,s.title||s.id||'作品'));li.appendChild(el('small',null,when(s.published_at)+' · '+metrics(s.stats)));ol.appendChild(li)});sd.appendChild(ol);b.appendChild(sd)}
  if(it.comments&&it.comments.length){var cd=el('details');cd.appendChild(el('summary',null,'评论摘录（'+it.comments.length+'）'));var cl=el('ol');it.comments.forEach(function(s){var li=el('li',null,s.text||'');li.appendChild(el('small',null,(s.author||'')+(s.likes!==null&&s.likes!==undefined?' · 赞 '+fmt(s.likes):'')));cl.appendChild(li)});cd.appendChild(cl);b.appendChild(cd)}
  var pk=el('div','pick'),k=el('button',null,'留'),d=el('button',null,'不要'),n=el('input');n.placeholder='备注（可不填）';
  k.onclick=function(){set(it,'keep')};d.onclick=function(){set(it,'drop')};n.oninput=function(){(state[it.id]=state[it.id]||{}).n=n.value;save()};
  it._k=k;it._d=d;it._n=n;pk.appendChild(k);pk.appendChild(d);pk.appendChild(n);b.appendChild(pk);
  area.appendChild(c);
});
function set(it,v){var s=state[it.id]=state[it.id]||{};s.v=s.v===v?'':v;save();paint()}
function paint(){var keep=0,drop=0;items.forEach(function(it){var s=state[it.id]||{};it._el.classList.toggle('keep',s.v==='keep');it._el.classList.toggle('drop',s.v==='drop');it._k.className=s.v==='keep'?'on-keep':'';it._d.className=s.v==='drop'?'on-drop':'';if(it._n.value!==(s.n||'')&&document.activeElement!==it._n)it._n.value=s.n||'';if(s.v==='keep')keep++;if(s.v==='drop')drop++});
  document.getElementById('prog').textContent='留 '+keep+' · 不要 '+drop+' · 共 '+items.length+' 条';filter()}
function filter(){var p=fp.value,key=fs.value,asc=fo.value==='asc',q=fq.value.trim().toLowerCase(),only=fk.checked,shown=0;
  var val=function(it){var v=(it.stats||{})[key];return v===null||v===undefined||!isFinite(Number(v))?null:Number(v)};
  items.slice().sort(function(a,b){if(!key)return a._i-b._i;var x=val(a),y=val(b);return x===null?(y===null?a._i-b._i:1):y===null?-1:(asc?x-y:y-x)}).forEach(function(it){
    var hide=(p&&it.platform!==p)||(only&&(state[it.id]||{}).v!=='keep')||(q&&((it.title||'')+' '+(it.author||'')+' '+(it.text||'')).toLowerCase().indexOf(q)<0);
    it._el.hidden=!!hide;if(!hide)shown++;area.appendChild(it._el)});
  document.getElementById('shown').textContent=shown===items.length?'':'，当前显示 '+shown+' 条'}
var fp=document.getElementById('f-plat'),fs=document.getElementById('f-sort'),fo=document.getElementById('f-order'),fq=document.getElementById('f-q'),fk=document.getElementById('f-keep');
Object.keys(plats).forEach(function(p){var o=el('option',null,P[p]||p);o.value=p;fp.appendChild(o)});
Object.keys(sorts).forEach(function(k){var o=el('option',null,L[k]||k);o.value=k;fs.appendChild(o)});
[fp,fs,fo,fk].forEach(function(x){x.onchange=filter});fq.oninput=filter;
document.getElementById('total').textContent=items.length;paint();
document.getElementById('gen').onclick=function(){var lines=[D.title+'｜'+D.page_path],keep=[],drop=[],rest=0;
  items.forEach(function(it){var s=state[it.id]||{},note=(s.n||'').trim();var line='['+it.id+'] '+(P[it.platform]||it.platform)+'｜'+(it.title||'').slice(0,40)+'｜'+(it.url||'')+(note?'（'+note+'）':'');
    if(s.v==='keep')keep.push('留 '+line);else if(s.v==='drop')drop.push('['+it.id+']'+(note?'（'+note+'）':''));else if(note)keep.push('未选 '+line);else rest++});
  lines.push('留下 '+keep.filter(function(x){return x.indexOf('留 ')===0}).length+' 条：');lines=lines.concat(keep.length?keep:['（没有标“留”的）']);
  lines.push('不要：'+(drop.length?drop.join('、'):'（没有）'));lines.push('其余 '+rest+' 条未选。');
  var box=document.getElementById('outbox');box.style.display='block';var t=document.getElementById('reply');t.value=lines.join('\\n');box.scrollIntoView({behavior:'smooth'})};
document.getElementById('copy').onclick=function(){var t=document.getElementById('reply'),m=document.getElementById('cmsg');
  function fb(){t.focus();t.select();try{document.execCommand('copy');m.textContent='已复制'}catch(e){m.textContent='复制失败，请手动全选复制'}}
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t.value).then(function(){m.textContent='已复制'},fb)}else fb()};
document.getElementById('clr').onclick=function(){if(!confirm('清空这页所有“留 / 不要”和备注？'))return;state={};try{localStorage.removeItem(KEY)}catch(e){}paint()};
})();
</script></body></html>'''


def local_time(value):
    import datetime as dt
    try:
        return dt.datetime.fromisoformat(str(value)).astimezone().strftime('%Y-%m-%d %H:%M')
    except (TypeError, ValueError):
        return str(value or '')[:16].replace('T', ' ')


def grab_summary(items):
    """直接抓链接的看板没有“搜了哪些平台”，第一层改成：抓了几条、哪几条有东西没拿到、为什么。"""
    failed = ('connector_failed', 'auth_failed', 'rate_limited')
    gaps = [(it, [(k, v) for k, v in (it.get('caps') or {}).items() if v in failed]) for it in items]
    gaps = [(it, g) for it, g in gaps if g]
    if not gaps:
        return f'<p class="mut">直接抓取了 {len(items)} 个链接，没有出错的项（没去取的项见各卡片）。</p>'
    lines = ''.join('<li>[' + esc(it.get('id')) + '] ' + esc(PLATFORMS.get(it.get('platform'), it.get('platform'))) + ' · '
                    + esc((it.get('title') or it.get('url') or '')[:40]) + '：'
                    + '；'.join(esc(CAPS.get(k, k) + '：' + STATUS.get(v, v)) for k, v in g) + '</li>' for it, g in gaps)
    return (f'<p>直接抓取了 {len(items)} 个链接，其中 {len(gaps)} 条有部分内容没拿到。接口出错或被限流，不等于原帖没有：</p>'
            f'<ul>{lines}</ul>')


def render(data, out, open_browser=False):
    """data 见 README「看板数据格式」。写出单个 HTML 文件，返回它的路径。"""
    out = Path(out).expanduser().resolve()
    sources = data.get('sources') or []
    rows, bad = source_rows(sources)
    for i, it in enumerate(data.get('items') or [], 1):
        it.setdefault('id', f'{i:02d}')
    if sources:
        table = '<table><tr><th>平台</th><th>结果</th><th>通道</th><th>花费（估算）</th><th>说明</th></tr>' + rows + '</table>'
    else:
        table = grab_summary(data.get('items') or [])
    alert = ''
    if bad:
        alert = '<div class="alert"><b>有 ' + str(len(bad)) + ' 个渠道没搜到，不等于网上没有：</b>' + '；'.join(
            esc(s.get('name') or s.get('platform')) + '（' + esc(STATUS.get(s.get('status'), s.get('status'))) + '）' for s in bad) + '。原因见下表。</div>'
    conclusion = markdown(data.get('conclusion_md')) or '<p class="mut">还没有结论。让你的 Agent 读完下面的资料后写一份结论，再运行：<code>sourceboard board ' + esc(out.parent) + ' --conclusion 结论.md</code></p>'
    sub = ' · '.join(x for x in (('搜索词：' + data['query']) if data.get('query') else '', '生成时间：' + local_time(data.get('created_at')),
                                 f'估算花费：${float(data.get("estimated_cost_usd") or 0):.3f}（按单价表估算，不是账单）') if x)
    payload = dict(data, page_path=str(out), platform_names=PLATFORMS, stat_labels=LABELS, cap_status=CAP_STATUS, cap_names=CAPS)
    blob = json.dumps(payload, ensure_ascii=False, default=str).replace('<', '\\u003c')  # 数据里的尖括号一律转义，不可能提前结束脚本块
    page = (PAGE.replace('__TITLE__', esc(data.get('title') or 'SourceBoard 看板')).replace('__SUB__', esc(sub)).replace('__ALERT__', alert)
            .replace('__WHAT__', '搜' if sources else '抓').replace('__SOURCES__', table).replace('__CONCLUSION__', conclusion).replace('__DATA__', blob))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page, encoding='utf-8')
    if open_browser:
        open_page(out)
    return out


def open_page(path):
    cmd = ['open', str(path)] if sys.platform == 'darwin' else ['xdg-open', str(path)]
    try:
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        print('没能自动打开浏览器，请手动打开：' + str(path), file=sys.stderr)


def package_item(meta_path, root):
    """把 grab 抓回的一个内容包（meta.json）变成看板上的一张卡。"""
    d = json.loads(Path(meta_path).read_text(encoding='utf-8'))
    folder = Path(meta_path).parent
    local_image = next((Path(f).as_uri() for f in d.get('media_files', []) if Path(f).suffix.lower() in ('.jpg', '.jpeg', '.png', '.webp', '.gif')), '')
    cover = local_image or next((u for u in d.get('images', []) if isinstance(u, str) and u.startswith(('https://', 'http://'))), '')
    try:
        local = (folder / 'content.md').resolve().relative_to(Path(root).resolve()).as_posix()
    except ValueError:
        local = (folder / 'content.md').resolve().as_uri()
    comments = []
    for c in (d.get('comments') or [])[:8]:
        if isinstance(c, dict):
            comments.append({'text': str(c.get('text') or c.get('content') or '')[:300], 'author': c.get('author') or c.get('user') or '', 'likes': c.get('likes')})
    card = {'platform': d.get('platform', 'generic'), 'title': d.get('title') or '', 'author': d.get('author') or '', 'url': d.get('canonical_url') or '',
            'published_at': d.get('published_at') or '', 'cover': cover, 'text': (d.get('text') or '')[:600], 'stats': d.get('stats') or {}, 'local': local,
            'caps': {k: v.get('status') for k, v in (d.get('capabilities') or {}).items()}, 'comments': comments}
    profile = d.get('profile')
    if profile:
        card['title'] = card['title'] or profile.get('nickname') or profile.get('handle') or '账号主页'
        card['profile'] = {'bio': profile.get('bio') or '', 'stats': {k: profile.get(k) for k in ('followers', 'following', 'likes', 'posts') if profile.get(k) is not None}}
        card['sub_items'] = [{'title': i.get('title') or '', 'id': i.get('id'), 'url': i.get('url') or '', 'published_at': i.get('published_at') or '', 'stats': i.get('stats') or {}}
                             for i in d.get('items') or []]
    return card, float(d.get('estimated_cost_usd') or 0)


def from_packages(root, title='', open_browser=False, conclusion=''):
    """把一个目录下所有抓回的内容包汇成一张看板，写到 目录/board.html。"""
    root = Path(root).expanduser().resolve()
    metas = sorted(p for p in root.rglob('meta.json') if '.scratch' not in p.parts)
    items, cost = [], 0.0
    for p in metas:
        try:
            card, usd = package_item(p, root)
        except (ValueError, OSError, KeyError):
            continue
        items.append(card)
        cost += usd
    if not items:
        raise ValueError(f'{root} 里没有找到抓回的内容包（meta.json）')
    import core
    data = {'schema': 1, 'kind': 'grab', 'title': title or (items[0]['title'][:40] if len(items) == 1 else f'抓取结果（{len(items)} 条）'),
            'created_at': core.now(), 'sources': [], 'items': items, 'estimated_cost_usd': round(cost, 6), 'conclusion_md': conclusion}
    (root / 'board.json').write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    return render(data, root / 'board.html', open_browser)


def main(argv=None):
    ap = argparse.ArgumentParser(prog='sourceboard board', description='把搜索或抓取结果做成网页看板；也用来给已有看板补上结论。')
    ap.add_argument('target', help='搜索或抓取的结果目录，或一个符合「看板数据格式」的 JSON 文件')
    ap.add_argument('--conclusion', help='结论文件（Markdown）。Agent 读完资料后写，放进看板第二层')
    ap.add_argument('--title', default='')
    ap.add_argument('--out', default='', help='看板写到哪，默认是结果目录下的 board.html')
    ap.add_argument('--open', action='store_true', help='生成后用浏览器打开')
    a = ap.parse_args(argv)
    target = Path(a.target).expanduser().resolve()
    conclusion = Path(a.conclusion).expanduser().read_text(encoding='utf-8') if a.conclusion else ''
    try:
        source = target if target.is_file() else next((target / n for n in ('results.json', 'board.json') if (target / n).is_file()), None)
        if source is None:
            page = from_packages(target, a.title, a.open, conclusion)
        else:
            data = json.loads(source.read_text(encoding='utf-8'))
            if conclusion:
                data['conclusion_md'] = conclusion
            if a.title:
                data['title'] = a.title
            source.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
            page = render(data, Path(a.out) if a.out else source.parent / 'board.html', a.open)
    except (ValueError, OSError) as e:
        print('sourceboard board: ' + str(e), file=sys.stderr)
        return 2
    print(page)
    return 0


if __name__ == '__main__':
    sys.exit(main())
