# Bookkeeping Cloud

公司記帳雲系統 — 中小企業 / 餐飲服務業多租戶記帳平台。

規格書見 `../Money/公司記帳雲系統_軟體規格書_v1.7.md`。

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
{ "status": "ok", "db": "connected", "redis": "connected", "version": "0.2.0" }
```

## 預設帳號（首次啟動自動建立）

- Email: `a0922663832@gmail.com`
- 密碼: `.env` 內 `INITIAL_ADMIN_PASSWORD`（預設 `changeme`，請登入後立刻用 `/auth/change-password` 改掉）
- 帳本: 花現鳥巢 / Nest Restaurant（code = `NEST0001`）

## 試 API

### 1. 登入拿 token

```powershell
curl -X POST http://localhost:3001/auth/login `
  -H "Content-Type: application/json" `
  -d '{\"email\":\"a0922663832@gmail.com\",\"password\":\"changeme\"}'
```

回應會給 `token`，記下來，下面 API 都要在 header 帶 `Authorization: Bearer <token>`。

### 2. 看自己的 user 資料

```powershell
curl http://localhost:3001/auth/me -H "Authorization: Bearer <token>"
```

### 3. 看自己有哪些帳本

```powershell
curl http://localhost:3001/books -H "Authorization: Bearer <token>"
```

### 4. 改預設密碼（強烈建議）

```powershell
curl -X POST http://localhost:3001/auth/change-password `
  -H "Authorization: Bearer <token>" `
  -H "Content-Type: application/json" `
  -d '{\"current_password\":\"changeme\",\"new_password\":\"你的新密碼\"}'
```

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
| GET | `/` | API 列表 | 公開 |
| GET | `/health` | 健康檢查 | 公開 |
| POST | `/auth/register` | 註冊新帳號 | 公開 |
| POST | `/auth/login` | 登入拿 JWT | 公開 |
| GET | `/auth/me` | 當前 user 資訊 | 已登入 |
| POST | `/auth/change-password` | 改密碼 | 已登入 |
| GET | `/books` | 列我能進的帳本 | 已登入 |
| POST | `/books` | 建新帳本（自動成為 owner） | 已登入 |
| GET | `/B/:bookCode` | 帳本詳情 | 該帳本成員 |
| PATCH | `/B/:bookCode` | 改帳本資料 | owner / admin |
| GET | `/B/:bookCode/members` | 列成員 | 該帳本成員 |
| POST | `/B/:bookCode/members` | 加成員 | owner / admin |
| PATCH | `/B/:bookCode/members/:userId` | 改角色 | owner |
| DELETE | `/B/:bookCode/members/:userId` | 移除成員 | owner |

## 角色

依規格書 §3.2.3：

- `owner`：擁有者，唯一能加 / 移除成員、改角色（建帳本者自動成為）
- `admin`：管理員，可改帳本資料、加成員（不能改角色）
- `editor`：編輯者，可記帳（M1 才會用到）
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
- [ ] M3 — webhook 接收 + Pending Review
- [ ] M4 — 進貨系統 v2 升級對接
- [ ] M5 — POS 對接
- [ ] M6 — INLINE 訂金對接
- [ ] M7 — HR 薪資對接
- [ ] M8 — 電子發票 / 第三方支付擴充

---

## Deploy

每次本機改完 code，跑：

```powershell
.\deploy.ps1
```

會自動 scp 自 HEAD 之後改過的檔案 + restart container + 跑 /health。Force 同步用 `.\deploy.ps1 -All`。

## Production 部署

### 改 JWT_SECRET 為亂數

第一次部署用 `.env` 內 default 即可，但要正式販售前把 JWT_SECRET 改亂數：

```powershell
$jwt = -join ((1..64) | ForEach-Object { "0123456789abcdef"[(Get-Random -Maximum 16)] })
$envContent = "POSTGRES_PASSWORD=nestpass`nJWT_SECRET=$jwt`nINITIAL_ADMIN_PASSWORD=changeme`nNODE_ENV=development"
$envContent | Out-File -FilePath "$env:TEMP\bk-env" -Encoding ASCII -NoNewline
scp "$env:TEMP\bk-env" "nester@10.0.1.168:/root/bookkeeping-cloud/.env"
ssh nester@10.0.1.168 "docker restart bookkeeping-cloud-app"
Remove-Item "$env:TEMP\bk-env"
```

注意：改 JWT_SECRET 會讓所有既有 login token 失效，要重新登入。

POSTGRES_PASSWORD 改較複雜（要同步改 PG 內的 user password），內網自家用先保留 nestpass，販售前再嚴密化。

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
