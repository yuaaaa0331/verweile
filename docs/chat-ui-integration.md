# A 组集成记录（2026-11-21）：聊天 UI 精简 + 状态/心声三模式 + 长按菜单 + 日常体验

本文件是集成轮的交接记录，不改 `docs/chat-audit.md` 原文。审计里的根因推断
（§⑦三 bug、宿主层判定）已逐条落地或注明未动原因。

## 改了什么

### 任务 1 — 聊天 UI 精简
- 品牌行：聊天页激活时隐藏（`#app.in-chat.brand-bar{display:none}`），节点不删；
`.in-chat` 由 `app.js` 里对 `#view-chat` class 的 MutationObserver 同步
（NavShell 在 `js/nav.js`，不在本轮文件集里，所以用 Observer 跟它的切页走）。
切到动态/管理页后品牌行恢复显示（无头验证通过）。
- 顶栏悬浮：`.chat-head` 改 absolute + 羽化 `::after`，`#message-area` 顶部 padding
抬到 84px+安全区；右侧操作统一为 44px 玻璃圆按钮（挂 `.glass` 走 LiquidGlass 引擎）。
注意：`styles.css` 后段有一份 verweile 覆盖块（约 600–640 行）会盖掉基础段的
`.bubble` / `#message-area` / `.input-shell` / `.chat-head` ——
本轮两处都改了，只改基础段会被盖回去（无头首轮 3 项失败就是这个原因）。
- 气泡：7px 14px、圆角 17.5px、line-height 1.4；组内 2px、组间 7px；
mask 尾巴 24×21 只在组末（`.group-last`），形状取小池 iMessage 文件的
`--img-tail-left/right` SVG（只借形状，颜色走 `--bubble-me/--bubble-ai`）。
组末判定与 `.continuous` 方向相反，纯函数在 `js/chatDaily.js` 的
`groupLastFlags()`，`renderMessages` / `appendMessageElement` 共用；
追加新消息时上一条同组消息的尾巴会收掉。
- 常驻控制移走：`#status-strip` 与 `#auto-row` 节点保留在 DOM（JS 仍读写），
CSS 隐藏；自动回复、状态模式、保存状态、多选批量操作、调试开关都收进
顶栏 ··· 的「聊天设置」弹窗（`app.js` 的 `openChatMenu()`）。
状态条协议泄漏顺手修了一道：`renderStatusStrip` 里 `stripProtocolHead()` 再剥
无冒号的 `[ ` 形协议头（`summarizeStatus` 在 `statusBar.js`，不在本轮文件集里）。
- 输入中提示改成 64×38 玻璃气泡 + 三点动画，不带文字；输入壳 radius 28px。
- 明确返回出口：Tab 栏是唯一的底部导航（输入栏下不再堆自动回复行），
未新增返回按钮（审计建议：不要为它新建一个返回入口）。

### 任务 2 — 状态与心声三模式（按角色保存）
- 模式存 `char.statusMode`（concise/inner/html，默认 concise），心声提示词存
`char.innerVoicePrompt`；入口两处：人设表单「状态模式」区 + 顶栏 ··· 菜单。
切换只改选择字段，模板（`statusPanel`）与历史原样保留。
- 提示词组装：`promptBuilder.js` 的 `statusSuffix` 改走
`getStatusInstruction(character).instruction`，每轮只注入一套指令。
兼容：老角色没有 `statusMode`、但状态模板已启用时按 html 走，
不让一次升级悄悄关掉已在用的状态栏（现有 `prompt.test.mjs` 的状态栏断言仍过）。
模式切换后 `buildCurrentRequest` 的签名失效缓存（签名数组加了
`char.statusMode` / `char.innerVoicePrompt`）。
- 心声：`handleAiReplyContent` 里分段前先过 `parseInnerVoice()`，正文进分段，
心声挂到本轮第一条落盘的助理消息（`msg.innerVoice`，`applySegment` 里认领一次）；
旧数据渲染时 `createMessageElement` 同样剥一次（只改渲染副本，不写库）。
只在 inner 模式下露出「心声」按钮，点开轻量面板看对应回合，不自动弹出；
解析失败安静降级，协议标记绝不进气泡；绝不读 reasoning/thinking。
- HTML 状态栏：状态模板抽取只在 html 模式跑（`applySegment` 里按模式 gating，
concise/inner 不再从回复里抽状态）；弹窗本身仍是沙箱 iframe 隔离渲染。
- 浮层三 bug（审计 §⑦）：
- 共同根因修掉：`#status-popup` 从 `#view-chat` 里移到 `#app` 的直接子节点，
`fixed` → `absolute`（与 `.sheet`/`.modal` 一致），遮罩终于能盖住 Tab 栏；
- Bug 1：sheet `max-width:520px` → `100%`，不再顶出手机框；
- Bug 2：底部抽屉式对齐 + `padding-bottom:96px` 给 Tab 栏留位，
sheet 背景加到 `.88` 不透明（含 `.gl-webgl` 态的覆盖规则），底栏不再透出来；
- Bug 3：footer 改 `sticky` 贴底 + 实底色，不再是透明文字叠在 Tab 栏图标上。
- 未动：`js/statusBar.js` 的 `STATUS_FRAME_CSS`（不在本轮文件集里）；
帧内 `html,body` 约束没加，只在外层给 `.status-frame` / `.status-custom`
加了 `max-width:100%` + `overflow-x:hidden` 兜底。
状态 iframe 高度上报仍按原有 24–6000px 夹值，sheet 内部滚动承接高模板。

### 任务 3 — 长按菜单
- 旧底部 sheet（`openMsgMenu` + `#msg-menu`）退役，`index.html` 里的 `#msg-menu`
节点已删；`attachMsgMenu` 改调 `LongPressMenu.attachTo()`，
`openMsgMenu(msg,x,y)` 保留为兼容入口（现在按气泡实际位置打开，不再 void 丢弃 x/y）。
- 菜单与反应条分开排布、右侧单色图标、删除红色；放置走
`computeMenuPlacement`，底部避让由 `getBottomReserve()` 接 visualViewport
（键盘高度 + 输入区 + Tab 栏）实时算。
- 动作全部真实生效：复制（clipboard + 降级）、引用回复、收藏（`msg.isFavorite`
落库）、选择（多选描边，批量删除/清除选择走顶栏 ··· 菜单）、编辑、撤回
（2 分钟内）、重新生成（助理）、不进入上下文、查看原始内容、删除（5 秒撤销
toast，`createDeleteToken`）；反应纯本地写 `message.reactions`，重复点取消，
「更多反应」给 6 个额外表情（🎉😢🔥👀🙏💯），同样落库。
调试开关从长按菜单移出，改走顶栏 ··· 菜单（日常菜单不应出现调试功能）。
- 长按 500ms + 10px 移动取消 + 多指取消 + 桌面右键；点空白关闭并恢复滚动位置
（`scrollContainer: messageArea`）。

### 任务 4 — 日常体验（`js/chatDaily.js` 接线）
- 草稿：`#input` 输入时 300ms 防抖按角色存，发送后清除，切后台/`pagehide` 前
flush，启动时回填（输入框空着才填）。
- 阅读位置：滚动停稳 300ms 后按角色存距底偏移；启动时一次性还原；
全量重渲染前记距底偏移，上翻时不强行拉底；新消息到达按
`decideNewMessageDisplay` 判定（贴底跟随 / 上翻显示「↓ 有 N 条新消息」pill，
点 pill 拉底）。自己发消息仍强制拉底（刚发完要看到自己的消息）。
- 发送失败：`sendUserText` / `sendImageMessage` 加 try/catch，失败消息以
`sendState='failed'` 落盘并显示重试按钮，`retrySendMessage` 复用同一
messageId（put 而非 add）。
- 生成恢复：`getReply` 起止写 `localStorage['uwu-chat.generating']` 标记；
启动时凭标记 + `recoverInterruptedMessages` 扫描残留 generating 消息，
标中断并提示「上次生成已中断，未自动续生成」，绝不自动续生成。
- 缓存：`app.js` 里没有找到与缓存（Cache Storage / Service Worker）相关的旧逻辑，
无可标注项；SW 本身是 B 组的。

## 打包
- `scripts/build-preview.mjs` 的 ORDER 只加了 4 行：`js/statusMode.js` 放在
`js/promptBuilder.js` 之前（提示词组装 import 它），`js/longPressMenu.js` /
`js/innerVoice.js` / `js/chatDaily.js` 放在 `js/app.js` 之前；其余行与
sw/manifest 复制逻辑未动。隔离副本里 `node scripts/build-preview.mjs` 通过，
`node --check dist/bundle.mjs` 通过，无 import 别名残留。

## 测试
- 新增 `tests/chat-ui-integration.test.mjs`（17 个）：组末判定、心声解析降级、
菜单过滤/反应/撤销窗口/放置、状态模式切换不删模板、三模式提示词注入、
老角色兼容、草稿/阅读位置/重试/生成恢复、样式与结构静态约定、打包顺序、
`app.js` 接线锚点。
- 全量：`npm test` 337/337 通过（0 失败；含 B 组并行新增的测试）。
- 记忆测试无回归（experiences / keywordSearch / associative / vectorMemory 等均通过）。

## 无头验证（Chromium 390×844，file:// + 隔离副本构建，虚构数据）
47/47 通过，无页面异常 / console.error。逐项：
品牌行/状态条/自动回复行隐藏、顶栏悬浮、气泡 7px 14px / 1.4 / 17.5px、
消息区顶部留高、输入壳 28px、typing 气泡无文字、组末 `.group-last`、
心声不进气泡且面板显示对应独白、草稿写盘与刷新恢复、发消息与草稿清除、
Get Reply 模拟回复、长按菜单出现与菜单项过滤、反应条独立、气泡高亮、
反应保存/取消、点空白关闭、删除+撤销恢复、消息区可滚动前置、pill 不拉底且计数、
点 pill 拉底、聊天设置弹窗、状态模式切换落库且模板未删、浮层三 bug
（absolute / 不穿出 / 底缘在 Tab 栏之上 / 关闭不重叠 / iframe 高度上报）、
表情包、动态/管理页、记忆页三区。
尾巴另查：组末气泡 `::before` 24×21 mask 在位，非组末为 none。
截图（`~/workspace/your_files/`）：`chat-ui-chat.png`、`chat-ui-long-press.png`、
`chat-ui-inner-voice.png`、`chat-ui-chat-menu.png`、`chat-ui-status-popup.png`。

## 仍未验证（需真机 / 真实 API）
- 真 iPhone：长按手感、键盘弹起时菜单避让、PWA 下草稿/阅读位置/图片保留、
状态弹窗在真机安全区与键盘下的表现、尾巴在真机 UWU 渲染里的观感。
- 真实 API：心声模式下模型实际输出 `[inner_voice]` 的解析落盘路径
（目前只验证了渲染侧：往库里写带协议的消息→重载→剥离+面板；
`handleAiReplyContent` 的解析分支只有单元测试覆盖，mock 回复不带心声）。
- 真实备份导出→重导入往返（只做了记忆页与数据页打开的冒烟）。
- 长按菜单在气泡贴近屏幕顶/底边缘时的翻转（只测了上下两种放置，未测极端位置）。
- 液态玻璃气泡只做了 CSS 层面的可选样式（`.bubble` 未接开关，见下）。

## 未做的事（有意留下的）
- 液态玻璃气泡作「可选样式」的开关没接：外观设置在 `js/manage.js`，
不在本轮文件集里；CSS 里 `.bubble` 仍是现有清晰材质。
- 顶栏头像未按审计映射放大到 58px：现为 44px 正圆（后段覆盖块原先是 43px 方角，
已统一成圆），顶栏高度与消息区 padding 是按 44px 定的。
- 未新增返回按钮：Tab 栏就是明确返回出口，审计建议不要新建返回入口。
- iMessage 边缘高光只做了 `inset` 亮边，未做四角描边 mask（低价值、高风险）。
- 语音波形未改 SVG 化（现行 div 竖条已可用，审计标低优先级）。

## 给 B 组的交接锚点（用锚文本描述，不只给行号）
- `app.js` 里 `buildCurrentRequest` 的签名数组现在含 `char.statusMode` 与
`char.innerVoicePrompt`——B 组若动签名生成逻辑，别把这两项弄丢，否则切换
状态模式后缓存的请求不重建。
- `app.js` 里 `renderStatusPopup` 与状态 iframe 高度消息处理未动高度夹值
（仍是 24–6000px）；B 组若改 `STATUS_FRAME_CSS`（在 `js/statusBar.js`，
我没碰），帧内 `html,body{max-width:100%}` 与绝对定位子元素的约束仍可补，
外层 `.status-frame` 的 `max-width:100%` 已由我加好。
- `app.js` 的 `openChatMenu` 里切模式后把 `lastBuiltRequest` 置空——B 组若重构
请求缓存，注意这个失效点。
- `longPressMenu.js` 的菜单根节点挂在 `document.body` 下用 `position:fixed`
（坐标取自气泡 `getBoundingClientRect` 的视口坐标，与 `#app` 居中偏移无关）；
B 组的 SW/推送改动不影响它，但若 B 组改 `#app` 的定位方式，请同步确认菜单坐标。
- 我没碰的文件：`js/storage.js`、`js/wakeEngine.js`、`js/audioKeepAlive.js`、
`js/inAppNotify.js`、`js/pushNotify.js`、`js/customIcon.js`、`sw.js`、
`scripts/build-icons.mjs`、`server/`、全部记忆模块。
- 注意：`tests/b-group.test.mjs` 在本轮中途曾因 B 组把 `ensureWakeStores`
从 `js/wakeEngine.js` 移走而导入失败；最终全量 337/337 时它已通过，
是 B 组自己修好的，不是我动的手。
- `dist/` 我没有改：构建只在 `/tmp/a-verify` 隔离副本里跑过；
但 `dist/index.html` 的时间戳是 18:28 且含本轮标记——不是我写的，
请总协调员按计划最后统一重建并确认 dist 与源码一致。
