// scripts/test_reconcile.js
// 對帳(reconcileCron)+ 每日覆核(dailyReviewCron)+ alertService 的單元測試。
// 不需要 PostgreSQL:把 src/db 換成記憶體假的,現場系統用本機 http 假伺服器。
//   node scripts/test_reconcile.js        全過 exit 0,有紅 exit 1

'use strict';

const http = require('http');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`); }
}
function eq(actual, expected, name) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), name, { actual, expected });
}

// ── 假的 src/db ────────────────────────────────────────────────────────
const dbPath = require.resolve(path.join('..', 'src', 'db.js'));
const state = {
  books: [{ id: 1, code: 'NEST0001' }],
  journals: [],      // { id, external_source, external_id, amount, reversed_by_id, reverses_id, date }
  pendings: [],      // { id, external_source, external_id, status }
  recon: new Map(),  // `${date}|${source}|${id}` → row
  sqlLog: [],
};
function reconKey(date, src, id) { return `${date}|${src}|${id}`; }

async function fakeQuery(text, params = []) {
  state.sqlLog.push(text);
  const t = text.replace(/\s+/g, ' ');
  if (/FROM books WHERE code/.test(t)) {
    return { rows: state.books.filter(b => b.code === params[0]) };
  }
  if (/FROM books WHERE id/.test(t)) {
    return { rows: state.books.filter(b => b.id === params[0]) };
  }
  if (/FROM journal_logs WHERE book_id = \$1 AND date = \$2::date/.test(t)) {
    return { rows: state.journals.filter(j => j.date === params[1] && j.external_source && !j.reversed_by_id && !j.reverses_id) };
  }
  if (/FROM journal_logs WHERE book_id = \$1 AND external_source = \$2/.test(t)) {
    const [, src, ext, prefix] = params;
    return {
      rows: state.journals
        .filter(j => j.external_source === src && (j.external_id === ext || j.external_id.startsWith(prefix)))
        .sort((a, b) => b.id - a.id),
    };
  }
  if (/FROM pending_journals WHERE book_id = \$1 AND external_source = \$2/.test(t)) {
    const [, src, ext, prefix] = params;
    return {
      rows: state.pendings
        .filter(p => p.external_source === src && (p.external_id === ext || p.external_id.startsWith(prefix)))
        .sort((a, b) => b.id - a.id),
    };
  }
  if (/SELECT external_source, external_id, bucket FROM recon_results/.test(t)) {
    const rows = [...state.recon.values()].filter(r => r.recon_date === params[1] && r.external_source !== '_run');
    return { rows };
  }
  if (/SELECT 1 FROM recon_results WHERE book_id = \$1 AND external_source = \$2 AND external_id = ANY/.test(t)) {
    const [, src, ids, date] = params;
    const hit = [...state.recon.values()].filter(r =>
      r.external_source === src && ids.includes(r.external_id) && r.recon_date !== date && r.cloud_status !== 'stale');
    return { rows: hit.length ? [{ '?column?': 1 }] : [] };
  }
  if (/SELECT 1 FROM recon_results WHERE book_id = \$1 AND recon_date = \$2::date AND external_source = '_run'/.test(t)) {
    const r = state.recon.get(reconKey(params[1], '_run', 'daily'));
    return { rows: r && r.cloud_status === 'ok' ? [{ '?column?': 1 }] : [] };
  }
  if (/INSERT INTO recon_results/.test(t)) {
    const [book_id, recon_date, external_source, external_id, event_type, leo_amount, leo_status, cloud_status, bucket, detail] = params;
    state.recon.set(reconKey(recon_date, external_source, external_id), {
      book_id, recon_date, external_source, external_id, event_type, leo_amount, leo_status, cloud_status, bucket, detail,
    });
    return { rows: [] };
  }
  if (/UPDATE recon_results SET cloud_status = 'stale'/.test(t)) {
    const [, date, seen] = params;
    for (const r of state.recon.values()) {
      if (r.recon_date === date && r.external_source !== '_run' && r.cloud_status !== 'stale'
          && !seen.includes(`${r.external_source}|${r.external_id}`)) {
        r.cloud_status = 'stale'; r.bucket = 'settled'; r.detail = '現場清單已不再列出這筆';
      }
    }
    return { rows: [] };
  }
  throw new Error('fakeQuery: 沒處理的 SQL: ' + t.slice(0, 120));
}
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query: fakeQuery, getPool() {}, withTransaction() {} } };

// ── 假的現場系統(recon-summary)───────────────────────────────────────
let summaryBody = { events: [], outbox: { pending: 0, sending: 0, dead: [] } };
let summaryStatus = 200;
const leo = http.createServer((req, res) => {
  res.statusCode = summaryStatus;
  res.setHeader('Content-Type', 'application/json');
  res.end(summaryStatus === 200 ? JSON.stringify(summaryBody) : '{"error":"boom"}');
});

(async () => {
  await new Promise(r => leo.listen(0, '127.0.0.1', r));
  process.env.LEO_BASE_URL = `http://127.0.0.1:${leo.address().port}`;
  delete process.env.NTFY_URL;

  const recon = require('../src/reconcileCron');
  const review = require('../src/dailyReviewCron');
  const alertService = require('../src/alertService');
  const NOW = new Date('2026-10-10T10:00:00+08:00');   // 對帳日期要相對這個「今天」

  // ── 1. bizDate(5 點換日,台北時區)────────────────────────────────
  console.log('[bizDate]');
  eq(review.bizDate(new Date('2026-10-10T04:59:00+08:00')), '2026-10-09', '04:59 算前一天');
  eq(review.bizDate(new Date('2026-10-10T05:00:00+08:00')), '2026-10-10', '05:00 算當天');
  eq(review.bizDate(new Date('2026-10-10T23:55:00+08:00')), '2026-10-10', '23:55 算當天');
  eq(review.bizDate(new Date('2026-11-01T02:30:00+08:00')), '2026-10-31', '月初凌晨算上個月最後一天');
  eq(review.bizDate(new Date('2026-10-09T21:00:00Z')), '2026-10-10', 'UTC 21:00 = 台北 05:00 → 當天(不吃機器時區)');
  eq(review.bizDate(new Date('2026-10-09T20:59:00Z')), '2026-10-09', 'UTC 20:59 = 台北 04:59 → 前一天');

  // ── 2. cloudStatusOf + classify ─────────────────────────────────────
  console.log('[cloudStatusOf / classify]');
  const evOf = (o) => Object.assign({
    external_source: 'leo_expense', event_type: 'expense.created', external_id: 'expense:E1', amount: 500, leo_status: 'sent',
  }, o);
  const evaluate = (ev, extra) => recon.evaluateEvent(1, ev, Object.assign({ reconDate: '2026-10-09', now: NOW }, extra));
  const reset = () => { state.journals.length = 0; state.pendings.length = 0; };

  reset();
  state.journals.push({ id: 10, external_source: 'leo_expense', external_id: 'expense:E1', amount: '500.00', reversed_by_id: null });
  let r = await evaluate(evOf({}));
  eq([r.bucket, r.detail], ['settled', null], '金額相同 → settled');

  r = await evaluate(evOf({ amount: 600 }));
  eq(r.bucket, 'diff', '金額不同 → diff');
  ok(r.detail && r.detail.includes('金額不符') && r.detail.includes('$600') && r.detail.includes('$500'), '金額不符的說明有現場與帳本兩個數字', r.detail);

  r = await evaluate(evOf({ amount: null }));
  eq(r.bucket, 'settled', '現場沒給金額(舊版)→ 不比金額');
  r = await evaluate(evOf({ event_type: 'pos_deposit_offset', amount: 77 }));
  eq(r.bucket, 'settled', '訂金抵用不比金額(科目腳合計本來就是 0)');
  r = await evaluate(evOf({ event_type: 'pos_deposit_offset_return', amount: 77 }));
  eq(r.bucket, 'settled', '整單退款還回訂金(反向事件 pos_deposit_offset_return)同樣不比金額');

  // R8:改單後雲端是 @v2,舊單號被沖銷
  reset();
  state.journals.push({ id: 10, external_source: 'leo_expense', external_id: 'expense:E1', amount: '500.00', reversed_by_id: 11 });
  state.journals.push({ id: 12, external_source: 'leo_expense', external_id: 'expense:E1@v2', amount: '450.00', reversed_by_id: null });
  r = await evaluate(evOf({ amount: 450 }));
  eq([r.cloud_status, r.bucket], ['posted', 'settled'], 'reversed 的舊單 → 追到 @v2,金額一致 → settled');
  r = await evaluate(evOf({ amount: 500 }));
  eq(r.bucket, 'diff', '追到 @v2 之後,現場還拿舊金額 → 金額不符');
  r = await evaluate(evOf({ external_id: 'expense:E1@v2', amount: 450 }));
  eq(r.bucket, 'settled', '現場直接給 @v2 的單號 → settled');

  reset();
  state.journals.push({ id: 10, external_source: 'leo_expense', external_id: 'expense:E1', amount: '500.00', reversed_by_id: 11 });
  r = await evaluate(evOf({}));
  eq([r.cloud_status, r.bucket], ['reversed', 'diff'], '被沖銷又沒有新版 → diff(不能算已入帳)');

  reset();   // v1 已沖銷、v2 在待審 → 在途
  state.journals.push({ id: 10, external_source: 'leo_expense', external_id: 'expense:E1', amount: '500.00', reversed_by_id: 11 });
  state.pendings.push({ id: 5, external_source: 'leo_expense', external_id: 'expense:E1@v2', status: 'pending' });
  r = await evaluate(evOf({}));
  eq([r.cloud_status, r.bucket], ['pending_review', 'in_transit'], 'v1 沖銷 + v2 待審 → in_transit');

  reset();   // 現場問 @v2,雲端只有 v1(v2 還沒到)→ 不能拿 v1 當 v2 入帳
  state.journals.push({ id: 10, external_source: 'leo_expense', external_id: 'expense:E1', amount: '500.00', reversed_by_id: null });
  r = await evaluate(evOf({ external_id: 'expense:E1@v2', leo_status: 'pending' }));
  eq([r.cloud_status, r.bucket], ['missing', 'in_transit'], '現場 @v2 雲端只有 v1 → missing、現場佇列中 → in_transit');

  // R9 / 拍板 6:在途超過 3 天
  reset();
  state.pendings.push({ id: 5, external_source: 'leo_expense', external_id: 'expense:E1', status: 'pending' });
  r = await evaluate(evOf({}), { reconDate: '2026-10-09' });
  eq(r.bucket, 'in_transit', '在途 1 天 → in_transit');
  r = await evaluate(evOf({}), { reconDate: '2026-10-07' });
  eq(r.bucket, 'in_transit', '在途剛好 3 天 → 還是 in_transit(超過才算)');
  r = await evaluate(evOf({}), { reconDate: '2026-10-06' });
  eq(r.bucket, 'diff', '在途 4 天 → diff');
  ok(r.detail && r.detail.includes('在途超過 3 天'), '說明寫「在途超過 3 天」', r.detail);
  reset();
  r = await evaluate(evOf({ leo_status: 'pending' }), { reconDate: '2026-10-01' });
  eq(r.bucket, 'diff', '現場推送佇列中卡 9 天 → diff');

  // Y30:isDead 優先序
  reset();
  state.journals.push({ id: 10, external_source: 'leo_expense', external_id: 'expense:E1', amount: '500.00', reversed_by_id: null });
  r = await evaluate(evOf({}), { isDead: true });
  eq(r.bucket, 'settled', '雲端已入帳 + 現場留著 dead → settled(入帳優先)');
  reset();
  r = await evaluate(evOf({ leo_status: 'dead' }), { isDead: true });
  eq(r.bucket, 'diff', '雲端沒有 + dead → diff');
  ok(r.detail.includes('可補推'), 'dead 的說明保留「可補推」(前端按鈕判斷)', r.detail);
  r = await evaluate(evOf({ leo_status: null }));
  eq(r.bucket, 'diff', '現場沒排入推送 → diff');
  reset();
  state.pendings.push({ id: 6, external_source: 'leo_expense', external_id: 'expense:E1', status: 'rejected' });
  r = await evaluate(evOf({}));
  eq(r.bucket, 'settled', '已人工退回 → settled(有交代)');

  // ── 3. runFor 整條:比對 + 反方向 + stale + 失敗記錄 ─────────────────
  console.log('[runFor 整條]');
  reset(); state.recon.clear();
  const D = '2026-10-09';
  state.journals.push(
    { id: 20, external_source: 'leo_pos', external_id: 'pos_shift:1', amount: '1000.00', reversed_by_id: null, date: D },
    { id: 21, external_source: 'leo_expense', external_id: 'expense:E1@v2', amount: '450.00', reversed_by_id: null, date: D },
    { id: 22, external_source: 'leo_expense', external_id: 'expense:E9', amount: '80.00', reversed_by_id: null, date: D },   // 現場清單沒有
    { id: 19, external_source: 'leo_expense', external_id: 'expense:E1', amount: '500.00', reversed_by_id: 21, date: D },    // 已沖銷的舊版,不算「現場沒有」
  );
  // 上一輪留下、這次現場不再列出的舊列
  state.recon.set(reconKey(D, 'leo_expense', 'expense:OLD'), {
    recon_date: D, external_source: 'leo_expense', external_id: 'expense:OLD', cloud_status: 'posted', bucket: 'settled', detail: null,
  });
  summaryBody = {
    events: [
      { external_source: 'leo_pos', event_type: 'pos_shift_settled', external_id: 'pos_shift:1', amount: 900, leo_status: 'sent' },
      { external_source: 'leo_expense', event_type: 'expense.created', external_id: 'expense:E1', amount: 450, leo_status: 'sent' },
      { external_source: 'leo_expense', event_type: 'expense.created', external_id: 'expense:E2', amount: 60, leo_status: 'sent' },
    ],
    outbox: { pending: 0, sending: 0, dead: [] },
  };
  const counts = await recon.runFor('NEST0001', D);
  const row = (src, id) => state.recon.get(reconKey(D, src, id));
  eq(row('leo_pos', 'pos_shift:1').bucket, 'diff', '收班金額少 100 → diff');
  ok(row('leo_pos', 'pos_shift:1').detail.includes('金額不符'), '收班差異寫金額不符');
  eq(row('leo_expense', 'expense:E1').bucket, 'settled', '改單的支出追到 @v2 → settled');
  eq(row('leo_expense', 'expense:E2').bucket, 'diff', '現場有、雲端無、現場說已送出 → diff');
  const co = row('leo_expense', 'expense:E9');
  ok(co && co.bucket === 'diff' && co.detail.includes('現場沒有這筆'), '反方向:帳本有現場沒有 → diff「現場沒有這筆」', co);
  ok(!row('leo_expense', 'expense:E1@v2'), '@v2 不會被誤當成「現場沒有」');
  eq(row('leo_expense', 'expense:OLD').cloud_status, 'stale', '現場不再列出的舊列 → stale');
  eq(counts, { settled: 1, in_transit: 0, diff: 3 }, 'runFor 回傳的 counts');
  eq(row('_run', 'daily').cloud_status, 'ok', '跑成會記 _run ok');

  // 失敗:現場連不上
  summaryStatus = 500;
  let threw = false;
  try { await recon.runFor('NEST0001', '2026-10-08'); } catch (e) { threw = true; }
  ok(threw, '現場連不上 → runFor throw');
  const failRow = state.recon.get(reconKey('2026-10-08', '_run', 'daily'));
  ok(failRow && failRow.cloud_status === 'failed' && failRow.bucket === 'diff', '失敗會記 _run failed', failRow);
  ok(failRow && failRow.detail.includes('沒跑成'), '失敗說明是白話', failRow && failRow.detail);
  summaryStatus = 200;

  // runDaily:回驗 8 天(昨天 + 往前 7 天),逐天成功 → ran:true
  state.recon.clear();
  summaryBody = { events: [], outbox: { pending: 0, sending: 0, dead: [] } };
  const daily = await recon.runDaily(NOW);
  eq(daily.ran, true, 'runDaily 成功 → ran:true');
  eq(daily.dates.map(d => d.date), ['2026-10-09', '2026-10-08', '2026-10-07', '2026-10-06', '2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02'], '回驗:昨天 + 往前 7 天');
  const done = await recon.catchUp(new Date('2026-10-10T09:00:00+08:00'));
  eq(done.skipped, 'already-ran', '啟動補跑:昨天已跑成 → 不重跑');
  summaryStatus = 500;
  const dailyFail = await recon.runDaily(NOW);
  eq(dailyFail.ran, false, 'runDaily 現場連不上 → ran:false(不 throw)');
  const failedYesterday = await recon.catchUp(new Date('2026-10-10T09:00:00+08:00'));
  eq(failedYesterday.ran, false, '昨天記了 failed → 啟動補跑會再試(這次仍連不上 → ran:false)');
  summaryStatus = 200;
  state.recon.clear();
  const early = await recon.catchUp(new Date('2026-10-10T03:00:00+08:00'));
  eq(early.skipped, 'before-schedule', '啟動補跑:還沒到 04:10 → 等排程');
  const redo = await recon.catchUp(new Date('2026-10-10T09:00:00+08:00'));
  eq(redo.ran, true, '啟動補跑:昨天沒跑成又已過 04:10 → 補跑');

  // ── 4. 排程字串 / alertService ───────────────────────────────────────
  console.log('[排程 / alertService]');
  eq(recon.RECON_SCHEDULE, '10 4 * * *', '對帳排程 10 4 * * *');
  eq(review.REVIEW_SCHEDULE, '55 23 * * *', '每日覆核排程 55 23 * * *');
  eq(alertService.mode(), 'console-only', '沒設 NTFY_URL → console-only');
  process.env.NTFY_URL = 'http://127.0.0.1:1/topic';
  eq(alertService.mode(), 'ntfy', '設了 NTFY_URL → ntfy');
  delete process.env.NTFY_URL;
  ok(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/.test(alertService._encodeHeader('對帳發現差異')), '中文標題用 RFC 2047 編碼(HTTP header 只能 ASCII)');
  ok((await alertService.notify('測試', '內容')) === false, 'console-only 時 notify 回 false 且不 throw');

  leo.close();
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}: PASS=${pass} FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('測試本身出錯:', e);
  process.exit(2);
});
