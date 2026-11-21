// statusBar.js — 自定义状态栏渲染（浏览器与 Node 测试共用，纯函数，不依赖 DOM）。
//
// 渲染链路：模型输出的原始状态文本 --(regexPattern 匹配)--> m --(replacePattern $n 替换)-->
// 状态 HTML --(buildStatusDocument 打包成完整文档)--> 沙箱 iframe 的 srcdoc。
// 模板 HTML 绝不直接 innerHTML 进主页面；它只活在 sandbox="allow-scripts"
// 且不带 allow-same-origin 的 iframe 里，因此拿不到主页面、聊天数据与 API Key。

export const STATUS_HEIGHT_MSG = 'verweile-status-height';
export const STATUS_ERROR_MSG = 'verweile-status-error';

/** 解析 regexPattern：支持不带斜杠的裸正则与 /pattern/flags 两种写法。
 *  未写 flags 时默认 'gs'（s 保证多行内容能被 . 匹配到）；写了 flags 也补上 s。 */
export function parseStatusPattern(patternText) {
  let pattern = String(patternText ?? '');
  let flags = 'gs';
  const mp = pattern.match(/^\/(.*?)\/([a-z]*)$/s);
  if (mp) {
    pattern = mp[1];
    flags = mp[2] || 'gs';
    if (!flags.includes('s')) flags += 's';
  }
  return { pattern, flags };
}

/** 用模板对原始状态文本做一次匹配 + $n 替换。无匹配返回 null；正则非法时抛错（调用方捕获）。
 *  opts.ctx 可带角色信息时，还会按原始 UWU 的 processTemplate 做变量替换：
 *  {{user_avatar}}/{{char_avatar}}/{{user_name}}/{{char_name}}/{{char_remark}}/{{user_remark}}
 *  以及 <user-avatar>/<char-avatar> 标签。 */
export function applyStatusTemplate(raw, panel, ctx) {
  if (!panel?.regexPattern) return null;
  const { pattern, flags } = parseStatusPattern(panel.regexPattern);
  const re = new RegExp(pattern, flags);
  const m = re.exec(String(raw ?? ''));
  if (!m) return null;
  let html = String(panel.replacePattern || '').replace(/\$(\d+)/g, (_, gi) => (m[Number(gi)] !== undefined ? m[Number(gi)] : `$${gi}`));
  if (ctx) html = substituteTemplateVars(html, ctx);
  return { raw: m[0], html };
}

/** 合并头像标签自带的属性：class 与标记类合并成一个 class 属性。
 *  直接拼接会产生两个 class 属性，浏览器只认第一个，模板自己的样式类就丢了
 *  （例如 <char-avatar class="thx-ava"> 的 thx-ava 会失效）。 */
function mergeAvatarAttrs(attrs, markerClass) {
  const a = String(attrs || '');
  const m = a.match(/class\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  if (!m) return ` class="${markerClass}"${a}`;
  const rest = a.replace(/class\s*=\s*(?:"[^"]*"|'[^']*')/i, '').trim();
  return ` class="${markerClass} ${(m[1] ?? m[2]).trim()}"${rest ? ` ${rest}` : ''}`;
}

/** 原始 UWU processTemplate 的变量替换：头像与名字进模板。
 *  缺名字时用原始 UWU 的默认值（User/Character）；缺头像时把 <…-avatar> 标签
 *  换成空 span（不留破图、不留字面量占位符）。 */
export function substituteTemplateVars(html, ctx = {}) {
  const userAvatar = ctx.userAvatar || '';
  const charAvatar = ctx.charAvatar || '';
  const userName = ctx.userName || 'User';
  const userRemark = ctx.userRemark || userName;
  const charName = ctx.charName || 'Character';
  const charRemark = ctx.charRemark || charName;
  let out = String(html ?? '');
  out = out.replace(/{{user_avatar}}/g, userAvatar);
  out = out.replace(/{{char_avatar}}/g, charAvatar);
  out = out.replace(/{{user_name}}/g, userName);
  out = out.replace(/{{char_name}}/g, charName);
  out = out.replace(/{{char_remark}}/g, charRemark);
  out = out.replace(/{{user_remark}}/g, userRemark);
  out = out.replace(/<user-avatar([^>]*)>\s*(?:<\/user-avatar>)?/gi, (_, attrs) =>
    (userAvatar ? `<img src="${userAvatar}"${mergeAvatarAttrs(attrs, 'uwu-user-avatar')}>` : `<span${mergeAvatarAttrs(attrs, 'uwu-avatar-empty')}></span>`));
  out = out.replace(/<char-avatar([^>]*)>\s*(?:<\/char-avatar>)?/gi, (_, attrs) =>
    (charAvatar ? `<img src="${charAvatar}"${mergeAvatarAttrs(attrs, 'uwu-char-avatar')}>` : `<span${mergeAvatarAttrs(attrs, 'uwu-avatar-empty')}></span>`));
  return out;
}

/** 弹窗里可翻看的状态条目：history（最新在前）优先；没有 history 时退回当前一条。 */
export function statusViewEntries(sp = {}) {
  const hist = Array.isArray(sp.history) ? sp.history.filter((h) => h && (h.html || h.raw)) : [];
  if (hist.length) return hist.slice(0, 20);
  if (sp.currentStatusHtml || sp.currentStatusRaw) {
    return [{ raw: sp.currentStatusRaw || '', html: sp.currentStatusHtml || '', timestamp: Date.now() }];
  }
  return [];
}

/** 把浏览下标夹在 [0, total-1] 内；没有条目时固定 0。 */
export function clampStatusIndex(i, total) {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(total - 1, Math.floor(i) || 0));
}

/** 从原始状态派生一句简短纯文本摘要，供顶栏简略状态条使用。
 *  去掉 style/script 整块、所有标签与协议外壳，折叠空白后按字符截断。 */
export function summarizeStatus(raw, maxLen = 24) {
  let s = String(raw ?? '');
  s = s.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<[^>]*>/g, '');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'");
  s = s.replace(/^\[.*?[:：]/, '').replace(/\]$/, '');
  s = s.replace(/\{[^{}]*\}/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  const n = Math.max(4, Math.floor(maxLen) || 24);
  const chars = [...s];
  if (chars.length > n) s = chars.slice(0, n).join('') + '…';
  return s;
}

// iframe 内部的隔离样式：只管住布局与横向溢出，不碰模板的配色与排版。
// 注入位置在模板 <head> 内容之后、同级选择器下，模板自己的样式仍可覆盖外观；
// 只有 max-width 一项用 !important，确保固定宽度在手机面板里一定被夹住。
export const STATUS_FRAME_CSS = [
  'html,body{margin:0;padding:0;background:transparent;width:100%;overflow-x:hidden;-webkit-text-size-adjust:100%}',
  'body>*{max-width:100%!important;box-sizing:border-box}',
  'img,svg,video,canvas{max-width:100%}',
  'pre,code{white-space:pre-wrap;word-break:break-word}',
  'table{max-width:100%}',
].join('\n');

// iframe 内部的高度上报脚本：用子元素 rect 实测内容高度（与视口无关，
// 内容收起后高度也能正确回落），变化时 postMessage 给父页面。
// ResizeObserver 监听全部后代 + MutationObserver 补新节点 + load 事件 + 兜底定时器，
// 覆盖图片加载、details 折叠、标签切换等场景。
// 注意：错误上报单独放在 head 里的首个脚本（见 STATUS_HEAD_SCRIPT），
// 因为模板脚本可能在 body 解析时就抛错——那时本脚本还没执行到。
export const STATUS_FRAME_SCRIPT = `(function(){
  var MSG='${STATUS_HEIGHT_MSG}';
  function contentHeight(){
    var body=document.body; if(!body) return 0;
    var top=body.getBoundingClientRect().top, max=0, i, r, mb, b;
    var kids=body.children;
    for(i=0;i<kids.length;i++){
      r=kids[i].getBoundingClientRect();
      mb=0; try{ mb=parseFloat(getComputedStyle(kids[i]).marginBottom)||0; }catch(e){}
      b=r.bottom-top+mb; if(b>max) max=b;
    }
    return Math.max(0, Math.ceil(max));
  }
  function post(){ try{ parent.postMessage({type:MSG,height:contentHeight()},'*'); }catch(e){} }
  var raf=false;
  function schedule(){ if(raf) return; raf=true; requestAnimationFrame(function(){ raf=false; post(); }); }
  try{
    var ro=('ResizeObserver' in window)?new ResizeObserver(schedule):null;
    var mo=('MutationObserver' in window)?new MutationObserver(function(){ observe(); schedule(); }):null;
    function observe(){
      if(!ro||!document.body) return;
      ro.disconnect();
      var els=document.body.querySelectorAll('*');
      for(var i=0;i<els.length&&i<800;i++){ try{ ro.observe(els[i]); }catch(e){} }
      try{ ro.observe(document.body); }catch(e){}
    }
    observe();
    if(mo&&document.body) mo.observe(document.body,{childList:true,subtree:true,attributes:true,characterData:true});
    window.addEventListener('load',function(){ observe(); schedule(); });
    document.addEventListener('load',schedule,true);
    setTimeout(schedule,100); setTimeout(schedule,600);
    schedule();
  }catch(e){ post(); }
})();`;

// head 首个脚本：只装错误上报。必须在模板任何脚本之前执行，
// 否则模板在解析期抛错时监听器还没装上，父页面收不到错误。
const STATUS_HEAD_SCRIPT = `(function(){window.addEventListener('error',function(ev){try{parent.postMessage({type:'${STATUS_ERROR_MSG}',message:String((ev&&ev.message)||'error')},'*');}catch(e){}});})();`;

// 纵深防御的 CSP：iframe 已是沙箱不透明源，这里再禁掉联网提交与嵌套框架；
// 图片/字体/媒体允许 data: 与 https:，脚本与样式允许内联与 https:，保证模板常用能力可用。
const STATUS_CSP = "default-src 'none'; script-src 'unsafe-inline' https: http:; style-src 'unsafe-inline' https: http:; img-src data: blob: https: http:; font-src data: https: http:; media-src data: blob: https: http:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** 只保留 body 标签上展示用的 class/id/内联样式（去掉危险写法），其余属性丢弃。 */
function pickBodyAttrs(attrStr) {
  const out = [];
  const cls = String(attrStr).match(/class\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  if (cls) out.push(`class="${(cls[1] ?? cls[2]).replace(/"/g, '&quot;')}"`);
  const id = String(attrStr).match(/id\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  if (id) out.push(`id="${(id[1] ?? id[2]).replace(/"/g, '&quot;')}"`);
  const style = String(attrStr).match(/style\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  if (style) {
    const raw = (style[1] ?? style[2]).replace(/url\s*\(|expression\s*\(|javascript\s*:|@import/gi, '');
    out.push(`style="${raw.replace(/"/g, '&quot;')}"`);
  }
  return out.length ? ' ' + out.join(' ') : '';
}

/** 把状态 HTML（完整文档或片段）打包成可放进沙箱 iframe srcdoc 的完整文档。
 *  完整文档：抽取 <head> 与 <body>（保留模板的 style/class/id/内联样式、
 *  CSS 变量、伪元素、动画、媒体查询、图片、内联 SVG、details/summary、
 *  表单控件与脚本），去掉 <base>，再套上隔离样式与高度上报脚本。
 *  片段：直接作为 body 内容。opts.marker 会以注释形式插在 body 开头，
 *  用于父页面强制刷新同一份 srcdoc。opts.frameId 会带进高度上报消息，
 *  供父页面把高度路由到对应的 iframe（聊天页 HTML 卡片用；状态栏弹窗不传，
 *  沿用原来的无 id 上报格式）。 */
export function buildStatusDocument(html, opts = {}) {
  const input = String(html ?? '');
  const isFullDoc = /<!doctype html|<html[\s>]/i.test(input);
  let headInner = '';
  let bodyInner = input;
  let bodyAttrs = '';
  if (isFullDoc) {
    const headMatch = input.match(/<head[^>]*>([\s\S]*?)<\/head\s*>/i);
    if (headMatch) headInner = headMatch[1];
    const bodyMatch = input.match(/<body([^>]*)>([\s\S]*?)<\/body\s*>/i);
    if (bodyMatch) {
      bodyAttrs = pickBodyAttrs(bodyMatch[1]);
      bodyInner = bodyMatch[2];
    } else {
      bodyInner = input
        .replace(/<!doctype html[^>]*>/i, '')
        .replace(/<\/?html[^>]*>/gi, '')
        .replace(/<head[^>]*>[\s\S]*?<\/head\s*>/i, '');
    }
  }
  headInner = headInner.replace(/<base\b[^>]*>/gi, '');
  const marker = opts.marker ? '<' + '!--' + String(opts.marker).replace(/--/g, '') + '-->' : '';
  const heightScript = opts.frameId
    ? STATUS_FRAME_SCRIPT.replace(
      `parent.postMessage({type:MSG,height:contentHeight()},'*')`,
      `parent.postMessage({type:MSG,height:contentHeight(),frame:${JSON.stringify(String(opts.frameId))}},'*')`,
    )
    : STATUS_FRAME_SCRIPT;
  // 注意：下面拼接的闭合 script 标签必须写成反斜杠转义形式，注释标记也要拆开写——
  // dist 是把 bundle 内联进 script 元素的单文件，字面量会提前闭合外层 script，
  // 导致整包截断（SyntaxError: Unexpected end of input）。运行时拼出的仍是正常字符串。
  return '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
    + `<meta http-equiv="Content-Security-Policy" content="${STATUS_CSP}">`
    + `<script>${STATUS_HEAD_SCRIPT}<\/script>`
    + headInner
    + `<style>\n${STATUS_FRAME_CSS}\n</style>`
    + `</head><body${bodyAttrs}>${marker}${bodyInner}<script>${heightScript}<\/script></body></html>`;
}
