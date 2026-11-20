# UWU 迁移对照表（第一阶段）

源码位置：`~/workspace/uwu-chat`（React 之外的纯静态站，ES modules，无构建依赖）。
预览：artifact `uwu-liao-tian`（UWU 聊天）。参考源码：`uwu_reference/`（随备份压缩包提供）。

## 一、复用的函数与规则

| 参考源码 | 迁移后位置 | 说明 |
|---|---|---|
| `chat_ai_prompt.js` `generatePrivateSystemPrompt`（TT 分支） | `js/promptTemplates.js` `buildTTPrompt`、`js/promptBuilder.js` `buildSystemPrompt` | TT 模板原文迁移，仅裁剪未实现能力（见第三部分）；占位符、共同回忆、双语、回复节奏、反重复措辞保留 |
| `chat_ai_prompt.js` 默认 UWU 分支 | `js/promptTemplates.js` `buildUWUPrompt` | 同上；无占位符、无共同回忆段 |
| `chat_ai_prompt.js` `countTextTokens` / `calculateTokenBreakdown` | `js/utils.js` `countTextTokens` | 估算口径不变；预览里明确标为“估算” |
| `utils.js` `filterHistoryForAI`（去重、去 thinking、去上下文禁用） | `js/historyBuilder.js` `filterHistoryForRequest` | 同名角色相邻合并、时间标记、引用序列化、撤回占位、排除 `isContextDisabled` 与内部推理 |
| `utils.js` `buildChatApiRequest`（`/v1` 处理） | `js/providerAdapter.js` `resolveOpenAIEndpoint` | 完整 URL 优先，不重复拼接 `/v1`；`api522/521/520.pro` 屏蔽保留 |
| `utils.js` `fetchAiResponse` / `readStreamResponse` | `js/sse.js` `createSSEParser` + `js/providerAdapter.js` `sendChat` | 真实 SSE 事件缓冲；拆分 UTF-8 字符、跨 chunk JSON、协议片段、`[DONE]`、非流式 JSON、错误 HTML 均处理 |
| `utils.js` `compressImage` | `js/app.js` `compressImageFile` | 最长边 1024、JPEG 0.8；GIF 直通（保动画） |
| `chat_ai.js` `getAiReply` 上下文组装 | `js/historyBuilder.js` `buildRequest` / `toOpenAIMessages` / `toGeminiContents` | 旧历史进 `<chat_history>`、最新一轮进 `<user_input>`，各恰好一次；Gemini 走独立分支，不混 OpenAI 格式 |
| `chat_ai.js` `handleAiReplyContent` | `js/app.js` `handleAiReplyContent` / `applySegment` | 按段解析、同一 roundId 共享、撤回 2 秒后翻转、转账/礼物隐藏指令执行状态不显示气泡 |
| `chat_ai.js` `handleRegenerate` | `js/app.js` `handleRegenerate` | 按轮替换，旧轮进“被替换的回复”可恢复，不删用户消息 |
| `chat_render.js` 分页（MESSAGES_PER_PAGE=50） | `js/storage.js` `PAGE_SIZE = 50` + `js/app.js` `renderMessages` | 默认加载最新 50 条，向上加载更早并保持滚动位置 |
| `chat_render.js` 双语气泡解析「」+（）兜底 | `js/replyParser.js` `parseBilingual` | 原文与译文分开展示，复制/编辑不破坏协议 |
| `chat_ops.js` 长按菜单、编辑、引用、2 分钟撤回 | `js/app.js` `openMsgMenu` / `startEditMessage` / `withdrawMessage` | 撤回仅限本人消息、2 分钟内；撤回后保留占位、清收藏、禁编辑/引用/收藏 |
| `chat_features.js` 语音/照片/转账/礼物格式 | `js/replyParser.js` 协议解析 + `js/app.js` 卡片渲染 | 语音文字卡、照片描述卡、转账/礼物轻量卡（接受/退回，无真实支付） |
| `worldbook.js` 四位置 + depth 排序 | `js/promptBuilder.js` `collectWorldBooks` | `limit_break` / `before` / `after` / `guidelines` 各自按 depth 排序；无关键词触发引擎（源码里也没有） |
| `journal.js` `memoryJournals`（isFavorited） | `js/storage.js` journals 表 + `js/promptBuilder.js` `collectFavoritedJournals` | 仅已收藏的记忆进提示词；来源保留 |
| `settings_api.js` 预设、副 API | `js/app.js` 设置 → API | 预设不含 Key；导入的 apiSettings 只保存非 Key 字段待确认，不自动应用 |
| `db.js` Dexie 分表 | `js/storage.js` `IDBBackend` | characters / worldBooks / stickers / journals / messages / attachments / statusTemplates / settings / unknown；消息增量写，绝不整库重序列化 |

## 二、对旧行为的有意修正（不是照搬 bug）

| # | 旧行为 | 本阶段做法 | 依据 |
|---|---|---|---|
| 1 | `filterHistoryForAI` 丢弃没有 `statusSnapshot` 的 `isStatusUpdate` 记录 | 无快照的状态消息保留原文，缺模板时回退到当前模板或纯文本显示 | 指令 §七明确要求不复制该行为 |
| 2 | 状态栏 regex 从普通消息正文里剥离 | 只对 AI 回复段应用状态栏正则匹配，普通消息正文不再被剥离 | 避免误删用户正文 |
| 3 | 未知表情包名静默剔除 | 未知名称回退为文字 `[表情包：名字]`，不显示破图 | 指令要求未知名称 → 文本回退 |
| 4 | 空历史时仍输出空 `<chat_history></chat_history>` | 空历史时移除占位符，不输出空标签 | 避免模型收到无意义空标签 |
| 5 | 纯文本被包成 `[unknown的消息：…]` | 纯文本保持为可读文本 | 不伪造协议包装 |
| 6 | `replyCount` 默认 1–6 | TT 分支用备份实际生效值 3–8（`replyCountMin/Max`），缺省也为 3–8 | 备份 `cotSettings` 的实际生效配置 |
| 7 | `maxMemory` 字符串 `'80'` | 解析并校验为数字 80 | 同上 |
| 8 | `cotSettings.enabled=false` 但代码仍可能注入 CoT / prefill | 本阶段永不注入 CoT、`[incipere]`、assistant prefill；模型输出的 `<thinking>` 只取其后可见部分 | 备份实际生效配置 + 指令要求 |
| 9 | 同毫秒连发的消息在 IndexedDB `[charId, timestamp]` 索引下可能乱序 | 预览用全局递增 seq 索引修复；源码用单调递增时间戳（`nextTs()`）达到同等效果。导入的旧消息若时间戳相同，仍按原有顺序显示 | 预览实测发现（连发 3 条同毫秒乱序），已复验通过 |
| 10 | 导入只认 gzip 一种格式，解压只靠 `DecompressionStream`，且 `handleImportFile` 里 `gunzipText(buf)`、`doExport` 里 `gzipBytes(json)` 都漏了 `await`（gzip 的 `.ee` 在源码侧导入导出都会失败） | 按文件实际内容识别 gzip / zlib / ZIP 包 / UTF-16 / base64 包装；原生解压失败时降级到纯 JS DEFLATE 解码（RFC 1951）；`normalizeBackup` 增加 Dexie 导出、顶层消息表、角色 `messages` 字段、纯消息数组四种结构；补上两个缺失的 `await`，`.ee` 导出在无压缩环境下降级为 JSON；导入页增加拖放、粘贴 JSON、失败诊断（文件名/大小/文件头/错误） | Dolores 2026-11-20 上午报「导不进 .ee 备份」后先在预览修好，源码侧同日回填；新增 `tests/import-decode.test.mjs` 9 项（与 Node zlib 互通的纯 JS inflate、gzip 文件名头、ZIP stored/deflate、UTF-16、base64、Dexie 归组），`npm test` 38/38 通过，`dist/` 已重建并通过 `node --check` |
| 11 | 默认导出会带出 API Key：`stripKeys` 的正则只认 `apiKey` / `api_key`，而 `apiSettings` 里的字段名就是裸 `key`，不在正则里，`exportAll` 直接把 `settings.value`（含 Key）塞进导出文件 | `stripKeys` 增加裸 `^key$` 匹配；`exportAll` 在 `includeKeys=false` 时显式删掉 `apiSettings.key` 与各预设的 `key`（双重保障）；新增测试：默认导出 JSON 里不出现测试 Key，勾选含 Key 才出现 | Dolores 2026-11-20 要求真实聊天验证时审计发现；`tests/verify-phase1.test.mjs` 第 1 项 |
| 12 | 导入的 `cotSettings` 只被解析、从不保存，界面三处写死 `promptVersion='tt'`：备份里若是 `uwu` 也会被无视，谈不上“沿用导入设置” | `importNormalized` 把导入的 `cotSettings` 存进 settings 表（`normalizeBackup` 另补 `globalSettings.cotSettings` 兜底）；`loadAll` 读回 `globalSettings`；四处写死值全部改为传入加载后的 `globalSettings`；角色页提示与生效版本改为按 `resolvePromptVersion` 动态显示 | 同上；`tests/verify-phase1.test.mjs` 第 3 项（导入 uwu 生效、角色专属优先、缺省 tt、CoT/prefill 永不注入） |
| 13 | 「本次发送内容预览」与 Get Reply 各自重新构建一次请求：代码路径相同但不是同一份结果，历史在两者之间变化时预览与实际请求会不一致 | 新增 `buildCurrentRequest()`：按历史（尾部 maxMemory 条的 id/updatedAt）+ 角色设定 + 世界书/表情包 + API 选项算签名，未变时直接复用上一次的构建对象；预览与 Get Reply 都走它，预览里显示“复用 / 新构建” | 同上；预览与请求共享同一份构建结果的要求 |
| 14 | 应用 API 预设时 `apiSettings = {...apiSettings, ...p}`：预设保存时 `key` 是 `undefined`，展开会把已保存的 Key 抹成 `undefined`，等于悄悄清掉密钥 | 应用预设前先去掉预设里的 `key` 字段再展开，保留当前 Key | 同上；代码审计发现 |
| 15 | 内置自检断言写错：用全是用户消息的历史断言 `chat_history` 出现 1 次，但按正确行为（修正 #4），没有更早历史时占位应被去掉，该是 0 次 | 自检历史前加一条对方消息，`chat_history` 断言恢复为 1 次；另加一条：只有最新一轮时 `chat_history` 为 0 次 | 同上；`tests/verify-phase1.test.mjs` 第 5 项同步覆盖了两种情形 |
| 16 | 第一阶段单角色聊天 UI（`#settings` 浮层 + 顶部标签页）与原型重设计不一致；旧社交应用 UI 只在预览存在，从未进源码 | 按 Dolores 批准的原型（`uwu-liao-tian-ui-yuan-xing`，经轻量化与亮度修正）把源码 UI 重构为三页：聊天 / 动态 / 管理。聊天保留全部真实逻辑（IndexedDB、API、导入导出、提示词、消息操作、Enter 发送 + 输入法组字保护）；动态只做视觉原型（虚拟数据，未接真实数据）；管理按二级页重组（人设、世界书、提示词、贴纸、记忆、上下文预览、API、MCP、数据管理、外观与背景、设计变量），除动态与 MCP 外全部接真实设置库。新增 `js/liquidGlass.js`（WebGL 液态玻璃引擎，单上下文 + CSS 降级）、`js/theme.js`（背景切换/文字气泡配色/玻璃参数，存 settings 表 `appearance`，不随备份导出）、`js/moments.js`、`js/nav.js`、`js/manage.js`；`styles.css` 按原型 `:root` 变量整版重写；`js/app.js` 只做手术式改动（新组件初始化、二级页设置、状态条、长按 480ms、模拟回复加 `模拟回复` 标记、语音卡片播放按钮+波形条、转账/礼物渐变卡）。亮度修正后的轻默认值全部保留（光强 55%、tint 2%、边缘辉光上限 0.45、亮度硬钳制 +0.10/−0.16、AI 气泡 62% 透明、遮罩 32%、玻璃模糊 8px、着色器透明度 mask×0.52），不回退到早期厚重版。背景预设为 Canvas 渐变重绘（原型照片素材未拷入源码，上传入口可接 Dolores 自己的图）。旧社交应用 UI 被本轮重设计取代，不移植；焦糖布丁底栏不引入（原型用 iOS 26 悬浮胶囊栏）；贴纸气泡功能保持删除（Dolores 2026-11-18 明确要求） | Dolores 2026-11-20 批准原型设计并要求打包进源码；`tests/theme.test.mjs` 8 项（默认值、色板、参数映射、着色器亮度修正、CSS 轻默认值），`npm test` 55/55 通过；`dist/` 已重建并通过 `node --check`；无头 Chromium 实测 `dist/index.html`：启动、聊天/动态/管理三页切换、人设/外观/上下文预览二级页、Enter 发送、模拟 Get Reply（2 气泡 + `模拟回复` 标记）、背景切换生效，0 控制台错误 |

## 三、未实现的能力（留待后续，不冒充已完成）

| 能力 | 状态 |
|---|---|
| 向量记忆检索（`memoryMode='vector'`） | 数据与扩展接口已保留：`relatedMemories` 结构化输入（默认空）、`unknown` 表保存向量条目与模板绑定，标记“待接入”；记忆页明确标注“向量检索尚未接入” |
| 小动态（moments） | 未实现；TT 模板里相关能力描述已裁剪，提示词能力清单与前端实际能力一致 |
| MCP | 仅保留模块边界，界面无入口按钮 |
| 语音录音 / TTS | 未实现；只有语音文字卡（文字 + 展开） |
| AI 真实照片 / 视频 | 不做；只有“照片/视频描述卡” |
| 电话 / 通话、商城 / 代付 / 下单、转发聊天记录渲染 | 未实现；历史里出现时显示可读占位卡，保留原始数据不删除 |
| HTML 模块消息 | 未实现；显示为文字占位卡（可展开看原始内容） |

## 四、数据与存储

- IndexedDB 库名 `uwu-chat-db`（v1），分表见上；localStorage 只放微小偏好（`uwu-chat.lastChar`、自动回复开关）。
- 状态模板去重：同一 `{regexPattern, replacePattern}` 只存一份实体（`statusTemplates` 表，`templateIdFor` 哈希），消息只存 `templateId` / `templateVersion` / 原文。
- 导入导出：JSON 与 gzip / zlib / ZIP / UTF-16 / base64 包装的 `.ee`，按文件实际内容（魔数）识别格式，不看扩展名；无 `DecompressionStream` 的旧浏览器用纯 JS DEFLATE 解码兜底；Dexie 导出、顶层消息表、角色 `messages` 字段、纯消息数组四种备份结构都能归组导入；导入先预览数量、可选主角色、合并/替换由用户选；保留原始 ID、时间戳、顺序、引用、parts、记忆来源、世界书绑定；重复导入按稳定 ID 判定并出冲突报告，不按相同文本/时间去重；无 ID 记录用哈希生成稳定 ID；未知字段原样保存进 `unknown` 表并标记“待接入”；默认导出不含 Key，含 Key 的私人备份需明确勾选。
- 示例数据：未导入备份时内置一个可删除的示例角色、1 本世界书、1 条收藏记忆、2 个表情包、2 条欢迎消息，明确标注为示例。

## 五、验证结果（本阶段）

- 单元测试：`npm test` → **55/55 通过**（47 项 + 新增 `tests/theme.test.mjs` 8 项：`contrastInk`/`hexA`、亮度修正后的轻默认值、色板、主题值到 WebGL 参数的映射、`LiquidGlass.DEFAULT_PARAMS`、着色器亮度硬钳制/边缘辉光上限/透明度 0.52、CSS 轻默认值且无 32px 大阴影）。
- 预览浏览器实测（2026-11-20，artifact `uwu-liao-tian`）：连发 3 条消息只点一次 Get Reply，顺序正确，多气泡模拟回复带「模拟」标记；刷新后消息按顺序完整恢复（实测中发现同毫秒消息在 IndexedDB 时间戳索引下乱序，已用 seq 索引修复并复验；源码侧用单调递增时间戳 `nextTs()` 同步了这一修复，见上表第 9 条）；请求预览显示 TT 基线、动态注入的时间/名称、`<chat_history>` 与 `<user_input>` 结构和估算 token；内置自检 11/11 通过；3 万条合成消息分批增量写入、索引计数 30000、分页读回最近 50 条（首条 #29950）、当前聊天 DOM 保持窗口化；设置各页、迁移对照表、导出 JSON 点击均无控制台错误，历次审计 console_errors 均为 0。
- **自动检查通过（2026-11-20 午后，本轮）**：上面 47 项单元测试全部通过；`dist/` 已重建并通过 `node --check`，含 `buildCurrentRequest` 与 `cotSettings` 加载；导出 Key 泄漏、cotSettings 未保存、预览与请求各建一次、预设应用抹 Key、自检断言写错共 5 个问题已修复（见上表第 11–15 条）；引用、停止、失败重试、刷新恢复四项按代码路径核查：引用序列化与渲染有解析器测试覆盖，停止走 `AbortController`（fake fetch 流式 abort 测试通过），失败重试走错误弹窗的重试按钮且不删已发消息，刷新恢复走 IndexedDB 增量写 + 分页加载（预览实测已通过）。
- **UI 重设计移植验证（2026-11-20，源码侧，本轮）**：`npm test` 55/55 通过；`dist/` 已重建（260,416 字节）并通过 `node --check`；无头 Chromium（Playwright，430×900）实测 `dist/index.html`：启动正常（示例角色、2 条欢迎消息、保存状态“已就绪”）、聊天/动态/管理三页切换正常（动态 3 条虚拟帖子 + 英雄卡、首次访问后角标消失；管理 4 组 11 行、悬浮胶囊指示条定位正常）、人设/外观/上下文预览二级页正常打开（人设字段与保存按钮在、提示词版本 tt、消息 4 条、预估 token 显示）、外观页 8 个滑杆 + 17 个色板 + 5 个背景入口、背景切换后 `#app.has-bg` 生效且 `--bg-veil` 为 0.32、Enter 发送消息并清空输入框、Get Reply 模拟回复 2 气泡且带 `模拟回复` 标记、0 控制台错误；截图复核：聊天页与管理页外观与原型方向一致（明亮浅色、薄透玻璃、单色图标）。**未验证**：无头环境没有 WebGL（`getContext('webgl')` 返回 null），玻璃走的是 CSS 降级层，WebGL 引擎在真实浏览器/iPhone 上的激活、帧率与发热仍需 Dolores 真机确认；长按 480ms、键盘遮挡、PWA 模式同样待真机确认；动态真实数据与 MCP 仍未实现（见第三部分）。
- **需要 Dolores 配置真实 API 后验证**：真实 API 端到端——填 Base URL / Key / 模型后点连接测试，再发消息 + Get Reply，确认「模拟」标记消失、流式气泡实时出现、多气泡按顺序落库、引用与停止在真流上表现正常、失败（如 401/429）弹窗与重试；用真实备份走一次导出→重新导入往返（导入一步已由 Dolores 在预览实测通过，2026-11-20 上午；导出再导回还没人走过）；Gemini 原生分支——源码已实现并有单元测试，但预览构建未包含/验证该分支，不要把预览当作 Gemini 已验证；真机 iPhone Safari / Add to Home Screen 行为、键盘遮挡、长按手感。
