import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderNotifySettingsSection as renderNotifySettings } from '../js/inAppNotify.js';
import { renderKeepAliveSettingsSection as renderKeepAliveSettings } from '../js/audioKeepAlive.js';
import { renderPushSettingsSection as renderPushSettings } from '../js/pushNotify.js';
import {
  renderWakeSettingsSection as renderWakeSettings,
  DEFAULT_WAKE_SETTINGS,
} from '../js/wakeEngine.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(resolve(root, 'styles.css'), 'utf8');
// 去注释后再做规则扫描：注释里的文字（如 #input）不是选择器
const cssFlat = css.replace(/\/\*[\s\S]*?\*\//g, '');
const readJs = (f) => readFileSync(resolve(root, 'js', f), 'utf8');

function ruleBody(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = cssFlat.match(new RegExp(`^${esc}\\s*\\{([^}]*)\\}`, 'ms'));
  return m ? m[1] : null;
}

function fakeContainer() {
  return { innerHTML: '', querySelector: () => null };
}

/* ---------- 故障 1：长按菜单颜色与壁纸 tone 脱钩 ---------- */

test('菜单颜色写死固定值：浅菜单 + 深字，不用 var(--ink)/var(--ink-2)', () => {
  const item = ruleBody('.lp-menu-item');
  assert.ok(item, '应有 .lp-menu-item 规则');
  assert.match(item, /color:\s*#1d1d1f/);
  assert.doesNotMatch(item, /var\(--ink\)/);
  const icon = ruleBody('.lp-menu-icon');
  assert.ok(icon, '应有 .lp-menu-icon 规则');
  assert.match(icon, /color:\s*#3a3a3c/);
  assert.doesNotMatch(icon, /var\(--ink/);
  const more = ruleBody('.lp-reaction-more');
  assert.ok(more, '应有 .lp-reaction-more 规则');
  assert.match(more, /color:\s*#3a3a3c/);
  assert.doesNotMatch(more, /var\(--ink/);
  const menu = ruleBody('.lp-menu');
  assert.ok(menu, '应有 .lp-menu 规则');
  assert.match(menu, /background:\s*rgba\(255,\s*255,\s*255,\s*\.94\)/);
  assert.match(menu, /color:\s*#1d1d1f/);
  // 危险项红色保持
  const danger = ruleBody('.lp-menu-item.danger');
  assert.ok(danger, '应有 .lp-menu-item.danger 规则');
  assert.match(danger, /color:\s*#c0392b/);
});

test('没有任何 [data-tone] 规则命中菜单元素', () => {
  for (const line of cssFlat.split('\n')) {
    if (!line.includes('[data-tone')) continue;
    assert.doesNotMatch(line, /lp-menu|lp-reaction/, `这条 tone 规则命中了菜单：${line.slice(0, 120)}`);
  }
});

/* ---------- 故障 1b：原生文本选择抑制 ---------- */

test('气泡与菜单禁选，输入框不受影响', () => {
  // 找出所有含 user-select: none 的规则块，检查其选择器
  const blocks = [...cssFlat.matchAll(/([^{}]+)\{([^{}]*user-select:\s*none[^{}]*)\}/g)];
  assert.ok(blocks.length >= 1, '应有禁选规则');
  const selectors = blocks.map((b) => b[1]).join('\n');
  assert.match(selectors, /\.message-wrapper/);
  assert.match(selectors, /\.message-bubble/);
  assert.match(selectors, /\.lp-menu-root/);
  for (const b of blocks) {
    assert.doesNotMatch(b[1], /#input|textarea/, `禁选规则不许命中输入框：${b[1].trim().slice(0, 120)}`);
  }
  // 禁选块同时带 -webkit-touch-callout: none
  const withCallout = blocks.some((b) => /-webkit-touch-callout:\s*none/.test(b[2]));
  assert.equal(withCallout, true, '禁选规则应同时带 -webkit-touch-callout: none');
});

/* ---------- 故障 2：全应用开关重做 ---------- */

test('开关 CSS：行 52px flex space-between；轨道 51×31；开启态系统绿；钮 27px', () => {
  const row = ruleBody('.setting-row');
  assert.ok(row, '应有 .setting-row 规则');
  assert.match(row, /display:\s*flex/);
  assert.match(row, /justify-content:\s*space-between/);
  assert.match(row, /min-height:\s*52px/);
  const track = ruleBody('.switch-track');
  assert.ok(track, '应有 .switch-track 规则');
  assert.match(track, /width:\s*51px/);
  assert.match(track, /height:\s*31px/);
  const knob = ruleBody('.switch-track::after');
  assert.ok(knob, '应有 .switch-track::after 钮规则');
  assert.match(knob, /width:\s*27px/);
  assert.match(knob, /height:\s*27px/);
  const checked = cssFlat.match(/\.switch input\[type="checkbox"\]:checked \+ \.switch-track\s*\{([^}]*)\}/);
  assert.ok(checked, '应有开启态轨道规则');
  assert.match(checked[1], /background:\s*#34c759/);
  // 裸复选框的基础规则也是 51×31 + 系统绿（自动回复小开关等沿用它）
  const baseChecked = cssFlat.match(/input\[type="checkbox"\]:checked\s*\{([^}]*)\}/);
  assert.ok(baseChecked, '应有基础 checkbox 开启态规则');
  assert.match(baseChecked[1], /background:\s*#34c759/);
  // 旧 .check 开关样式已删掉（.check-row 是自检结果列表，不是开关，保留）
  assert.doesNotMatch(cssFlat, /\.check\s*\{/);
  assert.doesNotMatch(cssFlat, /#5d5d5d/);
});

test('全应用 JS 里不再有旧 <label class="check"> 开关标记', () => {
  for (const f of readdirSync(resolve(root, 'js')).filter((n) => n.endsWith('.js'))) {
    const src = readJs(f);
    assert.doesNotMatch(src, /class="check"|class='check'|el\('label', 'check'\)/, `${f} 里还有旧 .check 开关`);
  }
});

test('通知设置区渲染：5 项全是新行结构，id 与保存读取不变', () => {
  const html = renderNotifySettings(fakeContainer(), { settings: { hideSummary: true } });
  assert.equal((html.match(/setting-row/g) || []).length, 5);
  assert.equal((html.match(/switch-track/g) || []).length, 5);
  for (const id of ['notify-banner', 'notify-sound', 'notify-vibration', 'notify-hide-summary', 'notify-badge']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(html, /class="check"/);
  const src = readJs('inAppNotify.js');
  for (const id of ['notify-banner', 'notify-sound', 'notify-vibration', 'notify-hide-summary', 'notify-badge']) {
    assert.match(src, new RegExp(`q\\('${id}'\\)\\?\\.checked`), `保存逻辑仍应读 ${id}`);
  }
});

test('音频保活 / 系统推送设置区渲染：新行结构，保存读取不变', () => {
  const kHtml = renderKeepAliveSettings(fakeContainer(), { settings: { enabled: false } });
  assert.match(kHtml, /setting-row/);
  assert.match(kHtml, /keepalive-enabled/);
  assert.match(kHtml, /switch-track/);
  assert.doesNotMatch(kHtml, /class="check"/);
  assert.match(readJs('audioKeepAlive.js'), /q\('keepalive-enabled'\)\?\.checked/);
  const pHtml = renderPushSettings(fakeContainer(), {
    settings: { enabled: false, vapidPublicKey: '', pushServiceUrl: '' },
    env: { hasServiceWorker: true, hasPushManager: true, hasNotification: true, permission: 'default', configured: false, tested: false },
  });
  assert.match(pHtml, /setting-row/);
  assert.match(pHtml, /push-enabled/);
  assert.match(pHtml, /switch-track/);
  assert.doesNotMatch(pHtml, /class="check"/);
  assert.match(readJs('pushNotify.js'), /q\('push-enabled'\)\?\.checked/);
});

test('唤醒设置区渲染：总开关 + 免打扰 + 按角色列表全是新行结构', () => {
  const html = renderWakeSettings(fakeContainer(), {
    settings: { ...DEFAULT_WAKE_SETTINGS },
    chars: [{ id: 'c1', name: '阿澈' }],
  });
  assert.match(html, /wake-enabled/);
  assert.match(html, /wake-dnd-enabled/);
  assert.match(html, /wake-dnd-start/);
  assert.match(html, /wake-dnd-end/);
  assert.match(html, /data-wake-char="c1"/);
  assert.match(html, /阿澈/);
  assert.equal((html.match(/setting-row/g) || []).length, 3, '总开关 + 免打扰 + 1 个角色 = 3 行');
  assert.doesNotMatch(html, /class="check"/);
  const src = readJs('wakeEngine.js');
  assert.match(src, /querySelectorAll\?\.\('\[data-wake-char\]'\)/, '按角色保存仍按 data-wake-char 读');
  assert.match(src, /q\('wake-enabled'\)\?\.checked/);
  assert.match(src, /q\('wake-dnd-enabled'\)\?\.checked/);
});

test('app.js 开关：12 处全是新行结构，id 与事件绑定不变', () => {
  const src = readJs('app.js');
  assert.equal((src.match(/setting-row/g) || []).length, 12, 'cm-auto-reply + 角色表单 3 + 世界书 1 + 记忆 3 + API 3 + 导出 Key 1');
  assert.equal((src.match(/switch-track/g) || []).length, 12);
  for (const id of ['cm-auto-reply', 'f-bilingual', 'f-useGallery', 'f-sp-enabled', 'sum-auto', 'vec-enabled', 'assoc-enabled', 'api-temp-enabled', 'api-stream', 'api-time', 'export-keys']) {
    assert.match(src, new RegExp(`id="${id}"`), `应保留 ${id}`);
  }
  assert.match(src, /data-wb="/, '世界书绑定仍用 data-wb');
  assert.match(src, /getElementById\('export-keys'\)/, '导出 Key 读取不变');
  assert.match(src, /\$\('#cm-auto-reply'\)\?\.addEventListener\('change'/, '聊天设置自动回复 change 监听不变');
  assert.match(src, /querySelectorAll\('\[data-wb\]'\)/, '世界书 change 绑定不变');
});

test('theme.js 气泡玻璃开关：新行结构，change 仍接 update({ bubbleGlass })', () => {
  const src = readJs('theme.js');
  assert.match(src, /setting-row/);
  assert.match(src, /switch-track/);
  assert.match(src, /update\(\{ bubbleGlass: glassBox\.checked \}\)/);
});
