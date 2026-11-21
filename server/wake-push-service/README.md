# wake-push-service（可选后台推送服务，最小版）

verweile 前端默认是**前端运行模式**：唤醒只在页面打开且可见时检查，
页面关闭后收不到系统推送。这个服务是可选的真后台：保存浏览器的推送
订阅，到期后发一条 Web Push，点通知可打开 verweile。

没有它时一切照常，只是没有后台推送——前端会如实显示“前端运行模式”，
不假装有后台能力。

## 它存什么、不存什么

- 存：推送订阅端点（endpoint + keys）、角色 id、唤醒元数据（wakeId、
  触发原因、 下次时间）。
- 不存：聊天正文、API 密钥、位置/App/健康数据。推送内容只有通用文案
  （如“到时间了，回来看看吧”），不含消息内容。

## 部署步骤

1. 安装依赖（Node 18+）：
   ```sh
   cd server/wake-push-service
   npm install
   ```
2. 生成 VAPID 密钥对（只做一次）：
   ```sh
   npx web-push generate-vapid-keys
   ```
3. 复制 `.env.example` 为 `.env`，填入公钥、私钥、联系邮箱：
   ```
   VAPID_PUBLIC_KEY=...
   VAPID_PRIVATE_KEY=...
   VAPID_SUBJECT=mailto:you@example.com
   PORT=8787
   ```
   私钥不要提交到仓库、不要发给别人。
4. 启动：
   ```sh
   npm start
   ```
5. 填前端推送配置：把 `VAPID_PUBLIC_KEY` 填到前端推送设置
   （pushSettings.vapidPublicKey），把服务地址（如 `https://你的域名`）
   填到 pushSettings.pushServiceUrl；前端订阅成功后会 POST /subscribe
   把订阅发过来。
6. 验证：`curl http://localhost:8787/health` 应返回 ok；设一个一分钟后
   到期的闹钟，关掉页面，等推送到达并点通知能打开对应聊天。

## 接口

- `GET /health` — 存活检查。
- `POST /subscribe` — `{ subscription, charId, wakeJobs: [{ wakeId, trigger, nextAt }] }`。
- `POST /unsubscribe` — `{ endpoint }`。
- `POST /tick` — 手动触发一次到期检查（服务本身每 60 秒自动检查一次）。

订阅存在本目录的 `subscriptions.json`（本机文件，不上传聊天内容）。
