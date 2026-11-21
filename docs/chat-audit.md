# 聊天详情页只读审计（chat-audit.md）

审计范围：`index.html`、`js/app.js`、`styles.css`、`js/statusBar.js`、`js/liquidGlass.js`、`js/theme.js`（只读，未改动）。
对照材料：`~/workspace/user/files/iMessage_by___4.txt`（2354 行，小池 iMessage 暗）、三张截图（状态浮层溢出 / 聊天页现状 / iOS 长按菜单参考）。
审计日期：2026-11-21。**本文件只审计、不改代码；浮层 bug 的根因标注了置信度（截图 + 现行代码推断，未在真机复现）。**

---

## ① 当前聊天详情页 DOM 结构（`index.html`）

```
#app（position:relative；overflow:hidden；宽 min(430px,100vw)；高 100dvh）
├──.bg-layer#bg-layer（z-index:0，壁纸）
├── canvas#gl-canvas（z-index:1，液态玻璃 WebGL 画布，pointer-events:none）
├──.brand-bar（z-index:3；见 §②）
├──.views#views（z-index:2；flex:1）
│ └── section#view-chat.view.view-chat.active
│ ├── header.chat-head.glass
│ │ ├── img#char-avatar.top-avatar
│ │ ├── button#top-info-btn.top-info（> #char-name.top-name + #char-status.top-status）
│ │ ├── span#mock-badge.badge.mock.hidden（“模拟”）
│ │ ├── button#status-btn.icon-btn（♥，开状态弹窗）
│ │ └── button#chat-menu-btn.icon-btn（···，更多）
│ ├──.status-strip.glass#status-strip（>.chips#status-chips + button#status-strip-toggle.chev）
│ ├── #status-popup.status-popup.hidden（role=dialog，见 §⑦）
│ │ ├──.status-scrim#status-scrim
│ │ └──.status-sheet.glass
│ │ ├──.status-sheet-head（“状态栏” + #status-pos）
│ │ ├── #status-custom.status-custom（沙箱 iframe 挂载点）
│ │ ├── #status-raw.status-raw（details：原始文本 / HTML 源码）
│ │ ├── #status-history.status-history（details：状态历史）
│ │ └──.status-sheet-foot（#status-prev / #status-next / #status-close.ghost-btn）
│ ├── main#message-area（aria-live=polite；消息流，JS 填充.msg）
│ ├── #typing-indicator.typing.hidden（3 个.dot + #typing-text）
│ ├── #quote-bar.quote-bar.glass.hidden（#quote-text + #quote-cancel）
│ ├── footer#composer
│ │ └──.input-row（#plus-btn.icon-btn.round +.input-shell.glass（textarea#input + #sticker-btn）+ #send-btn.send-btn + #get-reply-btn.reply-btn）
│ └── #auto-row.auto-row（label > input#auto-reply-toggle + span#save-state.save-state）
├── section#view-moments / section#view-manage（另两页，不属聊天页）
├── nav.tabbar.glass#tabbar（.pill#tab-pill + 3 个.tab：对话 / 动态 / 我的；#moments-badge）
├── 11 个.subpage（#sub-persona … #sub-tokens；二级页，z-index:20）
├── #action-sheet.sheet / #sticker-sheet.sheet（底部动作面板）
├── #msg-menu.sheet（长按菜单，现行版：.sheet-card >.sheet-title“消息” + #msg-menu-actions.menu-list + 取消）
├── #modal.modal（通用弹窗）
├── #toast.toast
└── input#file-input.file-input-hidden
```

层级要点（`styles.css`）：

| 层 | 定位 / z-index | 说明 |
|---|---|---|
| `.bg-layer` / `#gl-canvas` | absolute，z 0 / 1 | 背景与玻璃画布 |
| `.views` | relative，z 2 | 三页容器；`.view` 为 absolute inset:0，`.active` 才 flex |
| `#composer` | 文档流内，z 6 | 输入区 |
| `.tabbar` | relative，z 8 | 底部悬浮胶囊导航 |
| `.subpage` | absolute，z 20 | 二级页（translateX 滑入） |
| `.sheet`（action/sticker/msg-menu） | **absolute** inset:0，z 50 | 被 `#app{overflow:hidden}` 裁剪在手机框内 |
| `.status-popup` | **fixed** inset:0，z 60 | ⚠️ 全站唯一 fixed 浮层，定位基准是视口而非 `#app`（见 §⑦） |
| `.modal` | absolute inset:0，z 60 | 通用弹窗 |
| `#toast` | **fixed**，z 100 | 唯一比弹窗更高的层 |

**不一致点（集成时注意）：** 同为全屏浮层，`.sheet`/`.modal` 用 `absolute`（跟 `#app` 走），`.status-popup` 与 `#toast` 用 `fixed`（跟视口走）。桌面端（`@media (min-width:560px)`，`#app` 为居中 430px 圆角卡片、`margin-top:22px`）或 Muse 预览宿主里，fixed 层与 `#app` 错位，这是 §⑦ 溢出的结构性前提。

---

## ② 大号 verweile 字标与宣传文字（只在聊天页移除，主界面保留）

| 元素 | 位置 | 现状 |
|---|---|---|
| `.brand-bar`（`index.html:85`） | `#app` 的直接子节点，**在 `.views` 之外、所有页共用** | 左：`.wordmark` “verweile®”（37px 斜体 Didot/Georgia）；右：`.brand-caption` “잠시, 머물러요 / stay a little longer”。`styles.css`：`padding: calc(22px + safe-area) 25px 18px` |
| `body::before`（`styles.css` 末段） | 全局 fixed 背景水印 | `content:'verweile'`，Georgia 斜体，`clamp(60px,12vw,180px)`，颜色 `#3232320a`，左下角。**不是聊天页专属**，透过壁纸在所有页都可见 |
| `.page-head h1`（Moments / Atelier） | 动态页与管理页各自的页头 | 与聊天页无关，保留 |

**移除范围（只动聊天页）：** `.brand-bar` 这一整行。实现方式只能是“聊天页激活时隐藏”，不能删除节点——因为它在 `.views` 之外、是三页共用的（删除会连动态/管理页的品牌行一起去掉）。例如按 `#view-chat.active` 状态给 `#app` 或 `.brand-bar` 加一个聊天态 class（集成时在 `nav.js` / `app.js` 的切页处接线，见本文末“集成接线点”）。

**附带注意：** `body::before` 的巨型水印字不在聊天页移除之列——它是全局背景装饰，聊天页去掉 `.brand-bar` 后它仍会透过消息区背景隐约可见；如需聊天页完全干净，须另行决定（建议保留，透明度只有 0.04）。

**截图佐证（聊天页现状图 4DE663E2）：** 顶部 “verweile® / 잠시, 머물러요” 一行占了约 90px 高，之下才是 `.chat-head`（头像 + das große Tier + 模拟 + ♥ + ···），两行标题上下叠加，是“精简”要砍的第一刀。

---

## ③ 常驻控制当前所在位置（供集成时移入设置 / 次级入口）

| 控制 | 当前位置 | 代码锚点 |
|---|---|---|
| 常驻大状态条 | 聊天页 `.status-strip#status-strip`（`.chat-head` 之下，`#status-chips` + 展开 chevron） | `index.html` 状态条段；`renderStatusStrip()`（`js/app.js:649`，chips 只放 `summarizeStatus()` 摘要）；点击开状态弹窗（与 `#top-info-btn`、`#status-btn` 同入口） |
| 自动回复开关 | 聊天页底部 `#auto-row` 内 `input#auto-reply-toggle`（iOS 风格小开关，26×16） | `updateHeader()`（`app.js:643`：`localStorage['uwu-chat.autoReply']==='1'`）；change 处理约 `app.js:1802`（写回同一 localStorage 键）；发送后 `app.js:1796` 读该键决定是否自动 `getReply()` |
| API 模式（模拟/真实） | 顶栏 `#mock-badge`（无 key 时显示“模拟”）；真正的 API 设置在管理页二级页 `#sub-api`（API 设置，已有入口） | `updateHeader()`（`app.js:640-642`：`apiSettings.key` 为空则显示）；`apiSettings` 定义 `app.js:58`，持久化 `saveApiSettings()`（`app.js:273`，settings 表 `api` 键） |
| 保存状态（已就绪 / 已保存） | 聊天页底部 `#auto-row` 右侧 `#save-state.save-state` | `setSaveState(t)`（`app.js:119`，只写 `#save-state` 文本）；调用点：`sendUserText` / `sendImageMessage` 后写“已保存”（`app.js:683,698`），模拟回复时写“模拟回复 · 未调用真实 API”（`app.js:1313`） |
| 提示词版本 / 状态模板编辑 | 管理页二级页 `#sub-prompt`（提示词版本）与状态模板表单（`#f-sp-suffix` 等，`app.js:2425-2456`） | 已在设置体系内，**不动**；状态模式切换（新模块 `js/statusMode.js`）的落点应与之一致 |
| 更多入口（现成） | 顶栏 `#chat-menu-btn`（···） | 聊天页已有的溢出入口，移入的控制最适合先收敛到这里或管理页，再决定是否进设置 |

**附带发现（状态条泄漏原始协议）：** 现状截图里状态条第二个 chip 显示为 `[ current h…`——原始状态协议文本漏进了 chip。`renderStatusStrip()`（`app.js:649`）虽经 `summarizeStatus()`（`js/statusBar.js`）处理，但该函数只剥 `^[…:` 形前缀（要求有冒号），`` 这类无冒号的协议头剥不掉。集成精简状态条时应一并修（只留纯文本摘要，协议头整段过滤），不属本轮新模块范围。

---

## ④ 顶栏 / 输入区 / 消息区现状与重复头栏、底栏、嵌套容器检查

### 顶栏（`.chat-head`）

- 现状：文档流内（非悬浮），`margin: 0 18px`，`padding: 11px 13px`，`border-radius: 25px`，玻璃 `.glass`（`styles.css` `.chat-head` 两处规则：基础段 radius 24px / padding 10px 12px，后被 verweile 段覆盖为 25px / 11px 13px）。
- 内容：左 43px 圆角头像（`border-radius:16px`，非正圆）、中部左对齐昵称 + 状态（`.top-info{text-align:left}`，后段覆盖了基础段的居中）、右 “模拟” badge + ♥ + ···。
- **重复头栏检查：聊天页内没有第二个头栏。** 视觉上的“双头”是 `.brand-bar`（§②）+ `.chat-head` 两行叠加，不是重复组件。顶栏本身不是悬浮的：滚动消息时顶栏不跟随，消息从顶栏下方滑过时无羽化（与 iMessage 的绝对悬浮 + 顶部羽化见 §⑥映射表）。

### 输入区（`#composer` + `#auto-row`）

- 现状：`#composer{padding:8px 18px 5px}`，`.input-row` 横向：`#plus-btn`（36×42 透明圆按钮）+ `.input-shell.glass`（flex:1，min-height 47px，radius 24px；内含 `textarea#input` + `#sticker-btn`）+ `#send-btn`（有文字时才显示，38px 深灰圆）/ `#get-reply-btn`（✦，38px，生成中变灰并可点停；`#composer.generating` 时两者互换，`app.js:1282 setGenerating()`）。
- 其下还有 `#auto-row`（自动回复开关 + 保存状态，§③），再下是 `#tabbar`。**底部三行叠加（输入行 / 自动回复行 / Tab 栏）是精简重点，但三者功能不同，不是重复容器。**
- **嵌套容器检查：** `.input-shell` 内只有一层输入框，无嵌套 `.input-wrapper`；`#composer` 与 `#quote-bar`、`#typing-indicator` 为平级兄弟，无多余包裹层。

### 消息区（`#message-area`）

- 现状：`flex:1`，`padding:17px 20px 14px`，`gap:4px`，滚动条隐藏。消息节点由 `createMessageElement()`（`app.js:358`）生成：`.msg(.sent/.received/.continuous/.withdrawn/.system-note)` > `.msg-avatar` + `.msg-body` > `.bubble` / `.card` / `img` 等；另有 `.time-divider` 与 `#load-more-btn.load-more`。
- **无重复消息容器。** 注意：`.view` 本身 `overflow:hidden` + `#message-area` 自滚动，结构干净。

### verweile 自有层 vs 外部宿主层（重点：以下宿主层绝不要写进“待修”）

以两张实机截图为准（截图均为 iPhone 全屏，Dynamic Island 可见）：

| 截图里的层 | 归属 | 判定依据 |
|---|---|---|
| 顶部 iOS 状态栏（时间 12:20/12:21、电量 75、信号、Dynamic Island 黑色药丸） | **系统 / 宿主** | iOS 系统 UI，不在任何项目文件里 |
| 顶部 “UWU 聊天”标题栏 + 左返回圆钮 `<` + 右 `···` 圆钮 | **Muse 预览宿主 chrome** | 不在 `index.html` 里（verweile 没有这个标题栏；`#app` 内最顶是 `.brand-bar`）；是预览容器提供的外层导航 |
| `.brand-bar`（verweile® + 宣传语） | **verweile 自有** | `index.html:85`，见 §② |
| `.chat-head` / `.status-strip` / `#message-area` / `#composer` / `#auto-row` / `#tabbar`（对话/动态/我的，带 `.pill` 滑块） | **verweile 自有** | `index.html` + `styles.css` 均有对应规则 |
| 最底部白色 5 图标胶囊条（💬 / 📄 / 💡 / ✅ / 🔲，第一格高亮） | **Muse 预览宿主 chrome** | 不在 `index.html` 里；两张截图里它都在 verweile `#tabbar` **之下**、且在状态浮层截图里保持白色不透明、盖在 verweile 内容之上；是宿主的底部工具栏 |
| 桌面端 `#app` 外的灰色留白与 46px 圆角手机框阴影 | **宿主 / 浏览器视口** | `styles.css @media (min-width:560px)` 只定义 `#app` 自身的尺寸与圆角，框外区域不属于应用 |

**结论：** 待修清单只含 verweile 自有层。宿主的顶栏标题与底部 5 图标条、iOS 状态栏，在任何情况下都不应作为 bug 或精简目标。

---

## ⑤ 消息分组现状

- **已分组（逻辑层有，视觉层半套）：**
- `renderMessages()`（`app.js:581-622`）与 `appendMessageElement()`（`app.js:623`）：同角色且间隔 `< 10 分钟` → `continuous=true`，`createMessageElement()`（`app.js:358`）给 `.msg` 加 `.continuous`。
- 连续消息：对方头像只留首条（`.msg-avatar.invisible`，`visibility:hidden` 占位）、气泡上圆角收小（`.msg.continuous.bubble{border-top-left-radius:6px}`；我方 `border-top-right-radius:6px`，`styles.css` 基础段 + verweile 段）。
- 时间分隔：间隔 `> 10 分钟` 或跨天 → 插入 `.time-divider`（`renderTimeDivider()`，`app.js:326`；文案如 “11月19日 22:24”，见现状截图）。
- **缺失 / 重复：**
- **无尾巴：** 任何气泡都没有小尾巴（只有圆角变化：首条 19px / 连续 6px 的直角切法）。iMessage 的 mask 尾巴（组内仅最后一只带尾巴）尚未实现——verweile 的 `.continuous` 标记的是“非首条”，而尾巴规则需要“非末条”，两者互补，集成时需补一个“组末”判定（见 §⑥）。
- **头像重复情况：** 我方消息头像恒隐藏（`.msg.sent.msg-avatar{display:none}`，且 `.msg.sent{padding-left:35px}` 补位）；对方连续消息头像占位隐藏、不重复显示。头像本身不重复。
- **时间重复情况：** 每条消息无独立时间戳（只有 `msg.edited` 时的 `.msg-meta`“已编辑”）；时间只在 `.time-divider` 出现一次，不重复。但**没有“组内时间只显示一次”的显式规则之外的东西**——现状就是干净的。
- **气泡间距：** `.msg{margin:4px 0}` + `#message-area{gap:4px}`；iMessage 组内 `margin-bottom:2px`（见 §⑥），verweile 组内组间间距目前无区分（连续与换组同为 4px + gap 4px）。

---

## ⑥ iMessage 迁移映射表（verweile 真实选择器 → iMessage 视觉）

iMessage 文件针对原始 UWU 的 DOM（`#chat-room-screen`、`.message-wrapper.sent/.received`、`#chat-room-header-default`、`.chat-input-wrapper`），**只迁移视觉思路，不粘贴旧选择器**。蓝色不照搬：默认黑白灰（我方气泡深灰、对方气泡浅灰，按明暗壁纸自适应——现行 `--bubble-me/--bubble-ai` 由 `js/theme.js applyVars()` 按主题推导，见表末行）。

| # | iMessage 视觉（文件行号） | verweile 真实选择器 | 现状数值 → 目标数值 / 做法 |
|---|---|---|---|
| 1 | 气泡紧凑：`padding:7px 14px`、`border-radius:17.5px`、`line-height:1.4`（文件 L138-151） | `.bubble`（`styles.css` 基础段 + verweile 段覆盖） | 现状 `padding:10px 13px`、radius `19px`、line-height `1.65` → 改为 7px 14px / 17.5px / 1.4。注意 verweile 段后覆盖了基础段，改时两处都要对齐 |
| 2 | mask 尾巴 24×21，组内仅最后一只带尾巴（L154-182 尾巴 mask；L232-234 `:has(+ 同角色)` 时 `--img-tail` 置空） | `.bubble` + `.msg`（`app.js:358 createMessageElement`） | 现状无尾巴。尾巴应做在 `.bubble::before` 的 mask 层（与 Bublab 的 mask 尾巴同原理），组末判定用 CSS `:has(+.msg 同角色)` 或 JS 在 `renderMessages`/`appendMessageElement` 里补 `.group-last` class。**注意 verweile 的 `.continuous` 标的是“非首条”，尾巴要的是“非末条”，方向相反，不能直接复用** |
| 3 | 边缘高光：`::after` 四角描边 mask + `linear-gradient(145deg, rgba(255,255,255,.42), rgba(255,255,255,.23) 48%, …)`（L187-218，仅 received） | `.bubble::after`（目前无此伪元素） | 新增一层高光即可；颜色按黑白灰换算（亮壁纸用白高光、暗壁纸用浅灰高光），不要照搬原文件的 `.42/.23` 白值到深色气泡上 |
| 4 | 顶栏绝对悬浮 + 顶部羽化模糊：`#chat-room-header-default{position:absolute; height:nav-top+95px}`，`::before` 羽化层 `blur(16px)` + mask 渐变 `linear-gradient(to bottom,#000 0%,#000 28%,rgba(0,0,0,.72) 46%,rgba(0,0,0,.30) 70%,transparent 100%)`，羽化高 `nav-top+122px`（L246-270、L540-563）；消息区 `padding-top:nav-top+104px` | `.chat-head`（`index.html` 顶栏；现为文档流内）+ `#message-area` | 现状顶栏不悬浮、无羽化。迁移：`.chat-head` 改为 absolute 悬浮于 `#view-chat` 顶部（或 sticky），补一层羽化伪元素；`#message-area` 顶部 padding 相应抬高（现 17px → 约顶栏高 + 间距）。**顶栏玻璃不要手写假玻璃**：复用 `js/liquidGlass.js` 的 `LiquidGlass` 引擎（单 WebGL 上下文，`.glass` 元素由引擎接管；见该文件头注释），CSS `backdrop-filter` 只作降级 |
| 5 | 返回玻璃胶囊 82×44（L278-285，`--lg3-pill-bg` 液态玻璃背景） | 无直接对应物（verweile 聊天页无返回按钮；返回靠宿主顶栏或 Tab 切换） | **尺寸可参考，按钮本身不新增**：如精简后顶栏要加返回，胶囊 82×44 + `--lg3-pill-bg` 思路可复用；不要为它新建一个“返回”入口 |
| 6 | 中央圆头像 58px（`#char-status-btn`，L353-371，头像即按钮） | `img#char-avatar.top-avatar`（现 43px，圆角 16px 方形）+ `button#top-info-btn` | 头像 43px → 58px 正圆（`border-radius:50%`），并与昵称胶囊居中排布；iMessage 里头像本身就是状态按钮，verweile 已有 `#top-info-btn` / `#status-btn` 两个状态入口，集成时应合并为一个（头像即入口），避免三入口并存 |
| 7 | 昵称玻璃胶囊：`::after` 高 31px、`padding:0 31px 0 13px`、radius 22px、液态玻璃（L506-539；内容为 `"Maybe: {{char_remark}}"`） | `button#top-info-btn.top-info`（现为无背景透明按钮，昵称左对齐） | 昵称改为居中玻璃胶囊（31px 高、radius 22px）；**内容只取角色名（`#char-name`），不要照搬 `"Maybe:"` 前缀** |
| 8 | 右侧圆按钮组（`.action-btn`，44px 圆，`--lg3-circle-bg`） | `#status-btn` / `#chat-menu-btn`（现 36×40 透明 `.icon-btn`） | 统一为 44px 玻璃圆按钮；玻璃走 `LiquidGlass` 引擎，CSS 只留降级 |
| 9 | 输入区悬浮玻璃胶囊：`.message-input-area::before` 胶囊 `left:68px right:16px`、radius 28px、`--lg3-pill-bg`；输入框 44px 高（L582-700）；`.chat-input-wrapper{margin:-60px 0 0}` 上叠 | `footer#composer` > `.input-row` > `.input-shell.glass`（现 min-height 47px、radius 24px、margin 左右 18px） | 输入壳改为悬浮玻璃胶囊（radius 28px，左右留出 `+` 与发送按钮的位置）；`#plus-btn` 保持在胶囊外左侧（对应 iMessage 的 68px 左偏移思路）。`#composer` 本身不动容器，只改视觉 |
| 10 | 思考气泡三点动画：64×38 气泡 + SVG 三点（`--imc-typing-*`，L40-47） | `#typing-indicator.typing`（现为行内 3 个 `.dot` + CSS `blink` 动画 + 文字“正在输入中…”） | 目标：去掉文字，改为 64×38 玻璃气泡 + 三点动画；动画可用现行 CSS 点（已有 `@keyframes blink`），形状按 iMessage 的气泡收 |
| 11 | 语音波形 SVG 116×28（`--imv-wave`，L85） | `.voice-card` / `.voice-wave`（现为 JS 生成的 `i` 竖条，`app.js:490-492`；截图里 28″ 语音卡片即此物） | 波形视觉可对齐为等宽竖条 SVG 化，但现行 div 竖条已可用；**低优先级**，不阻塞精简 |
| 12 | 组内间距 `margin-bottom:2px`（L228-230） | `.msg{margin:4px 0}` + `#message-area{gap:4px}` | 组内 2px、组间加大（用 `.msg:not(.continuous)` 的上间距区分），替代现在的一刀切 4px |
| 13 | 颜色：我方 `rgba(0,153,255,.72)`、对方 `rgba(57,65,72,.46)`（L6-7） | `:root` 的 `--bubble-me: rgba(221,221,221,.35)` / `--bubble-ai: rgba(255,255,255,.22)`，由 `js/theme.js applyVars()` 按明暗主题推导（`--bubble-me-solid` 等） | **蓝色不迁移**。沿用主题变量：浅色壁纸我方深灰、对方浅灰；暗色壁纸由 `theme.js` 的 `contrastInk()` / `hexA()` 推导反色，气泡文字色 `--bubble-me-ink` / `--bubble-ai-ink` 跟着走 |

### 不适用的 iMessage 元素（明确不迁移）

| 元素 | 原因 |
|---|---|
| 返回胶囊里的 `"214"` 计数（`.back-btn::after{content:"214"}`，L320-321） | 原项目 UWU 的消息计数，与 verweile 无关，绝不照搬数字 |
| 视频按钮（`--imc-video`，L24） | verweile 无视频通话入口 |
| Apple Cash（`--imcash-*`，L108-115：转账宽度 210px、金额 42px、Apple 标志） | verweile 转账卡片是自有 `.transfer-card`（`app.js:515`），已有实现，不套 iMessage 的现金样式 |
| 翻译配色（`--imt-*`：白字 + 黑描边，L117-122） | verweile 已有 `.translation` / `.toggle-t`（虚线分隔 + 折叠），只对齐间距，不改配色体系 |
| 文字图片叠图（`--imx-front/back1-3`，外链图床 URL） | 外链图片 + 原项目专属排版，不迁移；verweile 图片用 `.photo-img`（230px 上限） |
| `title-container{opacity:0}` 的隐藏式标题（L501-504） | 原项目把旧标题藏起来再用 `::after` 重画昵称；verweile 没有这个旧标题容器，不需要“藏标题再重画”的绕路 |
| `chat-room-header-default` 的 `height:nav-top+95px` 数值本身 | 原项目顶栏含 58px 头像 + 昵称胶囊两行；verweile 精简后的顶栏高度应按自己的头像 + 胶囊实测定，不要硬套 95px |

---

## ⑦ 状态浮层三处溢出 bug 的根因定位

截图：`34D20951…photo-622302A7…`（状态浮层打开态）。图中所见：白色 Instagram 风格卡片（头像 das große Tier、♡45 💬2 🔄0 ➤1、底部站内导航胶囊）是**状态模板渲染出的 HTML 内容本身**（`#status-custom` 内的沙箱 iframe），不是聊天消息；其下方依次是 “▶ 原始文本 / HTML 源码 / ▶ 状态历史（1）” 三个 details、“自动回复 已就绪”行，以及与 Tab 栏重叠的 “‹ 上一个 / 下一个 › / 关闭”。

### Bug 1：卡片穿出容器（白卡上沿盖住 verweile 字标、左右顶出手机框）

**推断根因（置信度：中高）：**

1. `.status-sheet` 定宽越界：`styles.css:198` `.status-sheet{width:100%; max-width:520px; …}`——520px 大于 `#app` 的 430px 上限；`.status-popup` 是 `position:fixed; inset:0`（`styles.css:196`），定位基准是**视口**而非 `#app`。在 Muse 预览宿主里视口宽于 `#app`（或桌面端 `#app` 为居中卡片）时，sheet 按视口居中、按 `100%` 定宽，左右两边顶出 `#app`，白卡上沿随之压住 `.brand-bar` 的 verweile 字标（截图里字标下半被白卡盖住、♡45 计数行骑在卡片与 sheet 的边界上）。
2. iframe 内容夹不住：模板是一份完整 HTML 文档（自带固定宽度、圆角、内部底部导航胶囊）。`js/statusBar.js` 的 `STATUS_FRAME_CSS` 只约束 `body>*{max-width:100%!important}`，夹不住 `html/body` 自身、写死宽度（`width:100vw` / `min-width`）或绝对定位的模板内部元素。
3. 高度上报失真：`renderStatusPopup()`（`app.js:1916` 起）先给 iframe `height:120px` 占位，再等 `STATUS_HEIGHT_MSG`（`app.js:1819-1834`，夹在 24–6000px）设定实高；`STATUS_FRAME_SCRIPT`（`statusBar.js`）取 body 子元素 rect 的最大值。模板用绝对定位 / 负边距 / 图片后加载时，高度会被低估或事后变大，iframe 内容视觉上顶出 sheet 上沿。

**修复方向（集成轮）：** sheet 改为以 `#app` 为定位基准（`absolute` 而非 `fixed`，与 `.sheet`/`.modal` 一致）且 `max-width` 不超过 `#app` 内容宽；`STATUS_FRAME_CSS` 追加 `html,body{max-width:100%}` 与对绝对定位子元素的约束；高度上报失败时给 iframe 一个带内部滚动的上限而非任其撑大。

### Bug 2：底栏压住卡片（Tab 栏 / 输入区从半透明 sheet 下透出来，压在卡片底部）

**推断根因（置信度：高）：**

1. sheet 底缘落在 Tab 栏带上：`.status-sheet{max-height:78vh; overflow-y:auto}`（`styles.css:198`）+ `.status-popup{padding: … 16px calc(16px + safe-area)}`（`:196`）。sheet 内容 = iframe（高度可达 6000px 上限）+ 三个 details + footer，顶到 78vh 上限时 sheet 底缘离视口底只剩约 11vh——正好是 `#tabbar`（`margin:10px 38px calc(18px + safe-area)`，自身约 60px 高，`z-index:8`）与 `#composer` / `#auto-row` 所在的纵带。
2. 层叠上 popup 赢了，但视觉上输了：`.status-popup{z-index:60}` 确实在 Tab 栏之上，但 `.status-sheet.glass` 的背景只有 `rgba(255,255,255,.06)` + 6px 模糊（`styles.css:106`），几乎透明；底下的 Tab 栏（对话/动态/我的）与输入框（“Write something…”）直接透过 sheet 显示出来，截图里两者在同一纵带重叠，看起来就是“底栏压住卡片”。
3. `position:fixed` 的 `78vh` 以视口高为准，不以 `#app` 高为准；键盘弹起或宿主视口变化时，vh 基准与 `#app`（`100dvh`）脱节，底缘位置进一步漂移。

**修复方向（集成轮）：** popup 底缘给 Tab 栏留出避让（`padding-bottom` 至少为 Tab 栏高 + 间距，或 sheet 改为 `bottom`-anchored 的底部抽屉）；sheet 背景加不透明度（或 `backdrop-filter` 加强），不让底层导航透出来；高度上限改按 `#app` 内容高算。

### Bug 3：关闭按钮与导航重叠（“关闭”二字压在 Tab 栏“我的”图标上）

**推断根因（置信度：高）：**

1. footer 本身无底色、无避让：`.status-sheet-foot{display:flex; gap:4px; justify-content:space-between; margin-top:10px; padding-top:8px; border-top:1px solid …}`（`styles.css:200`），三个 `.ghost-btn` 是**透明底**（`background:transparent; border:0`，`:201`），只有文字；`#status-close` 仅加粗、无独立背景。footer 贴在 sheet 最底部，而 sheet 底缘已落在 Tab 栏带上（Bug 2），三个透明文字按钮就直接叠在 Tab 栏的玻璃与图标/文字上——截图里 “关闭” 正压在 “我的” 上方，“‹ 上一个” 与 “对话” 重叠。
2. 无最小底部间距：`.status-popup` 的 `padding-bottom:calc(16px + safe-area-inset-bottom)` 没有为 `#tabbar` 预留高度；sheet 又是 `align-items:center` 居中，内容一高、底缘就下探到导航区，没有任何机制把它顶回去。

**修复方向（集成轮）：** footer 改为 sticky 在 sheet 底部并带实底色/毛玻璃；或把 “上一个 / 下一个 / 关闭” 移出 sheet 流、改为 sheet 顶部的独立关闭钮（`×`，iOS 式）；popup 的底部 padding 至少覆盖 Tab 栏高度 + 安全区。

### 三 bug 的共同结构原因

`.status-popup` 是全站唯一用 `position:fixed` 的浮层（`.sheet`/`.modal` 均为 `absolute`，跟 `#app` 走），而 `#app` 在预览宿主/桌面端并不是全视口。**定位基准不一致**是三处溢出的共同根子；单修某一条数值（改 max-width、改 78vh）只能缓解其一。建议集成轮把 popup 改为与其它浮层一致的 `absolute` + 以 `#app` 为 containing block，再按上面三条分别收口。

---

## 附：集成接线点（供下一轮直接用，精确到函数 / id / class）

> 本轮只新增了独立模块（`js/longPressMenu.js`、`js/innerVoice.js`、`js/statusMode.js`、`js/chatDaily.js`，见子代理汇报），以下接线均未实施。

| 目标 | 接线位置 | 要改的行意 |
|---|---|---|
| 聊天页隐藏品牌行 | `index.html:85` `.brand-bar`；切页逻辑（`js/nav.js` 或 `app.js` 的视图切换处） | 视图切到 `#view-chat` 时给 `#app` 加 `.in-chat` class；`styles.css` 加 `.in-chat.brand-bar{display:none}`。不动节点、不动其它页 |
| 控制移入设置 | `index.html` `#status-strip`、`#auto-row`（`#auto-reply-toggle`、`#save-state`）；`app.js:643 updateHeader()`、`app.js:119 setSaveState()`、`app.js:1796/1802` 自动回复读写 | 状态条改为仅在有内容时以紧凑 chip 显示或收进 `#chat-menu-btn`；自动回复开关与保存状态移入管理页 / `#sub-api` 附近；`updateHeader()` 与 `setSaveState()` 的目标节点随之改 |
| 气泡紧凑 + 尾巴 | `styles.css` `.bubble` 两处规则（基础段 + verweile 段）；`app.js:358 createMessageElement` / `app.js:581 renderMessages` / `app.js:623 appendMessageElement` | 数值按 §⑥表第 1/2/12 行；尾巴用 `.bubble::before` mask + 组末判定（CSS `:has()` 或 JS 补 `.group-last`） |
| 顶栏悬浮 + 羽化 | `styles.css` `.chat-head`；`index.html` `.chat-head`；`js/liquidGlass.js` `LiquidGlass`（引擎已支持 `.glass` 元素注册） | `.chat-head` 改 absolute 悬浮 + 羽化伪元素；`#message-area` 顶部 padding 抬高；玻璃走引擎，CSS 只留降级 |
| 长按菜单替换 | `app.js:347 attachMsgMenu()`（现行 480ms 长按 + `contextmenu`）与 `app.js:1640 openMsgMenu()`（现行底部 `.sheet` 菜单，`x/y` 参数被 `void` 丢弃） | `attachMsgMenu` 改调 `LongPressMenu.attachTo()`；`openMsgMenu` 改为 `LongPressMenu.open()` 的回调实现；删除改走 `createDeleteToken` + toast 撤销；`index.html:242 #msg-menu` 可退役（保留至集成完成再删） |
| 心声解析 | `app.js` 的回复落盘处（`getReply()` / `handleRegenerate()` 附近，`app.js:1296/1594`）与 `renderMessageContent()`（`app.js:397`） | 助理文本入库/渲染前过 `parseInnerVoice()`：正文存 `cleanContent`，心声另存 `msg.innerVoice`（`inner` 模式才展示）；**不要读 reasoning/thinking 字段** |
| 状态模式 | `app.js` 提示词组装处（`promptBuilder.js:557 statusSuffix`）与角色编辑表单（`app.js:2425` 状态模板保存） | 按 `getStatusMode(char)` 选指令：concise 不注入、inner 注入 `innerVoicePrompt`、html 沿用现有 `statusPanel.promptSuffix`；模式存 `char.statusMode`，切换只改该字段 |
| 草稿 / 阅读位置 / 重试 / 生成恢复 | `app.js` 输入区（`#input` 输入监听、`sendUserText` `app.js:668`）、`renderMessages` / `appendMessageElement` 的滚动处（`app.js:581/623`，现行无条件 `scrollTop = scrollHeight`）、`isGenerating`（`app.js:90`）与 `setGenerating()`（`app.js:1282`） | 草稿用 `chatDaily` 的 `draftKey` + 防抖保存；新消息到达时用 `decideNewMessageDisplay()` 决定是否拉底；失败消息用 `markFailed` / `retryMessage`（同 `messageId`）；启动时 `recoverInterruptedMessages()` 把残留 generating 置为 interrupted，不自动续生成 |
| 状态浮层溢出 | `styles.css:196-201`（`.status-popup` / `.status-sheet` / `.status-sheet-foot` / `.ghost-btn`）；`app.js:1916 renderStatusPopup()`；`js/statusBar.js` `STATUS_FRAME_CSS` | 见 §⑦各条修复方向；先改定位基准（fixed → absolute），再收 max-width / 底缘避让 / footer 实底 |
