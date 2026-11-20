# verweile

独立聊天界面：一个固定 AI 角色 + 你。TT 提示词迁移、上下文组装、回复解析、
API 设置、IndexedDB 保存、JSON / `.ee` 导入导出。向量记忆只保留数据与扩展接口；
小动态、MCP 留待后续。不改写角色设定与聊天风格，不扩展成完整小手机。

## 本版外观

- 品牌统一为 verweile，韩系字标、细线图标、紧凑悬浮栏。
- 「我的 → 外观与背景」内置冷白、雾灰、银黑、深黑四套主题。
- 气泡材质：液态玻璃、柔雾、墨色；双方气泡可独立选色。
- 使用原包 `liquidGlass.js` 的 WebGL 背景折射，并修复动态注册、滚动裁切和移除元素清理。玻璃采样背景，不折射聊天文字。
- WebGL 不可用时自动使用 CSS 模糊、通透填充与内侧高光；效果依浏览器而异。尊重减少动态效果设置。
- 保留原有数据库名与备份协议标识，方便在同一域名继续读取已有数据。换域名需要导入备份。
- 动态仍是示例内容；MCP 与向量检索仍为原项目的预留功能。真实 API 需要自行配置。

## 运行

- 本地运行：`python3 -m http.server 8080`，打开 `http://localhost:8080`；或部署整个目录到静态托管。源码 `index.html` 使用 ES modules，不建议用 file:// 打开。
- 跑测试：`npm test`（55 项，Node 内置 test runner，无需安装依赖）。
- 打包单文件预览：`node scripts/build-preview.mjs` → `dist/index.html`
  （把 `js/*.js` 按依赖顺序拼成一个 `<script type="module">`，内联 `styles.css`）。

## 目录

| 位置 | 作用 |
|---|---|
| `index.html` / `styles.css` | 聊天界面（移动优先，黑白灰 + 液态玻璃） |
| `js/app.js` | 界面编排：发送 / Get Reply / 解析落库 / 设置面板 / 导入导出 / 自检 |
| `js/promptTemplates.js` | TT 与 UWU 默认模板基线（只读，原文迁移，仅裁剪未实现能力） |
| `js/promptBuilder.js` | 提示词组装：版本解析、世界书、收藏记忆、表情包清单、覆盖层 |
| `js/historyBuilder.js` | 上下文组装：`<chat_history>` / `<user_input>`、同角色合并、撤回占位 |
| `js/replyParser.js` | 回复解析：引用/双语/表情包/照片描述/语音/状态/撤回/转账/礼物 |
| `js/sse.js` | SSE 事件缓冲（拆分 UTF-8 / JSON / 协议片段、`[DONE]`、非流式 JSON） |
| `js/providerAdapter.js` | OpenAI 兼容 + Gemini 原生两路；屏蔽域名 `api522/521/520.pro` |
| `js/storage.js` | IndexedDB 分表 + MemoryBackend（测试用）；状态模板去重 |
| `js/importExport.js` | JSON / gzip `.ee` 识别、规范化、合并导入、导出（默认不含 Key） |
| `js/mockReply.js` | 无 Key 时的本地模拟回复（明确标注模拟，不冒充真实 API） |
| `js/utils.js` | 小工具：token 估算、时间格式、HTML 转义、友好错误 |
| `tests/` | 单元测试（提示词/上下文去重/解析/SSE/导入导出/状态模板/3 万条分页） |
| `scripts/build-preview.mjs` | 单文件预览打包脚本 |
| `MIGRATION.md` | UWU 迁移对照表（复用/有意修正/未实现/验证结果） |

## 使用

1. 打开后是示例角色（可删除）。设置 → 数据 → 导入备份（JSON 或 `.ee`），
   预览数量后选主角色，合并或替换由你决定。
2. 设置 → API：填 Base URL、Key、模型，点“测试连接”。不填 Key 时 Get Reply
   走本地模拟回复，顶栏有“模拟”标记。
3. 聊天：发消息 → 点 Get Reply；发送后自动请求默认关闭，可在输入框下方打开。
   长按（手机）/ 右键（电脑）一条消息：复制、引用、编辑、撤回（本人 2 分钟内）、
   不进入上下文、查看原始内容、删除。
4. 设置 → 提示词 → “本次发送内容预览”：看最终发给模型的 system prompt、
   消息列表、模块来源与 token 估算（与实际请求同一份构建结果，不显示 Key）。

## 存储

- IndexedDB `uwu-chat-db`：角色、世界书、表情包、记忆、消息、附件、状态模板、设置分表保存；
  消息按条增量写；默认加载最新 50 条，向上加载更早。
- localStorage 只放微小偏好（上次角色、自动回复开关）。
- 导出默认不含 API Key；含 Key 的私人备份需在导出时明确勾选。
- 私人聊天只发往你自己配置的模型接口，不上传到任何部署数据库或统计服务。

## 未验证

真实 API 端到端（需填 Key 后验证）；真机 iPhone Safari / Add to Home Screen
行为、键盘遮挡、长按手感。见 `MIGRATION.md` 第五部分。
