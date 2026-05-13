#!/bin/bash
# bookkeeping-cloud 端到端 smoke test
# Usage: bash smoke_test.sh
# 跑完印 PASS / FAIL 各幾條

set +e
BASE="http://10.0.1.168:3001"
HR_BASE="http://10.0.1.168:3000"
OWNER_EMP="1989-G00001"
OWNER_PIN="0000"
HR_ADMIN_PW="062966"

pass=0; fail=0; lines=()

ok() { pass=$((pass+1)); lines+=("  ✓ $1"); }
ng() { fail=$((fail+1)); lines+=("  ✗ $1 — $2"); }

echo "=========================================="
echo " bookkeeping-cloud smoke test"
echo " base: $BASE"
echo "=========================================="

# T1: health + version
R=$(curl -s -m 5 "$BASE/health")
echo "$R" | grep -q '"status":"ok"' && ok "T1 /health 200 ok" || ng "T1 /health" "$R"
VER=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('version','?'))" 2>/dev/null)
echo "  → version: $VER"

# T2: login (owner) → get cloud JWT
LOGIN_RES=$(curl -s -m 10 -X POST -H 'Content-Type: application/json' \
  -d "{\"emp_id\":\"$OWNER_EMP\",\"pin\":\"$OWNER_PIN\"}" "$BASE/auth/login")
TOKEN=$(echo "$LOGIN_RES" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
USER_ID=$(echo "$LOGIN_RES" | python3 -c "import sys,json; print(json.load(sys.stdin).get('user',{}).get('id',''))" 2>/dev/null)
if [ -n "$TOKEN" ]; then ok "T2 owner login → JWT (user.id=$USER_ID)"; else ng "T2 owner login" "$LOGIN_RES"; fi
AUTH="Authorization: Bearer $TOKEN"

# T3: login with cloud_access='none' → 403
R=$(curl -s -m 10 -X POST -H 'Content-Type: application/json' \
  -d '{"emp_id":"2026-G00003","pin":"1807"}' "$BASE/auth/login")
echo "$R" | grep -q "未開通" && ok "T3 cloud_access=none → 403" || ng "T3 none-employee" "$R"

# T4: wrong PIN → 401
R=$(curl -s -m 10 -X POST -H 'Content-Type: application/json' \
  -d "{\"emp_id\":\"$OWNER_EMP\",\"pin\":\"WRONG999\"}" "$BASE/auth/login")
echo "$R" | grep -q "PIN" && ok "T4 wrong PIN → 401" || ng "T4 wrong PIN" "$R"

# T5: each HTML page → 200
for page in dashboard pending journals reports setup settings; do
  CODE=$(curl -s -m 5 -o /dev/null -w "%{http_code}" "$BASE/$page")
  [ "$CODE" = "200" ] && ok "T5 GET /$page → 200" || ng "T5 GET /$page" "HTTP $CODE"
done

# T6: GET /auth/me
R=$(curl -s -m 5 -H "$AUTH" "$BASE/auth/me")
NAME=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('user',{}).get('name',''))" 2>/dev/null)
EMP=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('user',{}).get('hr_emp_id',''))" 2>/dev/null)
if [ "$EMP" = "$OWNER_EMP" ]; then ok "T6 /auth/me hr_emp_id=$EMP, name=$NAME"; else ng "T6 /auth/me" "$R"; fi

# T7: GET book + my_role
R=$(curl -s -m 5 -H "$AUTH" "$BASE/B/NEST0001")
ROLE=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('my_role',''))" 2>/dev/null)
MODE=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('book',{}).get('posting_mode',''))" 2>/dev/null)
if [ "$ROLE" = "owner" ]; then ok "T7 GET /B/NEST0001 my_role=$ROLE posting_mode=$MODE"; else ng "T7 GET book" "$R"; fi

# T8: lookups (subjects/accounts/counterparties)
SUBJ=$(curl -s -m 5 -H "$AUTH" "$BASE/B/NEST0001/subjects" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('subjects',[])))" 2>/dev/null)
ACCT=$(curl -s -m 5 -H "$AUTH" "$BASE/B/NEST0001/accounts" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('accounts',[])))" 2>/dev/null)
CP=$(curl -s -m 5 -H "$AUTH" "$BASE/B/NEST0001/counterparties" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('counterparties',[])))" 2>/dev/null)
[ -n "$SUBJ" ] && ok "T8 lookups → subjects=$SUBJ accounts=$ACCT counterparties=$CP" || ng "T8 lookups" "?"

# T9: POST a test expense journal
R=$(curl -s -m 10 -X POST -H "$AUTH" -H 'Content-Type: application/json' -d '{
  "date":"2026-05-13","type":"expense","amount":100,
  "subject_id":22,"transfer_out_account_id":1,
  "summary":"smoke test expense"
}' "$BASE/B/NEST0001/journals")
JID=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('journal',{}).get('id',''))" 2>/dev/null)
if [ -n "$JID" ]; then ok "T9 POST journal expense $100 → id=$JID"; else ng "T9 POST journal" "$R"; fi

# T10: PATCH the journal (change amount + summary, edit_count+1)
R=$(curl -s -m 10 -X PATCH -H "$AUTH" -H 'Content-Type: application/json' -d '{
  "amount":150,"summary":"smoke test expense (edited)"
}' "$BASE/B/NEST0001/journals/$JID")
NEW_AMT=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('journal',{}).get('amount',''))" 2>/dev/null)
EDIT_CNT=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('journal',{}).get('edit_count',''))" 2>/dev/null)
if [ "$NEW_AMT" = "150.00" ]; then ok "T10 PATCH journal → amount=$NEW_AMT edit_count=$EDIT_CNT"; else ng "T10 PATCH" "$R"; fi

# T11: POST reclassify 1:N (origin=4101 income → targets 4101+4109 split)
# (這個 case 用 subject_id 1 = 4101 營業收入 → 兩個 targets 4109/4191 拆)
R=$(curl -s -m 10 -X POST -H "$AUTH" -H 'Content-Type: application/json' -d '{
  "date":"2026-05-13","type":"reclassify",
  "reclassify_from_subject_id":6,
  "targets":[{"subject_id":1,"amount":80},{"subject_id":2,"amount":20}],
  "summary":"smoke 1:N reclassify 訂金抵菜色+服務費"
}' "$BASE/B/NEST0001/journals")
RC_ID=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('journal',{}).get('id',''))" 2>/dev/null)
TARGETS_CNT=$(echo "$R" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('journal',{}).get('targets',[])))" 2>/dev/null)
if [ "$TARGETS_CNT" = "2" ]; then ok "T11 POST reclassify 1:N → id=$RC_ID targets=$TARGETS_CNT"; else ng "T11 reclassify 1:N" "$R"; fi

# T12: GET single journal含 targets
R=$(curl -s -m 5 -H "$AUTH" "$BASE/B/NEST0001/journals/$RC_ID")
TGT_AMT=$(echo "$R" | python3 -c "import sys,json; ts=json.load(sys.stdin).get('journal',{}).get('targets',[]); print(sum(float(t['amount']) for t in ts))" 2>/dev/null)
[ "$TGT_AMT" = "100.0" ] && ok "T12 GET journal targets sum=$TGT_AMT" || ng "T12 GET journal targets" "amt=$TGT_AMT, $R"

# T13: DELETE (reverse) the expense
R=$(curl -s -m 10 -X DELETE -H "$AUTH" "$BASE/B/NEST0001/journals/$JID")
RID=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reverse_journal',{}).get('id',''))" 2>/dev/null)
if [ -n "$RID" ]; then ok "T13 DELETE journal → reverse_id=$RID"; else ng "T13 DELETE journal" "$R"; fi

# T14: DELETE (reverse) the reclassify
curl -s -m 10 -X DELETE -H "$AUTH" "$BASE/B/NEST0001/journals/$RC_ID" > /dev/null && ok "T14 DELETE reclassify reverse" || ng "T14 reverse rc" "?"

# T15: reports — monthly
R=$(curl -s -m 5 -H "$AUTH" "$BASE/B/NEST0001/reports/monthly?year=2026&month=5")
PROFIT=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('profit',''))" 2>/dev/null)
[ -n "$PROFIT" ] && ok "T15 monthly profit=$PROFIT" || ng "T15 monthly" "$R"

# T16: reports — yearly
R=$(curl -s -m 5 -H "$AUTH" "$BASE/B/NEST0001/reports/yearly?year=2026")
MONTHS=$(echo "$R" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('monthly',[])))" 2>/dev/null)
[ "$MONTHS" = "12" ] && ok "T16 yearly 12 months" || ng "T16 yearly" "$R"

# T17: reports — counterparties
R=$(curl -s -m 5 -H "$AUTH" "$BASE/B/NEST0001/reports/counterparties?from=2026-01-01&to=2026-12-31")
echo "$R" | grep -q '"counterparties"' && ok "T17 counterparties report" || ng "T17 counterparties" "$R"

# T18: dashboard report
R=$(curl -s -m 5 -H "$AUTH" "$BASE/B/NEST0001/reports/dashboard")
TB=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total_balance',''))" 2>/dev/null)
[ -n "$TB" ] && ok "T18 dashboard total_balance=$TB" || ng "T18 dashboard" "$R"

# T19: PATCH posting_mode toggle (review → auto → review)
R=$(curl -s -m 5 -X PATCH -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"posting_mode":"auto"}' "$BASE/B/NEST0001")
M=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('book',{}).get('posting_mode',''))" 2>/dev/null)
[ "$M" = "auto" ] && ok "T19a posting_mode → auto" || ng "T19a auto" "$R"
R=$(curl -s -m 5 -X PATCH -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"posting_mode":"review"}' "$BASE/B/NEST0001")
M=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('book',{}).get('posting_mode',''))" 2>/dev/null)
[ "$M" = "review" ] && ok "T19b posting_mode → review" || ng "T19b review" "$R"

# T20: PATCH book name (then restore via python urllib to avoid Windows bash CJK encoding)
# Windows Git Bash 把單引號內中文按本機 codepage (Big5) 送出去 → server 存 Big5 bytes,
# 之後 response 解 UTF-8 變亂碼. 用 python urllib 強制 UTF-8 body 才能正確送 CJK.
TEST_NAME="smoke_test_book_$$"
R=$(curl -s -m 5 -X PATCH -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"name\":\"$TEST_NAME\"}" "$BASE/B/NEST0001")
N=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('book',{}).get('name',''))" 2>/dev/null)
[ "$N" = "$TEST_NAME" ] && ok "T20a PATCH book name → $N" || ng "T20a PATCH name (got=$N)" "$R"

# T20b: 用 python urllib send UTF-8 + 比對
N=$(TOKEN_ENV="$TOKEN" python3 - <<'PY' 2>/dev/null
import os, urllib.request, json, sys
sys.stdout.reconfigure(encoding='utf-8')
req = urllib.request.Request('http://10.0.1.168:3001/B/NEST0001', method='PATCH',
  headers={'Authorization': 'Bearer ' + os.environ['TOKEN_ENV'], 'Content-Type': 'application/json; charset=utf-8'},
  data=json.dumps({'name': '花現鳥巢'}).encode('utf-8'))
try:
  res = urllib.request.urlopen(req, timeout=10)
  print(json.load(res).get('book', {}).get('name', ''))
except Exception as e:
  print('ERR:' + str(e))
PY
)
# 用 hex 比對避免 bash 印出亂碼: 花現鳥巢 utf-8 = e88ab1e78fbee9b3a5e5b7a2
HEX=$(printf '%s' "$N" | od -An -tx1 | tr -d ' \n')
[ "$HEX" = "e88ab1e78fbee9b3a5e5b7a2" ] && ok "T20b restore book name (UTF-8 hex matches)" || ng "T20b restore (hex=$HEX)" "$N"

# T21: 410 endpoints
R=$(curl -s -m 5 -o /dev/null -w "%{http_code}" -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/auth/register")
[ "$R" = "410" ] && ok "T21a register → 410" || ng "T21a register" "$R"
R=$(curl -s -m 5 -o /dev/null -w "%{http_code}" -X POST -H "$AUTH" -d '{}' "$BASE/auth/change-password")
[ "$R" = "410" ] && ok "T21b change-password → 410" || ng "T21b change-password" "$R"
R=$(curl -s -m 5 -o /dev/null -w "%{http_code}" -X POST -H "$AUTH" -H 'Content-Type: application/json' -d '{"email":"x","role":"viewer"}' "$BASE/B/NEST0001/members")
[ "$R" = "410" ] && ok "T21c add member → 410" || ng "T21c add member" "$R"

# T22: HR cloud_access toggle 即時生效
HR_TOKEN=$(curl -s -X POST -H 'Content-Type: application/json' -d "{\"admin_pw\":\"$HR_ADMIN_PW\"}" "$HR_BASE/api/auth/admin-login" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
curl -s -m 5 -X POST -H "Authorization: Bearer $HR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"emp_id":"2026-G00003","cloud_access":"editor"}' "$HR_BASE/api/auth/update-cloud-access" > /dev/null
R=$(curl -s -m 10 -X POST -H 'Content-Type: application/json' -d '{"emp_id":"2026-G00003","pin":"1807"}' "$BASE/auth/login")
ACC=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('user',{}).get('cloud_access',''))" 2>/dev/null)
[ "$ACC" = "editor" ] && ok "T22a cloud_access toggle 即時生效 (none→editor)" || ng "T22a toggle on" "$R"
curl -s -m 5 -X POST -H "Authorization: Bearer $HR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"emp_id":"2026-G00003","cloud_access":"none"}' "$HR_BASE/api/auth/update-cloud-access" > /dev/null
R=$(curl -s -m 10 -X POST -H 'Content-Type: application/json' -d '{"emp_id":"2026-G00003","pin":"1807"}' "$BASE/auth/login")
echo "$R" | grep -q "未開通" && ok "T22b cloud_access 收回 (editor→none) 即時生效" || ng "T22b toggle off" "$R"

# ── 報告 ──
echo ""
echo "=========================================="
printf '%s\n' "${lines[@]}"
echo "=========================================="
echo " PASS: $pass    FAIL: $fail    Version: $VER"
echo "=========================================="
[ $fail -eq 0 ] && exit 0 || exit 1
