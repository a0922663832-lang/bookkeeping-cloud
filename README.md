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
- [ ] M0 階段 3 — deploy 到 10.0.1.168
- [ ] M1 — 核心引擎（ag_accounts / subjects / counterparties / journal_logs）
- [ ] M2 — 報表 / 儀表板
- [ ] M3 — webhook 接收 + Pending Review
- [ ] M4 — 進貨系統 v2 升級對接
- [ ] M5 — POS 對接
- [ ] M6 — INLINE 訂金對接
- [ ] M7 — HR 薪資對接
- [ ] M8 — 電子發票 / 第三方支付擴充
