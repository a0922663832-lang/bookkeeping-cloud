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
{ "status": "ok", "db": "connected", "redis": "connected", "version": "0.1.0" }
```

## 預設帳號（M0 階段 1 自動建立）

- Email: `a0922663832@gmail.com`
- 密碼: `.env` 內 `INITIAL_ADMIN_PASSWORD`（預設 `changeme`，第二階段加完登入後務必改掉）
- 帳本: 花現鳥巢 / Nest Restaurant（code = `NEST0001`）

## 技術棧

- Node.js 20 + Express 4
- PostgreSQL 16
- Redis 7

## 目前進度

- [x] M0 階段 1 — repo 骨架 + container 環境 + 第一個 migration
- [ ] M0 階段 2 — register / login + book CRUD
- [ ] M0 階段 3 — deploy 到 10.0.1.168
- [ ] M1 — 核心引擎（ag_accounts / subjects / counterparties / journal_logs）
- [ ] M2 — 報表 / 儀表板
- [ ] M3 — webhook 接收 + Pending Review
- [ ] M4 — 進貨系統 v2 升級對接
- [ ] M5 — POS 對接
- [ ] M6 — INLINE 訂金對接
- [ ] M7 — HR 薪資對接
- [ ] M8 — 電子發票 / 第三方支付擴充
