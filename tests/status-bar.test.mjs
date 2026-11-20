import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseStatusPattern, applyStatusTemplate, summarizeStatus, buildStatusDocument,
  STATUS_FRAME_CSS, STATUS_FRAME_SCRIPT, STATUS_HEIGHT_MSG,
} from '../js/statusBar.js';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/status-templates');
const fixture = (name) => readFileSync(resolve(fixturesDir, name), 'utf8');

test('parseStatusPattern：裸正则默认 gs；/pattern/flags 补 s；多行斜杠写法可解析', () => {
  assert.deepEqual(parseStatusPattern('\\[状态：(.*?)\\]'), { pattern: '\\[状态：(.*?)\\]', flags: 'gs' });
  assert.deepEqual(parseStatusPattern('/\\[状态：(.*?)\\]/'), { pattern: '\\[状态：(.*?)\\]', flags: 'gs' });
  assert.deepEqual(parseStatusPattern('/a(b)(c)/gi'), { pattern: 'a(b)(c)', flags: 'gis' });
  assert.deepEqual(parseStatusPattern('/a(b)/s'), { pattern: 'a(b)', flags: 's' });
  // 多行正则写在斜杠里：旧的无 s 外层匹配会解析失败，这里必须能拆出来
  const multi = parseStatusPattern('/状态：([\\s\\S]*?)\n结束/i');
  assert.equal(multi.pattern, '状态：([\\s\\S]*?)\n结束');
  assert.ok(multi.flags.includes('i') && multi.flags.includes('s'));
});

test('applyStatusTemplate：$1/$2/$0 替换、多行内容、无匹配、非法正则', () => {
  const panel = { regexPattern: '/\\[状态：(\\S+)\\s+(.*?)\\]/', replacePattern: '<div class="c">$1</div><p>$2</p>' };
  const out = applyStatusTemplate('[状态：开心 今天去散步]', panel);
  assert.equal(out.raw, '[状态：开心 今天去散步]');
  assert.equal(out.html, '<div class="c">开心</div><p>今天去散步</p>');

  // $0 取整段匹配
  assert.equal(
    applyStatusTemplate('[状态：好]', { regexPattern: '\\[状态：(.*?)\\]', replacePattern: '全文：$0，内容：$1' }).html,
    '全文：[状态：好]，内容：好',
  );
  // 不存在的捕获组保持原样
  assert.equal(
    applyStatusTemplate('[状态：好]', { regexPattern: '\\[状态：(.*?)\\]', replacePattern: '$1/$9' }).html,
    '好/$9',
  );
  // 多行内容：. 要跨行
  const multi = applyStatusTemplate('[状态：第一行\n第二行\n第三行]', { regexPattern: '/\\[状态：(.*?)\\]/', replacePattern: '<p>$1</p>' });
  assert.equal(multi.html, '<p>第一行\n第二行\n第三行</p>');
  // 无匹配 / 无模板
  assert.equal(applyStatusTemplate('今天天气不错', panel), null);
  assert.equal(applyStatusTemplate('[状态：好]', {}), null);
  assert.throws(() => applyStatusTemplate('[状态：好]', { regexPattern: '/(/', replacePattern: 'x' }), /Invalid regular expression/);
});

test('summarizeStatus：去标签/去 style 块/去协议外壳/截断', () => {
  assert.equal(summarizeStatus('[阿澈更新状态为：正在看电影...]'), '正在看电影...');
  assert.equal(summarizeStatus('[状态：心情好]'), '心情好');
  assert.equal(summarizeStatus('<div class="c">心情 <b>超好</b></div>'), '心情 超好');
  assert.equal(summarizeStatus('<style>.a{color:red}</style><div>心情好</div>'), '心情好');
  assert.equal(summarizeStatus('今天\n  天气\n不错'), '今天 天气 不错');
  assert.equal(summarizeStatus('这是一段很长很长很长很长很长很长的状态文本', 10), '这是一段很长很长很长…');
  assert.equal(summarizeStatus(''), '');
  assert.equal(summarizeStatus(null), '');
  // 纯 HTML/CSS 模板原文不能原样进 chip
  const cssy = summarizeStatus('<style>.card{width:600px;color:#fff}</style>');
  assert.ok(!cssy.includes('{') && !cssy.includes('600px'));
});

test('buildStatusDocument：片段包成完整文档，含视口/CSP/隔离样式/高度脚本', () => {
  const doc = buildStatusDocument('<div class="c">你好</div>');
  assert.ok(doc.startsWith('<!DOCTYPE html>'));
  assert.ok(doc.includes('name="viewport"'));
  assert.ok(doc.includes('Content-Security-Policy'));
  assert.ok(doc.includes('connect-src \'none\''));
  assert.ok(doc.includes(STATUS_FRAME_CSS.split('\n')[0]));
  assert.ok(doc.includes(STATUS_FRAME_SCRIPT.slice(0, 40)));
  assert.ok(doc.includes(STATUS_HEIGHT_MSG));
  assert.ok(doc.includes('<div class="c">你好</div>'));
  assert.ok(!doc.includes('allow-same-origin'), '文档内不应出现 allow-same-origin（那是 iframe 元素的属性）');
});

test('buildStatusDocument：完整文档保留 style/class/id/变量/伪元素/动画/媒体查询', () => {
  const doc = buildStatusDocument(fixture('full-doc.html'));
  for (const needle of [
    ':root { --mood: #ff8fa3', '.card::before', '.card::after', '@keyframes breathe',
    '@media (max-width: 400px)', 'class="status-body"', 'id="status-root"',
    'class="card" id="mood-card"', 'data:image/svg+xml;base64,',
    '<svg width="16"', '<details>', '<summary>更多碎碎念</summary>',
    '<select id="mood-score">', "document.querySelectorAll('[data-tab]')",
    'background-image: url("data:image/svg+xml;base64,',
  ]) assert.ok(doc.includes(needle), `应保留：${needle.slice(0, 40)}`);
  // <base> 会被去掉
  assert.ok(!/<base\b/i.test(doc));
  // 模板自带 body 属性保留
  assert.ok(doc.includes('<body class="status-body" id="status-root"'));
});

test('buildStatusDocument：片段保留内联样式/内联 SVG/data 图；固定宽度靠隔离样式夹住', () => {
  const frag = buildStatusDocument(fixture('fragment-card.html'));
  assert.ok(frag.includes('id="mini-status"'));
  assert.ok(frag.includes('style="background:#f3f7ff'));
  assert.ok(frag.includes('<svg width="18"'));
  assert.ok(frag.includes('data:image/svg+xml;base64,'));

  const wide = buildStatusDocument(fixture('fixed-width.html'));
  assert.ok(wide.includes('width:600px'), '模板原文保留（夹住靠隔离 CSS，不是删原文）');
  assert.ok(wide.includes('body>*{max-width:100%!important'));
});

test('buildStatusDocument：脚本交互与表单控件保留；marker 强制刷新', () => {
  const tabs = buildStatusDocument(fixture('script-tabs.html'));
  assert.ok(tabs.includes("document.getElementById('pane-y')"));
  assert.ok(tabs.includes('data-tab="y"'));
  const form = buildStatusDocument(fixture('form-controls.html'));
  assert.ok(form.includes('<input type="text"'));
  assert.ok(form.includes('<select'));
  assert.ok(form.includes('<input type="checkbox" checked>'));
  assert.ok(form.includes('<details'));
  const a = buildStatusDocument('<div>x</div>', { marker: 'regen 123' });
  const b = buildStatusDocument('<div>x</div>', { marker: 'regen 456' });
  assert.ok(a.includes('<!--regen 123-->') && b.includes('<!--regen 456-->'));
  assert.notEqual(a, b);

  // 错误上报脚本在 head 最前、模板脚本之前——模板解析期抛错时监听器已装好
  const errDoc = buildStatusDocument('<div>x</div><script>throw new Error("boom")</script>', {});
  const headScriptAt = errDoc.indexOf('verweile-status-error');
  const tplScriptAt = errDoc.indexOf('throw new Error');
  assert.ok(headScriptAt > 0 && headScriptAt < tplScriptAt, 'head error handler precedes template scripts');
  assert.ok(errDoc.includes(`<script>(function(){window.addEventListener('error'`), 'head script installs error listener');
});
