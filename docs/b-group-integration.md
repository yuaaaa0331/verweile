# B 组集成文档：站内通知 + 音频保活 + 自定义图标 + 系统推送 + 主动唤醒

> B 组工作目录 `~/workspace/verweile`，完成时间 2026-11-21。A 组正在并行改
> `js/app.js` / `index.html` / `styles.css` / `scripts/build-preview.mjs`，
> 本组未碰这 4 个文件；接线全部按本文档的 patch spec 由总协调员落地。
> dist 未重建（由总协调员最后统一做）。

## 1. 改了什么（按文件列）

| 文件 | 改动 |
|---|---|
| `js/storage.js` | `DB_VERSION` 3→4；`MemoryBackend` 增加 `wakeScenes / wakeAlarms / wakeReceipts` 三张表；新增 `ensureWakeStores(db)`（与 `wakeEngine.js` 同名函数同一建表逻辑，独立实现、不 import，避免循环依赖）；`IDBBackend.open` 的 `onupgradeneeded` 里调用它；`MemoryBackend.put` / `IDBBackend.put` 的键回退增加 `wakeId`（回执表以 `wakeId` 为 keyPath）；新增 `B_GROUP_SETTINGS_KEYS`（5 个 settings 键）与 `NOTIFY_UNREAD_SETTINGS_KEY`（`'notifyUnread'`）。只加表、不重建、不清空旧表。 |
| `js/inAppNotify.js` | 新增 `InAppNotifier.notifyInApp({ charId, avatar, name, summary, messageId }, currentCharId)` 接线入口；新增未读持久化 `saveUnread(backend, notifier)` / `loadUnread(backend, notifier)`（settings 表 key `'notifyUnread'`，值 `{ charId: count }`）；新增 `renderNotifySettingsSection(container, deps)`（横幅/提示音/振动/隐藏摘要/未读标记）。原有纯函数与类行为不变。 |
| `js/audioKeepAlive.js` | 新增 `resume(opts)`（中断/暂停后用户手动恢复，与 `start` 同一路，不自动重建）；新增 `renderKeepAliveSettingsSection(container, deps)`（开关、状态行、心跳次数、启动/手动恢复/停止/保存，含 `AUDIO_KEEPALIVE_HONESTY` 原文）。 |
| `js/pushNotify.js` | 新增 `detectIOSPush(env)`（iOS 16.4+ 且主屏幕 Web App 才支持；Safari 直开 / 16.4 以下 / 权限拒绝各给原因）；新增 `renderPushSettingsSection(container, deps)`（能力四行、VAPID 公钥、推送服务地址、申请权限、订阅；未配置/未实测时只写“未配置/未验证”，不写“可用”）。 |
| `js/customIcon.js` | 新增 `readPngSize(bytes)`（解析 PNG IHDR 宽高，纯函数无依赖）、`validateIconPng(bytes, { minSize })`、`validateIconPackFiles({ file: bytes })`；新增 `renderIconSettingsSection(container, deps)`（上传、预览、应用名称、下载图标包、恢复默认，含 `CUSTOM_ICON_HONESTY` 与重新部署说明原文）。 |
| `js/wakeEngine.js` | `parseWakeToolCall(input, nowMs)` 增加可注入的 nowMs（原来写死 `Date.now()`，测试无法定住过期边界）；`endScene(ref, nowMs, charId)` 增加角色隔离（原来按类型找会跨角色误结束）；新增 `updateScene(ref, patch, nowMs, charId)`、`snoozeScenes(charId, minutes, nowMs)`；新增 `applyWakeToolCall(parsed, fallbackCharId, nowMs)`（先校验后执行：set_alarm / set_repeat / snooze / end_scene / update_scene / set_note / clear_note）；`userMessage` 的 end 增量改为按当前角色结束；新增 `renderWakeSettingsSection(container, deps)`（总开关、免打扰、冷却/日上限/巡检间隔、角色独立开关，含 `WAKE_EXPLAIN_TEXT` 与 `WAKE_MODE_TEXT` 原文）；`uid` 改名 `wakeUid`（避开 `utils.js` 的 `uid`）；
本文件原有的 `ensureWakeStores` 已删除（唯一实现在 `storage.js`）；文件头注释已更新。 |
| `sw.js` | `VERSION` '1'→'2'；install 改为逐个缓存（`Promise.allSettled`）：`manifest.json` / 图标缺失不再导致全部缓存失败；预缓存列表增加 `./icons/apple-touch-icon.png`、`./icons/icon-192.png`、`./icons/icon-512.png`。缓存策略不变（index.html 网络优先；更新只清旧版本 Cache Storage，绝不碰 IndexedDB——文件里无任何 indexedDB 引用，已用测试锁定）。 |
| `scripts/build-icons.mjs` | 导入 `readPngSize` 逐档校验 PNG（须为正方形、边长达标；不合格 exit 1 并列出原因，manifest 不写入问题图标）；`apple-touch-icon.png` 同步一份到 `dist/apple-touch-icon.png`；link 清单改为 `/apple-touch-icon.png`（根路径）。 |
| `tests/b-group.test.mjs` | 新增 20 个测试（见 §3）。 |
| `tests/vectorMemory.test.mjs`、`tests/experiences.test.mjs` | 仅把两处 `DB_VERSION` 断言 3→4（版本升级的直接后果；建表行为断言本身未动）。 |
| `docs/b-css-additions.css` | 新增（临时文件，合并进 `styles.css` 后删除）：`.inapp-banner` 等横幅 6 个 class、`.b-honesty`、`.icon-preview-row`。 |
| `docs/b-group-integration.md` | 本文件。 |

未碰：`js/app.js`、`index.html`、`styles.css`、`scripts/build-preview.mjs`、
记忆模块、A 组模块、`js/importExport.js`（备份缺口见 §5 末尾）、`dist/`。

## 2. wake_UP 来源复核

- 已克隆 `https://github.com/KKarsyline/wake_UP` 到 `/tmp/wake-up`（2026-11-21）。
- 许可：**PolyForm Noncommercial License 1.0.0**（`LICENSE` 头 `Required Notice: Copyright 2026 KKarsyline`），与 Callback_DLC 同款。只借鉴机制，未复制 Python 代码。
- 借鉴的机制（`js/wakeEngine.js` 已实现，均有对应测试）：10 种情境与默认 cadence/lifetime/priority（outing 30/480、work 60/600、bedtime 45/600、morning 20/180、active_without_chat 30/240、silence_escalation 15/240、repeat 10/180、private_play 10/60、sulking 20/480、custom 45/360）；闹钟；每条用户消息最多 3 个增量；短期字条（最多成功读 3 次、版本核对）；回执三分（accepted / completed / notified 分开记）；完整报告按第 1、6、11……次轮换；时间戳 UTC、自然日与免打扰按固定 UTC+08:00；用户发言时唤醒回合让位。
- 明确不做的（`wake_when` 位置/App/健康条件）：第一阶段一律拒绝，见 `validateWakeWhen()`；`private_play` 情境保留类型与默认值，但无 App 事件输入时不会由事件触发，只能由用户明确表达或模型工具调用建立。

## 3. npm test 结果

- 基线 299/299（开工时复核）。
- 接线后 **319/319 通过，失败 0**（新增 20 个 B 组测试；另有 2 处旧断言随版本号更新，见上表）。
- 新增测试覆盖：v3→v4 迁移（假 db 建表 + 索引 + 不重复建）；`notifyInApp` 入口形状与未读持久化；音频状态机（启动→切后台中断→回前台不自动恢复→手动 resume→停止）；图标 PNG 尺寸生成与整包校验；唤醒校验边界（cadence 4/241、duration 9/1441、过期闹钟、snooze 721、非法 wake_when 拒绝）；`applyWakeToolCall` 按角色隔离；冷却/日上限/次日重置；多标签页认领互斥 + 过期 claim 回收 + `sendOnce` 去重；过期不补发（超宽限闹钟标记过期、超宽限情境顺延）；用户发言时让位；iOS 推送能力检测；5 个设置区渲染函数；`sw.js` 静态断言（版本化缓存、无 indexedDB 引用）。

## 4. 无头验证（Chromium /opt/meta-chromium/chrome，CDP 实测）

方法：`/tmp/b-verify/harness.html` 直接 import 源码模块（`file://` + `--allow-file-access-from-files`），
`--autoplay-policy=no-user-gesture-required`，自写最小 CDP 客户端（`Runtime.evaluate` + `awaitPromise`）
读 `#out`。注：本机构建的 `--dump-dom` / `--screenshot` 单次模式无输出（exit 0、无文件），
改走 `--remote-debugging-port` 的 CDP 才拿到结果；`--hatch-webgl-allowed-domains-file` 与 sha256
（策略文件两行：`hatch-webgl-allowed-domains-v1` / `example.com`）为启动必需参数（缺失时 exit 13）。

| 项 | 结果 |
|---|---|
| 站内通知横幅：`notifyInApp` 触发，头像/昵称/摘要齐全，未读 1 | 通过 |
| 正在看的聊天不重复弹窗，未读照计 | 通过 |
| 点击横幅进聊天并清未读 | 通过 |
| 音频保活：真实 `Audio` 启动成功，状态 playing | 通过 |
| 音频心跳：2.6 秒内 2 次心跳 | 通过 |
| 音频中断 → interrupted；回前台不自动恢复；手动 resume 恢复；stop 回 idle | 通过 |
| 图标导出：4 档齐全，真实 canvas 解码尺寸 180/192/512/512-maskable 全对 | 通过 |
| `readPngSize` 对真实导出的 PNG 读出 192×192 | 通过 |
| 唤醒到期触发：到时闹钟进 due 1 条 | 通过 |
| 过期不补发：40 分钟前闹钟只标记 expired，不进 due | 通过 |
| 用户发言时让位（skipped=user-typing，闹钟未消耗） | 通过 |
| 多标签页互斥：localStorage 锁，第二标签页认领失败 | 通过 |
| 推送能力：未配置 → 前端运行模式 / 未配置 | 通过 |

## 5. wake-push-service 端到端（本地实测到能验证的程度）

- `npm install` 成功（web-push ^3.6.7，17 个包）；`npx web-push generate-vapid-keys` 成功。
- 用临时生成的测试密钥写 `.env` 起服务：`GET /health` → `{"ok":true}`；`POST /subscribe`（fake endpoint）→ ok，订阅写入 `subscriptions.json`；`POST /tick` → `{"sent":0,"expired":1}`（fake endpoint 发送失败被正确计为 expired，到期任务已从 `wakeJobs` 移除，不会反复重发）；缺 endpoint → 400；未知路由 → 404；`POST /unsubscribe` → ok。
- 验证后已删除测试 `.env`（含临时私钥）与 `subscriptions.json`；`node_modules` 与 `package-lock.json` 保留。**真实部署必须重新生成 VAPID 密钥**，不要用本次测试密钥。
- 未验证：真实推送端点送达、iOS 真机收到推送并点通知打开聊天（需要真实订阅 + 部署后的域名 + HTTPS）。

## 6. build-icons.mjs 验证（临时副本 /tmp/b-icons-test，不污染工作区）

- 用 Node `zlib` 生成真实 PNG（180/192/512×4）：`node scripts/build-icons.mjs --name verweile` exit 0；`dist/icons/` 4 个文件齐全；`dist/apple-touch-icon.png` 已同步；`dist/manifest.json` 含 4 个 icons（180 apple-touch-icon / 192 any / 512 any / 512 maskable），`display: standalone`。
- 坏路径：`icon-512.png` 改为 512×400 后 exit 1，报错 `须为 512×512 或更大正方形，实际 512×400`，manifest 不写入问题图标。

## 7. Netlify 核对结果

- `netlify.toml`：构建命令 `npm run build`，发布目录 `dist`。与仓库现状一致。
- `scripts/build-preview.mjs` 只读 `js/*.js` + `index.html` + `styles.css`，**从不读 `verweile.zip`**（全文 grep 只有 `netlify.toml` 的注释提到 zip；构建脚本无任何 zip 引用）。符合要求。
- 缺口（构建产物不含新文件，须按 §8 的 spec 修）：当前 `dist/` 只有 `index.html` 与 `bundle.mjs`；`build-preview.mjs` 不复制 `sw.js`、`manifest.json`、`icons/`、`apple-touch-icon.png`。只改 `build-preview.mjs` 的复制逻辑（ORDER 行 + 复制逻辑见 §8），不要改 `netlify.toml`。
- `scripts/build-preview-adapted.mjs` 读 `dist/index.html` 生成预览，不受本次改动影响（它不处理 sw/manifest；预览页仍为单文件，SW 与推送只在部署版生效，需在文档里写清）。

## 8. 接线 patch spec（总协调员按此落地）

约定：5 个模块保持回调注入、不 import app.js；设置区渲染函数名各不相同
（`renderNotifySettingsSection` / `renderKeepAliveSettingsSection` /
`renderPushSettingsSection` / `renderIconSettingsSection` /
`renderWakeSettingsSection`），因为 `build-preview.mjs` 是拼接打包，同名顶层
函数会被后一个静默覆盖——这是 B 组在复核时发现并已修掉的拼接冲突（另两处同名
冲突：`wakeEngine.js` 的 `uid` 已改名 `wakeUid`，与 `utils.js` 的 `uid` 区分；
`ensureWakeStores` 只留 `storage.js` 一份，`wakeEngine.js` 的已删除）。
各函数的 `deps` 形状见其注释。所有插入代码均假设 A 组落地后的 app.js 仍保留所引锚文本；
行号会变，以锚文本为准。CSS 见 `docs/b-css-additions.css`（合并后删除该文件）。

### 8.1 build-preview.mjs — ORDER 加 5 行 + 复制逻辑

锚 1（ORDER，`js/storage.js` 行之后插入；5 个模块无 import、无先后依赖，只须在 `app.js` 之前）：
```
  'js/storage.js',
  'js/importExport.js',
```
插入：
```js
  'js/inAppNotify.js',
  'js/audioKeepAlive.js',
  'js/pushNotify.js',
  'js/customIcon.js',
  'js/wakeEngine.js',
```
（插在 `'js/storage.js',` 与 `'js/importExport.js',` 之间。`ensureWakeStores`
只在 `storage.js` 有一份——`wakeEngine.js` 原来的同名函数 B 组已删除，
`tests/wake-engine.test.mjs` 已改从 `storage.js` 导入；不要再加回去。）

锚 2（文件头 import 行）：
```
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
```
改为：
```js
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync, existsSync } from 'node:fs';
```

锚 3（文件尾写出逻辑）：
```
mkdirSync(resolve(root, 'dist'), { recursive: true });
writeFileSync(resolve(root, 'dist/index.html'), out, 'utf8');
writeFileSync(resolve(root, 'dist/bundle.mjs'), bundle, 'utf8');
```
之后追加：
```js
// B 组：Service Worker / manifest / 图标不能内联进单文件 HTML，必须作为独立文件复制到 dist。
// sw.js 是独立的 Service Worker 脚本（含顶层 self 监听），绝不能拼进 bundle。
if (existsSync(resolve(root, 'sw.js'))) copyFileSync(resolve(root, 'sw.js'), resolve(root, 'dist/sw.js'));
if (existsSync(resolve(root, 'manifest.json'))) copyFileSync(resolve(root, 'manifest.json'), resolve(root, 'dist/manifest.json'));
if (existsSync(resolve(root, 'apple-touch-icon.png'))) copyFileSync(resolve(root, 'apple-touch-icon.png'), resolve(root, 'dist/apple-touch-icon.png'));
if (existsSync(resolve(root, 'assets/icons'))) {
  cpSync(resolve(root, 'assets/icons'), resolve(root, 'dist/icons'), { recursive: true });
}
```
说明：`manifest.json` 与 `assets/icons/` 由 `node scripts/build-icons.mjs` 生成/复制到
`dist/`（见本文件 §6）；部署顺序：先跑 `build-icons.mjs`（有自定义图标时），再跑
`npm run build`。`build-preview-adapted.mjs` 不用改（它只读 `dist/index.html`）。

### 8.2 index.html — manifest 与 apple-touch-icon 改为部署文件

锚（`<head>` 内第 12–13 行）：
```
<link rel="manifest" href='data:application/manifest+json,{"name":"verweile","short_name":"verweile","display":"standalone","background_color":"%23ececed","theme_color":"%23ececed","start_url":"."}'>
<link rel="apple-touch-icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%231d1d1f'/%3E%3Ctext x='32' y='42' font-size='28' text-anchor='middle' fill='white' font-family='sans-serif'%3Ev%3C/text%3E%3C/svg%3E">
```
改为：
```html
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```
（`#msg-menu` 相关：本轮无改动。`index.html` 无其他 B 组改行；站内横幅容器由 app.js
在 `#app` 内动态创建，见 §8.3 第 5 点，不需要在 index.html 加静态节点。）

### 8.3 app.js — 模块级状态 + 设置加载/保存

锚 A（设置变量声明区，`let assocSettings = { ...DEFAULT_ASSOC_SETTINGS };` 行附近）：
```
let assocSettings = { ...DEFAULT_ASSOC_SETTINGS };
```
在其后插入：
```js
// B 组设置（settings 表键名见各模块的 *_SETTINGS_KEY；默认值为各模块的 DEFAULT_*）。
let notifySettings = { ...DEFAULT_NOTIFY_SETTINGS };
let keepAliveSettings = { ...DEFAULT_KEEPALIVE_SETTINGS };
let pushSettings = { ...DEFAULT_PUSH_SETTINGS };
let customIconSettings = { appName: DEFAULT_APP_NAME, dataUrl: null };
let wakeSettings = { ...DEFAULT_WAKE_SETTINGS };
// B 组单例（boot 里初始化；模块均不 import app.js，只拿回调）。
let inAppNotifier = null;
let audioKeepAlive = null;
let wakeEngine = null;
```

锚 B（`loadAll` 里加载 assoc 设置之后）：
```
  const assocSet = await backend.get('settings', 'assocSettings');
  if (assocSet?.value) assocSettings = { ...DEFAULT_ASSOC_SETTINGS, ...assocSet.value };
```
在其后插入：
```js
  const notifySet = await backend.get('settings', NOTIFY_SETTINGS_KEY);
  if (notifySet?.value) notifySettings = { ...DEFAULT_NOTIFY_SETTINGS, ...notifySet.value };
  const kaSet = await backend.get('settings', KEEPALIVE_SETTINGS_KEY);
  if (kaSet?.value) keepAliveSettings = { ...DEFAULT_KEEPALIVE_SETTINGS, ...kaSet.value };
  const pushSet = await backend.get('settings', PUSH_SETTINGS_KEY);
  if (pushSet?.value) pushSettings = { ...DEFAULT_PUSH_SETTINGS, ...pushSet.value };
  const iconSet = await backend.get('settings', CUSTOM_ICON_SETTINGS_KEY);
  if (iconSet?.value) customIconSettings = { appName: iconSet.value.appName || DEFAULT_APP_NAME, dataUrl: iconSet.value.dataUrl || null };
  const wakeSet = await backend.get('settings', WAKE_SETTINGS_KEY);
  if (wakeSet?.value) wakeSettings = { ...DEFAULT_WAKE_SETTINGS, ...wakeSet.value };
```

锚 C（保存函数区）：
```
async function saveAssocSettings() {
  await backend.put('settings', { key: 'assocSettings', value: assocSettings });
}
```
在其后插入：
```js
async function saveNotifySettings() {
  await backend.put('settings', { key: NOTIFY_SETTINGS_KEY, value: notifySettings });
}
async function saveKeepAliveSettings() {
  await backend.put('settings', { key: KEEPALIVE_SETTINGS_KEY, value: keepAliveSettings });
}
async function savePushSettings() {
  await backend.put('settings', { key: PUSH_SETTINGS_KEY, value: pushSettings });
}
async function saveCustomIconSettings() {
  await backend.put('settings', { key: CUSTOM_ICON_SETTINGS_KEY, value: customIconSettings });
}
async function saveWakeSettings() {
  await backend.put('settings', { key: WAKE_SETTINGS_KEY, value: wakeSettings });
}
```

### 8.4 app.js — 设置页：新增“通知与唤醒”tab + 外观 tab 挂图标区

锚 D（tab 列表）：
```
const TABS = ['persona', 'prompt', 'worldbook', 'memory', 'stickers', 'api', 'data'];
let settingsTab = 'persona';
```
改为：
```js
const TABS = ['persona', 'prompt', 'worldbook', 'memory', 'stickers', 'api', 'data', 'notify'];
let settingsTab = 'persona';
```
（tab 的中文名与排序由 A 组在 ManageView 里统一处理；若 A 组已另设 tab 名，
以 A 组为准，只需保证 `renderSettingsBody` 里有下面分支。）

锚 E（`renderSettingsBody` 末尾，appearance 分支之前）：
```
  if (settingsTab === 'appearance') {
    ThemeStore.renderAppearance(body);
    return;
  }
```
在其前插入：
```js
  if (settingsTab === 'notify') {
    body.innerHTML = '<div id="b-notify-sec"></div><div id="b-keepalive-sec"></div><div id="b-push-sec"></div><div id="b-wake-sec"></div>';
    renderNotifySettingsSection(document.getElementById('b-notify-sec'), {
      settings: notifySettings,
      onSave: async (next) => { notifySettings = next; if (inAppNotifier) inAppNotifier.settings = { ...inAppNotifier.settings, ...next }; await saveNotifySettings(); },
      toast,
    });
    renderKeepAliveSettingsSection(document.getElementById('b-keepalive-sec'), {
      settings: keepAliveSettings,
      keepAlive: audioKeepAlive,
      onSave: async (next) => { keepAliveSettings = next; await saveKeepAliveSettings(); },
      onStateChange: () => renderSettingsBody(),
      toast,
    });
    renderPushSettingsSection(document.getElementById('b-push-sec'), {
      settings: pushSettings,
      env: {
        hasServiceWorker: 'serviceWorker' in navigator,
        hasPushManager: 'PushManager' in window,
        hasNotification: 'Notification' in window,
        permission: ('Notification' in window) ? Notification.permission : 'unsupported',
        configured: !!(pushSettings.vapidPublicKey && pushSettings.pushServiceUrl),
        tested: false,
        isIOS: /iPad|iPhone|iPod/.test(navigator.userAgent),
        isStandalone: window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
      },
      onSave: async (next) => { pushSettings = next; await savePushSettings(); },
      onRequestPermission: () => requestPermission(),
      onSubscribe: async () => {
        const reg = await navigator.serviceWorker?.getRegistration?.();
        if (!reg) return { ok: false, reason: 'Service Worker 未注册。' };
        return subscribePush(reg, pushSettings.vapidPublicKey);
      },
      toast,
    });
    renderWakeSettingsSection(document.getElementById('b-wake-sec'), {
      settings: wakeSettings,
      chars: [{ id: char.id, name: char.remarkName || char.realName }],
      onSave: async (next) => { wakeSettings = next; if (wakeEngine) await wakeEngine.saveSettings(next); await saveWakeSettings(); },
      toast,
    });
    return;
  }
```

锚 F（外观 tab 挂图标区；`ThemeStore.renderAppearance` 之后追加）：
```
  if (settingsTab === 'appearance') {
    ThemeStore.renderAppearance(body);
    return;
  }
```
改为：
```js
  if (settingsTab === 'appearance') {
    ThemeStore.renderAppearance(body);
    const iconHost = document.createElement('div');
    iconHost.id = 'b-icon-sec';
    body.appendChild(iconHost);
    renderIconSettingsSection(iconHost, {
      settings: customIconSettings,
      onSave: async (record) => {
        customIconSettings = { appName: record.appName, dataUrl: record.dataUrl };
        await saveCustomIconSettings();
      },
      onExportPack: async () => {
        // 集成方实现：用当前源图（customIconSettings.dataUrl 解码为 Image）
        // 调 exportIconPack 逐档生成 PNG 并触发下载；无源图时返回
        // { ok: false, reason: '没有可用的源图。' }。
        return { ok: false, reason: '请先上传一张图标图片。' };
      },
      toast,
    });
    return;
  }
```
注意：图标文件 input 的 `change` 处理（`validateIconFile` → 读图 → `computeCropRect` /
`previewSpecs` 画预览 → 压缩后 data URL 存 `customIconSettings.dataUrl`）须由 A 组在
`renderIconSettingsSection` 的 `onSave` 之外补一个文件选择回调——`renderIconSettingsSection`
目前只渲染界面与按钮，不直接读文件（见 `customIcon.js` 注释）。`onExportPack`
的占位返回须替换为真实导出，否则“下载图标包”按钮只会弹提示。

### 8.5 app.js — boot() 初始化 + 消息触发点 + 前台巡检

锚 G（`boot` 内）：
```
    updateHeader();
    await renderMessages(false);
    // 保存失败提示
```
在 `await renderMessages(false);` 之后、`// 保存失败提示` 之前插入：
```js
    // B 组初始化（模块均回调注入，不 import app.js）。
    inAppNotifier = new InAppNotifier({
      settings: notifySettings,
      env: {
        supportsVibration: 'vibrate' in navigator,
        supportsSound: true,
        playSound: () => { /* 可选：播一声短提示音；无音频文件时留空（降级说明已在模块内） */ },
        vibrate: (p) => navigator.vibrate?.(p),
      },
      onBanner: (banner) => renderInAppBanner(banner),
      onOpenChat: (charId, messageId) => openChatForBanner(charId, messageId),
    });
    await loadUnread(backend, inAppNotifier);
    audioKeepAlive = getAudioKeepAlive({
      onStateChange: () => { /* 状态变化时如需刷新设置页，调 renderSettingsBody() */ },
    });
    wakeEngine = new WakeEngine({
      store: backend,
      settings: wakeSettings,
      slmClient: null, // 总结副 API 接好后再传 auxApi.callSummaryChat 包装的分类回调；未传时只走关键词快路径
    });
    await wakeEngine.loadSettings();
    // Service Worker：只在用户开启推送时注册；注册失败不阻断启动。
    if (pushSettings.enabled && 'serviceWorker' in navigator) {
      const sw = await registerServiceWorker(navigator, '/sw.js');
      if (!sw.ok) console.warn('SW 注册失败：', sw.reason);
    }
    // 前台巡检：页面可见时按 patrolIntervalMin 检查唤醒到期；恢复前台立即检查一次。
    const wakePatrol = async () => {
      if (document.hidden || !wakeEngine) return;
      const { due } = await wakeEngine.checkDueOnForeground();
      for (const w of due) await runWakeRound(w); // 见下文 §8.6，由总协调员实现
    };
    setInterval(wakePatrol, Math.max(1, wakeSettings.patrolIntervalMin || 15) * 60 * 1000);
    document.addEventListener('visibilitychange', async () => {
      if (document.hidden) { audioKeepAlive?.handleVisibility(true); return; }
      audioKeepAlive?.handleVisibility(false); // 回前台不自动恢复保活（模块内已保证）
      await wakePatrol();
    });
```

锚 H（消息写入后触发站内通知——利用 boot 里已有的 `backend.put` 包装器；不要另找
各处 `put('messages')` 逐一插桩）：
```
    // 保存失败提示
    const origPut = backend.put.bind(backend);
    backend.put = async (...args) => {
      try { return await origPut(...args); }
```
改为：
```js
    // 保存失败提示
    const origPut = backend.put.bind(backend);
    backend.put = async (...args) => {
      try {
        const saved = await origPut(...args);
        // B 组：消息先持久化再通知（notifyAfterPersist 的同一原则）。
        // 只对其他角色/非当前聊天页的消息弹横幅；当前正在看的聊天不重复遮挡。
        if (args[0] === 'messages' && args[1]?.role === 'assistant' && inAppNotifier) {
          inAppNotifier.notifyInApp({
            charId: args[1].charId,
            avatar: charAvatarFor(args[1].charId),
            name: charNameFor(args[1].charId),
            summary: plainTextOf(args[1]),
            messageId: args[1].id,
          }, isChatPageVisible() ? char.id : null);
          await saveUnread(backend, inAppNotifier);
        }
        return saved;
      }
```
并在同一文件内补 3 个小函数（放在 `boot` 外任意位置；`charAvatarFor` / `charNameFor` /
`plainTextOf` / `isChatPageVisible` 由总协调员按现有数据实现——本项目现为单角色，
`charAvatarFor` 可直接返回当前角色头像、`charNameFor` 返回备注名；`isChatPageVisible`
须以 NavShell 的当前页状态为准，**不要凭空编一个 DOM id**；若 A 组未提供现成 accessor，
先以 `document.visibilityState === 'visible' && !document.hidden` 的保守值代替并在
汇报里注明——保守值会让用户在聊天页也收到横幅，属于已知待确认项）：
```js
// B 组：站内横幅渲染（按 InAppNotifier 返回的 banner 描述子渲染；CSS 见 b-css-additions.css）。
function renderInAppBanner(banner) {
  document.querySelector('.inapp-banner')?.remove();
  const el = document.createElement('div');
  el.className = 'inapp-banner';
  el.innerHTML = `${banner.avatar ? `<img class="inapp-banner-avatar" src="${escapeHtml(banner.avatar)}" alt="">` : ''}
    <div class="inapp-banner-body"><div class="inapp-banner-name">${escapeHtml(banner.nickname)}</div>
    <div class="inapp-banner-summary">${escapeHtml(banner.summary)}</div></div>
    <button class="inapp-banner-close" aria-label="关闭通知">×</button>`;
  el.addEventListener('click', () => { el.remove(); inAppNotifier?.openBanner(banner.id); });
  el.querySelector('.inapp-banner-close').addEventListener('click', (e) => {
    e.stopPropagation(); el.remove(); inAppNotifier?.dismissBanner(banner.id);
  });
  document.getElementById('app')?.appendChild(el);
  setTimeout(() => { el.remove(); inAppNotifier?.dismissBanner(banner.id); }, 8000); // 8 秒自动消失，未读照计
}
function openChatForBanner(charId, messageId) {
  // 切到对应聊天并定位到 messageId（不生成新消息）；单角色现状下等价于回到聊天页。
  void charId; void messageId;
  // TODO（总协调员）：接 NavShell 回到聊天页 + scroll 到 messageId。
}
```

锚 I（用户消息入口，接唤醒分类；`sendUserText` 内）：
```
  await backend.put('messages', msg);
  await appendMessageElement(msg);
  setSaveState('已保存');
  return msg;
}
```
在 `setSaveState('已保存');` 之前插入：
```js
  if (wakeEngine) await wakeEngine.userMessage(char.id, msg.id, text).catch(() => {});
```
（`text` 为用户原文；`sendUserText` 收到的是原文，`msg.content` 是包了协议前缀的，
分类必须用原文。失败静默——分类失败不建/不改情境，见 wakeEngine 注释。）

### 8.6 唤醒回合执行（runWakeRound，须总协调员新写，B 组只给接口形状）

`wakeEngine.checkDueOnForeground()` 返回 `{ due: [{ wakeId, trigger, charId, scenes, alarms, report }] }`；
每一项须由调用方走一次正常模型回合，**不由引擎自己调模型**。伪代码（放在 app.js，
复用现有“生成回复并保存”的链路；不要另起一套保存逻辑）：
```js
async function runWakeRound(w) {
  // 1. 领取已在 checkDueOnForeground 内完成（claimWake）；这里先记 accepted。
  await wakeEngine.markReceipt(w.wakeId, 'accepted', true);
  // 2. 把 w.report.text 与“近期聊天 + 相关记忆”一起交给现有模型调用
  //    （复用 buildSystemPrompt / 历史读取；report 已含触发原因、有效情境、字条，
  //    不含位置/App/健康数据）。
  // 3. 模型返回后按 decision 分支：
  //    - send：把消息按正常 assistant 消息保存（走现有保存链路），再
  //      await wakeEngine.sendOnce(w.wakeId, async () => ({ delivered: true }))
  //      记 notified；失败重试时 sendOnce 保证不重复发。
  //    - skip：只记 completed（handleWakeOutcome 已处理）。
  //    - reschedule：parseWakeToolCall 校验 → applyWakeToolCall 执行。
  //    统一用 wakeEngine.handleWakeOutcome(w.wakeId, outcome) 收尾；
  //    用户中途发言时它返回 { ok:false, decision:'cancelled' }，本轮作废。
  // 4. 有实质内容时 await wakeEngine.settleWake(w.wakeId, w.report, true) 消费字条。
}
```
注意：`handleWakeOutcome` 的 reschedule 分支目前只返回校验后的 `toolCall`，
不执行——调用方须接着调 `applyWakeToolCall(parsed, w.charId)`（见 §3 测试）。

### 8.7 备份缺口（不在 B 组可改文件内，总协调员另行处理）

`js/importExport.js` 的 `exportAll` 目前不导出 B 组的 5 个 settings 键与 3 张唤醒表
（grep 验证：`wakeScenes|wakeAlarms|wakeReceipts|notifySettings|pushSettings|customIcon|
wakeSettings|audioKeepAlive` 在该文件无命中）。建议在 `exportAll` / `importNormalized`
里补：
- settings：`notifySettings`、`audioKeepAlive`、`pushSettings`、`customIcon`、
  `wakeSettings`（与 `api` / `assocSettings` 同一模式导出；`pushSettings.vapidPublicKey`
  是公钥可随备份走，`pushServiceUrl` 无敏感信息；私钥只在服务器 `.env`，不进备份）；
- 唤醒表：`wakeScenes` / `wakeAlarms` / `wakeReceipts` 全量导出导入（与 `experiences`
  同一模式；`wakeReceipts.claim` 导入时应清空，避免把过期认领带到新设备）。
- 锚（`exportAll` 内导出 api 设置处）：
```
  const settings = await backend.get('settings', 'api');
  if (settings) out.apiSettings = settings.value;
```
在其附近按现有模式追加。未补之前：换设备/恢复备份后唤醒安排与通知设置会丢失，
属于已知缺口，不影响本机使用。

### 8.8 已知冲突与注意事项

- `build-preview.mjs` 的 ORDER：A 组也在加 4 个模块行；两边插入位置不同
  （A 组模块在 ORDER 末尾 app.js 附近，B 组在 storage.js 之后），合并时以本 spec
  §8.1 为准；**`ensureWakeStores` 重复声明问题见 §8.1 锚 1，务必二选一删除**。
- `DB_VERSION` 已是 4；A 组不要再动版本号。记忆轮的 `ensureExperienceStores` /
  `ensureVectorStores` 未动。
- `sw.js` 注册路径为 `/sw.js`；预览（单文件 hosting）下不生效，只在部署版生效。
- `index.html` 的 manifest 改为 `/manifest.json` 后，预览页（单文件）不再自带
  inline manifest——这是有意的：安装图标必须走部署文件。

## 9. 仍未验证的事（须真机 / 真实服务）

- 真机 iPhone：PWA 主屏幕启动、键盘遮挡、长按手感、文件选择、图片/背景在 PWA 模式下保留、站内横幅实际点击、图标重新部署后重新添加主屏幕是否生效。
- 真实 API：唤醒回合调真实模型（report + 近期聊天 + 相关记忆）、SLM 分类（`slmClient` 目前传 null，只走关键词快路径）、向量记忆与唤醒的联动。
- SW / 推送部署后实测：真实推送订阅送达、点通知打开对应聊天、SW 更新不丢 IndexedDB（代码层面已保证，部署后仍需实测一次旧版缓存清理）。
- wake-push-service 端到端：真实推送端点送达（本次只到 fake endpoint 的 expired 计数）；部署域名 + HTTPS + VAPID 重新生成。
- iOS 后台音频保活：播放成功 ≠ 保活成功；锁屏/后台是否继续、心跳切后台后是否继续，均未验证（沙箱无法验证）。
- 备份恢复：B 组 5 个设置键 + 3 张唤醒表尚未进备份（§8.7），恢复后会丢失，需补后验证一轮导出→清空→导入。
- `isChatPageVisible` / `openChatForBanner` 的 NavShell 接法（§8.5 锚 H 的 TODO），待总协调员确认。
- `renderIconSettingsSection` 的文件选择回调与 `onExportPack` 真实导出（§8.4 锚 F 的 TODO），待总协调员补。
