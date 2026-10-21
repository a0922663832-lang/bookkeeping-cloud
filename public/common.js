/* 記帳雲 · 八頁共用程式(2026-10-10 雲 4)
 *
 * 每一頁都先載入這支,再寫自己的 script。這裡集中放:
 *   - api():統一檢查回應、錯誤一律白話中文、登入失效時只清 token(保留「上次選的人」)
 *   - esc() / fmtMoney() / fmtDate() / todayLocal():跳脫、金額、日期(台北時間切日)
 *   - ask() / askText():自畫的確認框與輸入框(現場平板的系統小視窗會被吃掉,所以不用)
 *   - inlineResult():結果訊息留在剛操作的那一張卡片 / 那一列旁邊,不會自己消失
 *   - buildNav():八頁同一條導覽(含「對帳」)+ 待審徽章每 60 秒更新
 *   - CC.can() / CC.getBook():依角色把按鈕藏起來或灰掉
 *
 * 注意:頁面自己的 script 不要再宣告同名的 BOOK / $ / api / esc / fmt 等,會衝突。
 */
(function (global) {
  'use strict';

  var BOOK = 'NEST0001';
  var CJK = /[一-鿿]/;
  var CC = { BOOK: BOOK };

  // ───────────────────────── 小工具 ─────────────────────────
  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmt(v) {
    return new Intl.NumberFormat('zh-TW', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(parseFloat(v || 0));
  }

  // 負數寫成 -$1,200(不是 $-1,200)
  function fmtMoney(v) {
    var n = parseFloat(v);
    if (!isFinite(n)) n = 0;
    return (n < 0 ? '-' : '') + '$' + fmt(Math.abs(n));
  }

  // 帶正負號:+$500 / -$500
  function fmtSigned(v) {
    var n = parseFloat(v);
    if (!isFinite(n)) n = 0;
    return (n < 0 ? '-' : '+') + '$' + fmt(Math.abs(n));
  }

  var dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' });
  var dateTimeFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });

  function pickParts(fmtObj, d) {
    var o = {};
    fmtObj.formatToParts(d).forEach(function (p) { o[p.type] = p.value; });
    return o;
  }

  // 只顯示 YYYY-MM-DD。純日期字串原樣回傳;其他(含 T…Z)一律以台北時間切日。
  function fmtDate(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    var d = v instanceof Date ? v : new Date(v);
    if (isNaN(d.getTime())) return '';
    var p = pickParts(dateFmt, d);
    return p.year + '-' + p.month + '-' + p.day;
  }

  function fmtDateTime(v) {
    if (v == null || v === '') return '';
    var d = v instanceof Date ? v : new Date(v);
    if (isNaN(d.getTime())) return '';
    var p = pickParts(dateTimeFmt, d);
    var hh = p.hour === '24' ? '00' : p.hour;
    return p.year + '-' + p.month + '-' + p.day + ' ' + hh + ':' + p.minute;
  }

  function todayLocal() { return fmtDate(new Date()); }

  // 日期字串加減天數(不經過時區轉換)
  function addDays(dateStr, n) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
    if (!m) return dateStr;
    var t = Date.UTC(+m[1], +m[2] - 1, +m[3]) + n * 86400000;
    var d = new Date(t);
    var mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    var dd = String(d.getUTCDate()).padStart(2, '0');
    return d.getUTCFullYear() + '-' + mm + '-' + dd;
  }

  // ───────────────────────── 名稱對照(白話) ─────────────────────────
  var ROLE_NAME = { owner: '帳本擁有者', admin: '管理員', editor: '記帳員', viewer: '唯讀' };
  var ACCT_TYPE_NAME = {
    cash: '現金', bank: '銀行存款', digital_bank: '數位銀行', time_deposit: '定期存款', investment: '投資',
    income_account: '收款待轉', liability: '負債/應付', asset: '其他資產', virtual: '虛擬(暫存)',
  };
  var SUBJ_TYPE_NAME = { t1: '收入', t2: '成本', t3: '費用', t4: '轉帳', t5: '股東權益/業外' };
  // 對照主 repo cloudBookkeepingClient.js / routes/integrations.js 實際送出的值
  var SOURCE_NAME = {
    leo_pos: '點餐結帳', leo_expense: '支出單', leo_inventory: '進貨', leo_inline: '訂金 / 刷卡撥款', leo_hr: '薪資',
  };
  var EVENT_NAME = {
    pos_shift_settled: 'POS 收班', pos_deposit_offset: '訂金抵用', pos_deposit_offset_return: '訂金抵用退回',
    expense_created: '支出', 'expense.created': '支出',
    invoice_receipt: '進貨發票', invoice_payment: '進貨付款', vendor_monthly_bill_paid: '月結帳單付款',
    deposit_paid: '收訂金', deposit_refunded: '退訂金', deposit_voided: '訂金作廢',
    inline_payout_transfer: '刷卡撥款', inline_payout_fee: '刷卡手續費',
    payroll_finalized: '薪資', insurance_payment: '勞健保',
  };
  // 待審單只存 event_id(沒有 event_type 欄),從 event_id 前綴推回事件
  var EVENT_ID_PREFIX = [
    ['expense.created.', 'expense_created'], ['expense.supersede.', 'expense_created'], ['expense.void.', 'expense_created'],
    ['invoice.receipt.', 'invoice_receipt'], ['invoice.payment.', 'invoice_payment'], ['bill.paid.', 'vendor_monthly_bill_paid'],
    ['deposit.paid.', 'deposit_paid'], ['deposit.supersede.', 'deposit_paid'], ['deposit.refund.', 'deposit_refunded'], ['deposit.void.', 'deposit_voided'],
    ['inline_payout.', 'inline_payout_transfer'],
    ['pos_shift.', 'pos_shift_settled'], ['pos_deposit_offset.', 'pos_deposit_offset'], ['pos_deposit_offset_return.', 'pos_deposit_offset_return'],
    ['payroll.', 'payroll_finalized'], ['insurance_payment.', 'insurance_payment'],
  ];
  // 待審單的事件名:有 event_type 就用,否則看 event_id,都沒有回 ''
  function pendingEventName(p) {
    if (!p) return '';
    var t = p.event_type || (p.payload && p.payload.event_type) || '';
    var id = String(p.event_id || '');
    if (!t) {
      for (var i = 0; i < EVENT_ID_PREFIX.length; i++) {
        if (id.indexOf(EVENT_ID_PREFIX[i][0]) === 0) { t = EVENT_ID_PREFIX[i][1]; break; }
      }
      if (t === 'inline_payout_transfer' && /\.fee$/.test(id)) t = 'inline_payout_fee';
    }
    return t ? eventName(t) : '';
  }
  var MODE_TEXT = { review: '進待審,老闆按過才入帳', auto: '直接入帳', manual: '拒收' };

  function sourceName(s) { return SOURCE_NAME[s] || '其他'; }
  function eventName(e) { return EVENT_NAME[e] || '其他'; }

  // ───────────────────────── 錯誤文字 ─────────────────────────
  function friendlyError(status, data) {
    var m = data && typeof data.error === 'string' ? data.error : '';
    if (status === 429) {
      var s = data && Number(data.retry_after_sec);
      if (s > 0) return '這個編號嘗試太多次,請 ' + Math.max(1, Math.ceil(s / 60)) + ' 分鐘後再試';
      return m && CJK.test(m) ? m : '操作太頻繁,請稍後再試';
    }
    if (status === 401) return m && CJK.test(m) ? m : '登入已過期或權限被收回,請重新登入';
    if (status >= 500 && status !== 502 && status !== 504) return '系統暫時有問題,請稍後再試';
    if (m && CJK.test(m)) return m;
    if (status === 502 || status === 504) return '另一個系統暫時連不上,請稍後再試';
    if (status === 403) return '你的角色不能做這個';
    if (status === 404) return '找不到這筆資料,可能已被刪除或換過';
    if (status === 409) return '這筆資料剛被別人改過,請重新整理後再試';
    if (status === 400 || status === 422) return '送出的內容有問題,請檢查後再試';
    return '系統暫時有問題,請稍後再試';
  }

  // ───────────────────────── 登入狀態 / api ─────────────────────────
  function go(url) {
    if (global.__CC_NAV) { global.__CC_NAV(url); return; }
    global.location.href = url;
  }

  function getToken() {
    try { return global.localStorage.getItem('token'); } catch (_) { return null; }
  }

  function getUser() {
    try { return JSON.parse(global.localStorage.getItem('user') || '{}'); } catch (_) { return {}; }
  }

  // 只清登入憑證;lastEmpId(登入頁「記住上次選的人」)和 device_id 要留著
  function clearSession() {
    try { global.localStorage.removeItem('token'); global.localStorage.removeItem('user'); } catch (_) { /* ignore */ }
  }

  function goLogin(reason) {
    go('/' + (reason ? '?reason=' + encodeURIComponent(reason) : ''));
  }

  function logout() {
    clearSession();
    go('/');
  }

  async function api(path, opts) {
    opts = Object.assign({}, opts || {});
    var headers = Object.assign({ Authorization: 'Bearer ' + (getToken() || '') }, opts.headers || {});
    if (opts.body != null) {
      if (typeof opts.body === 'object') opts.body = JSON.stringify(opts.body);
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    }
    opts.headers = headers;
    var r;
    try {
      r = await fetch(path, opts);
    } catch (_) {
      var ne = new Error('連線有問題,請檢查網路後再試');
      ne.status = 0;
      throw ne;
    }
    var data = await r.json().catch(function () { return {}; });
    if (r.status === 401) {
      var why = friendlyError(401, data);
      clearSession();
      goLogin(why);
      var ue = new Error(why);
      ue.status = 401; ue.data = data; ue.handled = true;
      throw ue;
    }
    if (!r.ok) {
      var e = new Error(friendlyError(r.status, data));
      e.status = r.status; e.data = data;
      throw e;
    }
    return data;
  }

  // ───────────────────────── 樣式(只注入一次) ─────────────────────────
  var styleDone = false;
  function injectStyle() {
    if (styleDone) return;
    styleDone = true;
    var st = document.createElement('style');
    st.textContent = [
      '.cc-dlg-back{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:20000;display:flex;align-items:center;justify-content:center;padding:16px}',
      '.cc-dlg{background:#fff;border-radius:14px;padding:22px;width:min(94vw,440px);box-shadow:0 10px 40px rgba(0,0,0,.25);font-family:inherit}',
      '.cc-dlg-title{font-size:17px;font-weight:700;margin-bottom:10px;color:#1a1814}',
      '.cc-dlg-text{font-size:14px;color:#444;line-height:1.7;white-space:pre-line;margin-bottom:12px}',
      '.cc-dlg label{font-size:13px;color:#666;display:block;margin-bottom:4px}',
      '.cc-dlg textarea{width:100%;border:1px solid #cfc8b8;border-radius:8px;padding:8px 10px;font-size:15px}',
      '.cc-dlg-err{color:#c4453a;font-size:13px;margin-top:6px}',
      '.cc-dlg-btns{display:flex;justify-content:flex-end;gap:10px;margin-top:16px}',
      '.cc-btn{border:1px solid #cfc8b8;background:#fff;color:#333;border-radius:8px;padding:9px 18px;font-size:15px;min-width:84px;cursor:pointer}',
      '.cc-btn.ok{background:#6a3a8a;border-color:#6a3a8a;color:#fff}',
      '.cc-btn.danger{background:#c4453a;border-color:#c4453a;color:#fff}',
      '.cc-result{position:relative;border-radius:8px;padding:8px 32px 8px 12px;font-size:13px;margin-top:8px;line-height:1.6;white-space:pre-line}',
      '.cc-result.ok{background:#d1e7dd;color:#0a3622}',
      '.cc-result.bad{background:#fdeae8;color:#a94a3a}',
      '.cc-result .cc-x{position:absolute;right:8px;top:4px;border:0;background:transparent;font-size:18px;line-height:1;color:inherit;cursor:pointer}',
      '.cc-notice{background:#fff8e1;border:1px solid #ffeaa7;color:#7a5d00;border-radius:8px;padding:9px 14px;font-size:13px;line-height:1.6;margin-bottom:12px}',
      '.cc-notice a{color:#6a3a8a;font-weight:600;margin-left:2px}',
      '#cc-toasts{position:fixed;top:80px;right:20px;z-index:19000;display:flex;flex-direction:column;gap:8px;max-width:min(92vw,360px)}',
      '.cc-toast{padding:12px 34px 12px 16px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.12);font-size:13px;position:relative;line-height:1.6}',
      '.cc-toast.ok{background:#d1e7dd;color:#0a3622}',
      '.cc-toast.bad{background:#fdeae8;color:#a94a3a}',
      '.cc-toast .cc-x{position:absolute;right:8px;top:6px;border:0;background:transparent;font-size:18px;line-height:1;color:inherit;cursor:pointer}',
    ].join('\n');
    document.head.appendChild(st);
  }

  function mk(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ───────────────────────── 自畫對話框 ─────────────────────────
  function dialog(opts, withInput) {
    injectStyle();
    return new Promise(function (resolve) {
      var prevFocus = document.activeElement;
      var back = mk('div', 'cc-dlg-back');
      var box = mk('div', 'cc-dlg');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.appendChild(mk('div', 'cc-dlg-title', opts.title || (withInput ? '請輸入' : '請確認')));
      if (opts.text) box.appendChild(mk('div', 'cc-dlg-text', opts.text));
      var input = null, errEl = null;
      if (withInput) {
        if (opts.label) box.appendChild(mk('label', '', opts.label));
        input = document.createElement('textarea');
        input.rows = 2;
        input.maxLength = opts.maxLength || 200;
        if (opts.placeholder) input.placeholder = opts.placeholder;
        if (opts.value) input.value = opts.value;
        box.appendChild(input);
        errEl = mk('div', 'cc-dlg-err');
        errEl.style.display = 'none';
        box.appendChild(errEl);
      }
      var btns = mk('div', 'cc-dlg-btns');
      var cancel = mk('button', 'cc-btn', opts.cancelText || '取消');
      cancel.type = 'button';
      var ok = mk('button', 'cc-btn ' + (opts.danger ? 'danger' : 'ok'), opts.okText || '確定');
      ok.type = 'button';
      btns.appendChild(cancel);
      btns.appendChild(ok);
      box.appendChild(btns);
      back.appendChild(box);
      document.body.appendChild(back);

      var done = false;
      function finish(val) {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        if (back.parentNode) back.parentNode.removeChild(back);
        try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (_) { /* ignore */ }
        resolve(val);
      }
      function submit() {
        if (!withInput) { finish(true); return; }
        var v = input.value.trim();
        if (opts.required && !v) {
          errEl.textContent = opts.requiredText || '這一欄一定要填';
          errEl.style.display = '';
          input.focus();
          return;
        }
        finish(v);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); finish(withInput ? null : false); }
        else if (e.key === 'Enter' && (!withInput || e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
      }
      document.addEventListener('keydown', onKey, true);
      cancel.addEventListener('click', function () { finish(withInput ? null : false); });
      ok.addEventListener('click', submit);
      back.addEventListener('mousedown', function (e) { if (e.target === back) finish(withInput ? null : false); });
      setTimeout(function () { (input || ok).focus(); }, 0);
    });
  }

  // 回 Promise<true|false>
  function ask(opts) { return dialog(opts || {}, false); }
  // 回 Promise<字串|null>(null = 按了取消;不必填時空白回 '')
  function askText(opts) { return dialog(opts || {}, true); }

  // ───────────────────────── 結果訊息(留在操作旁邊) ─────────────────────────
  function inlineResult(el, ok, msg) {
    if (!el) return null;
    injectStyle();
    var holder;
    if (el.tagName === 'TR') {
      var next = el.nextElementSibling;
      var row = next && next.classList.contains('cc-result-row') ? next : null;
      if (!row) {
        row = document.createElement('tr');
        row.className = 'cc-result-row';
        var td = document.createElement('td');
        td.colSpan = Math.max(1, el.children.length);
        row.appendChild(td);
        el.parentNode.insertBefore(row, el.nextSibling);
      }
      holder = row.firstChild;
    } else {
      holder = el;
    }
    var old = null;
    for (var i = 0; i < holder.children.length; i++) {
      if (holder.children[i].classList.contains('cc-result')) { old = holder.children[i]; break; }
    }
    if (!msg) {
      if (old) old.remove();
      if (el.tagName === 'TR' && !holder.children.length && holder.parentNode) holder.parentNode.remove();
      return null;
    }
    var box = old || mk('div', 'cc-result');
    box.className = 'cc-result ' + (ok ? 'ok' : 'bad');
    box.textContent = msg;
    var x = mk('button', 'cc-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', '關閉訊息');
    x.addEventListener('click', function () {
      box.remove();
      if (el.tagName === 'TR' && !holder.children.length && holder.parentNode) holder.parentNode.remove();
    });
    box.appendChild(x);
    if (!old) holder.appendChild(box);
    return box;
  }

  // 整頁層級的訊息(其他一律用 inlineResult)。成功 6 秒後收起,失敗要自己按 ×
  function toast(msg, type) {
    injectStyle();
    var wrap = $('cc-toasts');
    if (!wrap) { wrap = mk('div'); wrap.id = 'cc-toasts'; document.body.appendChild(wrap); }
    var t = mk('div', 'cc-toast ' + (type === 'error' ? 'bad' : 'ok'), msg);
    var x = mk('button', 'cc-x', '×');
    x.type = 'button';
    x.addEventListener('click', function () { t.remove(); });
    t.appendChild(x);
    wrap.appendChild(t);
    if (type !== 'error') setTimeout(function () { t.remove(); }, 6000);
  }

  // ───────────────────────── 帳本資訊 / 角色 ─────────────────────────
  var bookPromise = null;
  function getBook(force) {
    if (!bookPromise || force) {
      bookPromise = api('/B/' + BOOK).catch(function (e) { bookPromise = null; throw e; });
    }
    return bookPromise;
  }
  function loadRole() {
    return getBook().then(function (r) { return r.my_role || null; }).catch(function () { return null; });
  }
  // 關帳日:'YYYY-MM-DD' 或 null(沒關帳)。後端若把日期帶成 T…Z,一律用台北時間切日
  function closedOf(r) {
    var v = r && r.book ? r.book.closed_through : (r ? r.closed_through : null);
    if (v == null || v === '') return null;
    return fmtDate(v) || null;
  }
  function loadClosedThrough(force) {
    return getBook(force).then(closedOf).catch(function () { return null; });
  }
  // 這個日期是不是落在關帳日(含)以前;兩邊都是 YYYY-MM-DD,直接比字串
  function isClosedDate(date, closed) {
    if (!closed || !date) return false;
    var d = fmtDate(date);
    return !!d && d <= closed;
  }
  // action: 'write' = 記帳員以上;'admin' = 管理員以上。角色不明時不擋(後端會擋)
  function can(role, action) {
    if (!role) return true;
    if (action === 'admin') return role === 'owner' || role === 'admin';
    return role === 'owner' || role === 'admin' || role === 'editor';
  }
  // 把按鈕灰掉並寫原因
  function lockBtn(btn, reason) {
    if (!btn) return;
    btn.disabled = true;
    btn.title = reason;
    btn.classList.add('disabled');
  }

  // ───────────────────────── 報表上方的「還有待審沒算進來」提示 ─────────────────────────
  // pending:後端回的 {count,total}。undefined(後端舊版沒這個欄位)和 count=0 都不顯示;null = 後端查不到
  function pendingNotice(el, pending) {
    if (!el) return;
    injectStyle();
    el.innerHTML = '';
    if (pending === undefined) return;
    if (pending === null) {
      el.appendChild(mk('div', 'cc-notice', '待審筆數暫時查不到,下面的數字可能還沒包含待審的單。'));
      return;
    }
    var n = Number(pending && pending.count);
    if (!isFinite(n) || n <= 0) return;
    var box = mk('div', 'cc-notice');
    box.appendChild(document.createTextNode('這段期間還有 ' + n + ' 筆、合計 ' + fmtMoney(pending.total) + ' 在待審,沒有算進下面的數字 → '));
    var a = mk('a', '', '去待審');
    a.href = '/pending';
    box.appendChild(a);
    el.appendChild(box);
  }

  // ───────────────────────── 防重複送出的單號 / 視窗備援 ─────────────────────────
  // 「記一筆」每開一張新表單產一個;同一張表單重送要用同一個(後端靠它擋掉重複的一筆)
  function newRequestId() {
    var id;
    try {
      if (global.crypto && global.crypto.randomUUID) id = global.crypto.randomUUID();
    } catch (_) { id = null; }
    if (!id) id = Date.now() + '-' + Math.random();
    return String(id).slice(0, 64);
  }

  // 外網元件(Bootstrap)沒載入時,視窗改用最陽春的備援,頁面其餘功能照常
  function makeModal(el) {
    if (global.bootstrap && global.bootstrap.Modal) return new global.bootstrap.Modal(el);
    var dlg = el.querySelector('.modal-dialog');
    var content = el.querySelector('.modal-content');
    var self = {
      show: function () {
        el.style.cssText = 'display:block;position:fixed;top:0;left:0;right:0;bottom:0;overflow:auto;background:rgba(0,0,0,.45);z-index:1055';
        if (dlg) dlg.style.cssText = 'max-width:640px;margin:24px auto;padding:0 12px';
        if (content) content.style.cssText = 'background:#fff;border-radius:12px;padding:16px';
        el.classList.add('show');
      },
      hide: function () { el.classList.remove('show'); el.style.display = 'none'; },
    };
    Array.prototype.forEach.call(el.querySelectorAll('[data-bs-dismiss="modal"]'), function (b) {
      b.addEventListener('click', function () { self.hide(); });
    });
    return self;
  }

  // ───────────────────────── 複式分錄(待審頁用) ─────────────────────────
  // 守恆:差額 = Σ帳戶腳 − Σ(收入類科目腳)+ Σ(成本/費用類科目腳)。收入、支出、訂金退款算出來都是 0。
  // 沒帶科目大類(後端還沒給)時算不出來,回 known:false,不亂報警。
  function legGap(legs) {
    legs = legs || [];
    var acc = 0, sub = 0, known = true, hasT4 = false;
    legs.forEach(function (l) {
      var a = Number(l.amount) || 0;
      if (l.kind === 'account') { acc += a; return; }
      var pt = l.subject_parent_type;
      if (pt === 't1' || pt === 't5') sub -= a;
      else if (pt === 't2' || pt === 't3') sub += a;
      else if (pt === 't4') hasT4 = true;
      else known = false;
    });
    return { known: known, gap: Math.round(acc + sub), hasT4: hasT4 };
  }
  // 單頭金額 = |Σ科目腳|;不是複式的照原金額
  function pendingAmount(p) {
    var j = (p && p.proposed_journal) || {};
    if (j.type === 'composite' && Array.isArray(j.legs)) {
      var s = 0;
      j.legs.forEach(function (l) { if (l.kind === 'subject') s += Number(l.amount) || 0; });
      return Math.abs(s);
    }
    return j.amount;
  }

  // ───────────────────────── 導覽 ─────────────────────────
  var NAV = [
    ['dashboard', '/dashboard', '儀表板'],
    ['pending', '/pending', '待審'],
    ['new', '/journals?new=1', '記一筆'],
    ['journals', '/journals', '明細'],
    ['reports', '/reports', '報表'],
    ['reconcile', '/reconcile', '對帳'],
    ['setup', '/setup', '主檔'],
    ['settings', '/settings', '設定'],
  ];

  function buildNav(active) {
    var mount = $('navMount');
    if (!mount) return;
    var links = NAV.map(function (n) {
      var badge = n[0] === 'pending' ? ' <span id="pendingBadge"></span>' : '';
      return '<a class="nav-link' + (n[0] === active ? ' active' : '') + '" href="' + n[1] + '">' + n[2] + badge + '</a>';
    }).join('');
    mount.innerHTML =
      '<nav class="navbar navbar-expand-lg shadow-sm"><div class="container">' +
      '<a class="navbar-brand" href="/dashboard"><span class="brand-icon">📊</span>記帳雲</a>' +
      '<div class="navbar-nav me-auto flex-row flex-wrap">' + links + '</div>' +
      '<div class="navbar-nav flex-row align-items-center">' +
      '<span class="navbar-text me-3" id="userName"></span>' +
      '<a class="btn btn-sm btn-outline-secondary" href="#" id="logoutBtn">登出</a>' +
      '</div></div></nav>';
    $('userName').textContent = getUser().name || '';
    $('logoutBtn').addEventListener('click', function (e) { e.preventDefault(); logout(); });
  }

  function setBadge(n) {
    var b = $('pendingBadge');
    if (!b) return;
    b.innerHTML = n > 0 ? '<span class="badge bg-warning text-dark">' + esc(n) + '</span>' : '';
  }

  function refreshBadge() {
    return api('/B/' + BOOK + '/pending-journals?status=pending&limit=1').then(function (r) {
      setBadge(r.total != null ? Number(r.total) : Number(r.count));
    }).catch(function () { /* 徽章失敗不打擾 */ });
  }

  var resumeFns = [];
  var started = false;
  function onResume(fn) { resumeFns.push(fn); }

  // 每個內頁開頭呼叫:沒登入就回登入頁;畫導覽;啟動徽章與回前景重抓
  function initPage(active) {
    if (!getToken()) { goLogin(''); return false; }
    buildNav(active);
    refreshBadge();
    if (!started) {
      started = true;
      setInterval(refreshBadge, 60000);
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) return;
        refreshBadge();
        resumeFns.forEach(function (fn) { try { fn(); } catch (_) { /* ignore */ } });
      });
    }
    return true;
  }

  // 登入頁用:每台裝置一個編號
  function deviceId() {
    try {
      var d = global.localStorage.getItem('device_id');
      if (d) return d;
      var id;
      if (global.crypto && global.crypto.randomUUID) {
        id = global.crypto.randomUUID();
      } else if (global.crypto && global.crypto.getRandomValues) {
        // 平板走一般 http 連線時沒有 randomUUID,自己用亂數組一個 uuid v4
        var b = global.crypto.getRandomValues(new Uint8Array(16));
        b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
        var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
        id = h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
      } else {
        id = 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      }
      global.localStorage.setItem('device_id', id);
      return id;
    } catch (_) { return 'dev-unknown'; }
  }

  // ───────────────────────── Bootstrap 樣式表沒載入時的備援 ─────────────────────────
  // 店內連不上外網時 bootstrap.min.css 也載不到:d-none 不生效 → 「載入中」收不掉、四張表單全攤開。
  // 量一個帶 d-none 的隱藏元素,沒變成 display:none 就注入最小備援樣式,並在頁首提醒。
  var FALLBACK_CSS = [
    '.d-none{display:none!important}',
    '.d-flex{display:flex}.flex-wrap{flex-wrap:wrap}.justify-content-between{justify-content:space-between}.align-items-center{align-items:center}',
    '.gap-2{gap:8px}.gap-3{gap:12px}.ms-auto{margin-left:auto}.w-100{width:100%}',
    '.text-center{text-align:center}.text-end{text-align:right}.small{font-size:13px}',
    '.text-muted{color:#888}.text-danger{color:#c4453a}.text-success{color:#1a6a5a}',
    '.container{max-width:1100px;margin:0 auto;padding:0 16px}',
    '.row{display:flex;flex-wrap:wrap;gap:12px}.row>*{flex:1 1 220px}',
    '.modal:not(.show){display:none}',
    '.collapse:not(.show){display:none}',
    '.alert{padding:8px 12px;border-radius:8px;background:#fdeae8;color:#a94a3a}.alert:empty{display:none}',
    '.spinner-border{display:none}',
    '.btn-close{border:0;background:transparent;font-size:22px;line-height:1;cursor:pointer}.btn-close::before{content:"\\00d7"}',
    '.form-control,.form-select{padding:6px 8px;border:1px solid #cfc8b8;border-radius:6px;max-width:100%}',
  ].join('\n');

  function checkStyles() {
    try {
      if (!document.body || document.getElementById('cc-style-warn')) return;
      var probe = document.createElement('div');
      probe.className = 'd-none';
      document.body.appendChild(probe);
      var ok = global.getComputedStyle(probe).display === 'none';
      document.body.removeChild(probe);
      if (ok) return;
      injectStyle();
      var st = document.createElement('style');
      st.id = 'cc-fallback-css';
      st.textContent = FALLBACK_CSS;
      document.head.appendChild(st);
      var warn = mk('div', 'cc-notice', '頁面樣式載不出來(店內連不上外網),功能照常。');
      warn.id = 'cc-style-warn';
      warn.style.margin = '8px 16px';
      document.body.insertBefore(warn, document.body.firstChild);
    } catch (_) { /* 備援失敗就算了,頁面照舊 */ }
  }
  if (document.body) checkStyles();
  else document.addEventListener('DOMContentLoaded', checkStyles);

  // ───────────────────────── 匯出 ─────────────────────────
  CC.esc = esc; CC.fmt = fmt; CC.fmtMoney = fmtMoney; CC.fmtSigned = fmtSigned;
  CC.fmtDate = fmtDate; CC.fmtDateTime = fmtDateTime; CC.todayLocal = todayLocal; CC.addDays = addDays;
  CC.api = api; CC.ask = ask; CC.askText = askText; CC.inlineResult = inlineResult; CC.toast = toast;
  CC.buildNav = buildNav; CC.initPage = initPage; CC.refreshBadge = refreshBadge; CC.onResume = onResume;
  CC.getBook = getBook; CC.loadRole = loadRole; CC.can = can; CC.lockBtn = lockBtn;
  CC.loadClosedThrough = loadClosedThrough; CC.closedOf = closedOf; CC.isClosedDate = isClosedDate;
  CC.pendingNotice = pendingNotice; CC.newRequestId = newRequestId; CC.makeModal = makeModal;
  CC.legGap = legGap; CC.pendingAmount = pendingAmount; CC.friendlyError = friendlyError;
  CC.go = go; CC.logout = logout; CC.deviceId = deviceId; CC.getToken = getToken; CC.getUser = getUser;
  CC.ROLE_NAME = ROLE_NAME; CC.ACCT_TYPE_NAME = ACCT_TYPE_NAME; CC.SUBJ_TYPE_NAME = SUBJ_TYPE_NAME;
  CC.MODE_TEXT = MODE_TEXT; CC.sourceName = sourceName; CC.eventName = eventName; CC.pendingEventName = pendingEventName;
  CC.CJK = CJK;

  global.CC = CC;
  global.BOOK = BOOK;
  global.$ = $;
  global.esc = esc; global.fmt = fmt; global.fmtMoney = fmtMoney; global.fmtSigned = fmtSigned;
  global.fmtDate = fmtDate; global.fmtDateTime = fmtDateTime; global.todayLocal = todayLocal; global.addDays = addDays;
  global.api = api; global.ask = ask; global.askText = askText; global.inlineResult = inlineResult;
  global.buildNav = buildNav;
})(window);
