# Bookkeeping Cloud

公司記帳雲系統 — 中小企業 / 餐飲服務業多租戶記帳平台。

規格書見主 repo `docs/money/公司記帳雲系統_軟體規格書_v1.7.md`;單一入口 `docs/money/記帳雲_總計畫.md`。

目前版本 **0.15.0**(2026-10-10 施工計畫 `docs/記帳雲_施工計畫_2026-10-10.md`)。

## 快速啟動

需要 Docker Desktop。第一次啟動：

```powershell
copy .env.example .env
# 用編輯器打開 .env 改 POSTGRES_PASSWORD 跟 JWT_SECRET
docker-compose up --build
```

驗證（另開一個 PowerShell）：

```powershell
curl http://localhost:3001/health
```

預期回應：

```json
{ "status": "ok", "db": "connected", "redis": "connected", "version": "0.15.0" }
```

## 登入方式

日常登入走 **HR SSO**:登入頁下拉選員工 + 打 HR 的 PIN,雲端代打主 repo `/api/auth/login`;
帳本角色由 HR `/attendance` 的「記帳雲權限」決定(每次檢查都會跟 HR 名單同步,降級立即生效)。
HR 連不上時沿用最後一份名單 10 分鐘,超過就擋。

## 帳號

- **登入只走 HR 員工名單**(上面的 HR SSO):沒有獨立的 email / 密碼帳號,改 PIN 回 HR `/attendance`。
- 緊急後門(bcrypt email + 密碼)預設**關閉**,線上也是關的;開法見 `src/routes/auth.js:8`(`LEGACY_EMAIL_LOGIN=true`)。`/auth/register`、`/auth/change-password` 兩個端點已回 410。
- 帳本: 花現鳥巢 / Nest Restaurant(code = `NEST0001`);測試用 staging 帳本 `NEST0099`(所有自動化測試只准打這本)。

## 試 API

### 1. 登入拿 token

最簡單是開瀏覽器到登入頁(下拉選員工 + PIN)。要用 curl 就照登入頁送的格式 POST `/auth/login`(欄位看 `src/routes/auth.js` 的 login handler,用自己的員工編號與 PIN,**不要把 PIN 寫進任何檔案或對話**)。

回應會給 `token`，記下來，下面 API 都要在 header 帶 `Authorization: Bearer <token>`。

### 2. 看自己的 user 資料

```powershell
curl http://localhost:3001/auth/me -H "Authorization: Bearer <token>"
```

### 3. 看自己有哪些帳本

```powershell
curl http://localhost:3001/books -H "Authorization: Bearer <token>"
```

### 4. 改 PIN

雲端沒有改密碼的端點(`/auth/change-password` 回 410)。PIN 在 HR 系統 `/attendance` 改,改完記帳雲下次檢查名單時自動生效(登入會被要求重登)。

### 5. 建新帳本

```powershell
curl -X POST http://localhost:3001/books `
  -H "Authorization: Bearer <token>" `
  -H "Content-Type: application/json" `
  -d '{\"name\":\"測試店\",\"company_name\":\"測試有限公司\",\"currency\":\"TWD\"}'
```

回應會給新帳本的 8 字元 `code`，例如 `AB7XK2DM`，之後用 `/B/AB7XK2DM/...` 操作。

## API 一覽

| 方法 | 路徑 | 說明 | 權限 |
|---|---|---|---|
| GET | `/` | 登入頁 | 公開 |
| GET | `/api-info` | API 列表(機器讀) | 公開 |
| GET | `/health` | 健康檢查(含 `alerts`:手機通知有沒有接) | 公開 |
| POST | `/auth/register` | **410 停用**(帳號全由 HR 管) | — |
| POST | `/auth/login` | 登入拿 JWT | 公開 |
| GET | `/auth/me` | 當前 user 資訊 | 已登入 |
| POST | `/auth/change-password` | **410 停用**(改 PIN 回 HR /attendance) | — |
| GET | `/books` | 列我能進的帳本 | 已登入 |
| POST | `/books` | 建新帳本(自動成為 owner、補預設科目帳戶) | NEST0001 的 owner |
| GET | `/B/:bookCode` | 帳本詳情 | 該帳本成員 |
| PATCH | `/B/:bookCode` | 改帳本資料 | owner / admin |
| GET | `/B/:bookCode/members` | 列成員 | 該帳本成員 |
| POST/PATCH/DELETE | `/B/:bookCode/members…` | **410 停用**(成員由 HR 記帳雲權限同步) | — |

記帳、待審、報表、對帳等其餘端點見 `GET /api-info`。

## 角色

依規格書 §3.2.3：

- `owner`：擁有者，唯一能加 / 移除成員、改角色（建帳本者自動成為）
- `admin`：管理員，可改帳本資料、加成員（不能改角色）
- `editor`：記帳員，可記帳、可核准 / 退回待審(LEO 2026-10-10 拍板);**不能沖銷**
- `viewer`：檢視者，只能看不能改

## 技術棧

- Node.js 20 + Express 4
- PostgreSQL 16
- Redis 7
- bcrypt 密碼 + JWT (7 天有效期) + helmet 安全 headers

## 目前進度

- [x] M0 階段 1 — repo 骨架 + container 環境 + 第一個 migration
- [x] M0 階段 2 — register / login + book CRUD + members
- [x] M0 階段 3 — deploy 到 10.0.1.168 + deploy.ps1 自動化 + production JWT secret（HTTPS 留販售前再做）
- [x] M1 — 核心引擎（ag_accounts / subjects / counterparties / journal_logs + CRUD）
- [x] M2 — 報表 / 儀表板（dashboard / monthly / yearly / counterparties）
- 之後的進度(待審、POS / 訂金 / 支出 / 薪資對接、對帳中心)以主 repo `docs/money/記帳雲_總計畫.md` 為準,這裡不再重複維護。

---

## Deploy

**只有 LEO 說「推上去」才部署。** 一律用:

```powershell
.\deploy.ps1 -All
```

scp 全部 tracked 檔 + `docker restart` + 跑 /health。⚠ `docker restart` **不重讀 `.env`、不重跑 npm install**;
改 `.env` 或 `package.json` 依賴要 `docker compose up -d --build app`(在 `/root/bookkeeping-cloud`)。
migration 在 app 啟動時自動跑(`src/migrate.js`),失敗 = app 起不來。

## Production 部署

### 改 JWT_SECRET 為亂數

第一次部署用 `.env` 內 default 即可，但要正式販售前把 JWT_SECRET 改亂數(下面的 `<...>` 全部換成自己的值,**不要照抄範例、不要貼進對話或 commit**)：

```powershell
$jwt = -join ((1..64) | ForEach-Object { "0123456789abcdef"[(Get-Random -Maximum 16)] })
$envContent = "POSTGRES_PASSWORD=<自己的值>`nJWT_SECRET=$jwt`nNODE_ENV=development"
$envContent | Out-File -FilePath "$env:TEMP\bk-env" -Encoding ASCII -NoNewline
scp "$env:TEMP\bk-env" "nester@10.0.1.168:/root/bookkeeping-cloud/.env"
ssh nester@10.0.1.168 "cd /root/bookkeeping-cloud && docker compose up -d app"
Remove-Item "$env:TEMP\bk-env"
```

注意：改 JWT_SECRET 會讓所有既有 login token 失效，要重新登入。
⚠ 上面是示意;**簽章密鑰(WEBHOOK_HMAC_SECRET)輪替請用主 repo `scripts/rotate_bookkeeping_hmac.ps1`**,機密不要貼進對話或 commit。

POSTGRES_PASSWORD 改較複雜（要同步改 PG 內的 user password），內網自家用 LEO 2026-10-11 拍板「先不動」，販售前再嚴密化。

### HTTPS 設定（販售前再做）

目前內網 10.0.1.168:3001 走 HTTP 即可。販售給其他餐廳前要設 HTTPS：

1. 註冊一個域名（如 `bookkeeping.example.com`）
2. DNS A 紀錄指向部署主機 IP
3. 在 1Panel 介面 →「網站」→「新增反向代理」：
   - 域名：`bookkeeping.example.com`
   - 代理至：`http://localhost:3001`
   - 啟用 Let's Encrypt SSL（自動申請 + 續約）
   - 開「強制 HTTPS」
4. 從外網用 `https://bookkeeping.example.com` 即可

注意：販售上線前還要把 `src/server.js` 內 `app.use(cors())` 設 origin 白名單（目前是接受所有來源）。
