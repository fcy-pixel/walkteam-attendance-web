/* ═══════════════════════════════════════════════════════════════════════════
   歸程隊點名系統 — Pure Frontend (Firebase Client SDK)
   ═══════════════════════════════════════════════════════════════════════════ */

// ── Firebase Config ──────────────────────────────────────────────────────────
// ⚠️ 請將以下 FIREBASE_API_KEY / FIREBASE_SENDER_ID / FIREBASE_APP_ID
//    替換為你的 Firebase 專案 walkteam-6ffb5 的 Web SDK 設定值。
//    取得方式：Firebase Console → 專案設定 → 一般 → 你的應用程式 → Web
const firebaseConfig = {
  apiKey: "FIREBASE_API_KEY",
  authDomain: "walkteam-6ffb5.firebaseapp.com",
  projectId: "walkteam-6ffb5",
  storageBucket: "walkteam-6ffb5.firebasestorage.app",
  messagingSenderId: "FIREBASE_SENDER_ID",
  appId: "FIREBASE_APP_ID",
};

// ── Config validation ────────────────────────────────────────────────────────
const CONFIG_READY = firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("FIREBASE_");

let db;
if (CONFIG_READY) {
  firebase.initializeApp(firebaseConfig);
  db = firebase.firestore();
}

function showConfigError() {
  document.getElementById("login-screen").innerHTML = `
    <div class="login-box" style="max-width:500px;">
      <div class="login-icon">⚙️</div>
      <h2>需要設定 Firebase</h2>
      <p style="color:#64748b;font-size:.85rem;margin:8px 0 16px;line-height:1.6;text-align:left;">
        請到 <a href="https://console.firebase.google.com/project/walkteam-6ffb5/settings/general" target="_blank">Firebase Console</a> 完成以下步驟：<br><br>
        1. 開啟專案 <strong>walkteam-6ffb5</strong><br>
        2. 進入「專案設定」→「一般」<br>
        3. 往下找「你的應用程式」，如果沒有 Web 應用，按「新增應用程式」→ Web<br>
        4. 複製 <code>firebaseConfig</code> 的內容<br>
        5. 編輯 <code>app.js</code> 第 3-9 行，替換掉 placeholder 值<br>
        6. 推送到 GitHub 即可<br><br>
        另外記得設定 Firestore 安全規則允許讀寫。
      </p>
    </div>`;
}

// ── Constants ────────────────────────────────────────────────────────────────
const TEAMS = { A: "A隊", B: "B隊", C: "C隊" };
const PWD = "ktps";
const WEEKDAYS = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"];
const STAT_LABEL = { present: "已到", absent: "未到", skipped: "不跟歸程隊" };

// ── State ────────────────────────────────────────────────────────────────────
let currentTeam = localStorage.getItem("wt_team") || "C";
let authenticated = localStorage.getItem("wt_auth") === "1";
let students = [];
let records = {};
let computed = [];
let lastScanTs = 0;
let qrScanner = null;
let noteEditing = {};
let csvParsed = null;

// ── Helpers ──────────────────────────────────────────────────────────────────
function hkNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Hong_Kong" }));
}
function todayStr() {
  const n = hkNow();
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
}
function todayLabel() {
  const n = hkNow();
  return `${n.getFullYear()}年${n.getMonth()+1}月${n.getDate()}日　${WEEKDAYS[n.getDay() === 0 ? 6 : n.getDay()-1]}`;
}
function todayActs(student) {
  const wd = WEEKDAYS[hkNow().getDay() === 0 ? 6 : hkNow().getDay()-1];
  return (student.activities || []).filter(a => a.startsWith(wd));
}
function colStudents() { return `students_${currentTeam}`; }
function colRecords() { return `daily_records_${currentTeam}`; }
function teamLabel() { return `歸程隊${TEAMS[currentTeam] || currentTeam}`; }

function escHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg, type = "") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// ── Loading overlay ──────────────────────────────────────────────────────────
function showLoading(msg = "載入中…") {
  let ov = document.getElementById("loading-overlay");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "loading-overlay";
    ov.className = "loading-overlay";
    ov.innerHTML = `<div class="loading-box"><div class="spinner"></div><div>${escHtml(msg)}</div></div>`;
    document.body.appendChild(ov);
  }
}
function hideLoading() {
  const ov = document.getElementById("loading-overlay");
  if (ov) ov.remove();
}

// ═══════════════════════════════════════════════════════════════════════════
// DATA
// ═══════════════════════════════════════════════════════════════════════════
async function loadStudents() {
  const snap = await db.collection(colStudents()).get();
  students = snap.docs.map(d => d.data());
  students.sort((a, b) => {
    if (a.class !== b.class) return (a.class || "").localeCompare(b.class || "");
    return (parseInt(a.number) || 0) - (parseInt(b.number) || 0);
  });
  return students;
}

async function loadRecords(date) {
  const snap = await db.collection(colRecords()).doc(date).get();
  if (snap.exists) {
    return (snap.data().records || {});
  }
  return {};
}

async function loadDates() {
  const snap = await db.collection(colRecords()).get();
  return snap.docs.map(d => d.id).sort().reverse();
}

function mergeData(studs, recs) {
  return studs.map(s => ({
    ...s,
    status: (recs[s.id] && recs[s.id].status) || "absent",
    time: (recs[s.id] && recs[s.id].time) || "",
    dailyNote: (recs[s.id] && recs[s.id].dailyNote) || "",
  }));
}

async function setStatus(student, newStatus) {
  const td = todayStr();
  const now = hkNow();
  const data = {
    date: td,
    timestamp: now.getTime() / 1000,
    records: {
      [student.id]: {
        status: newStatus,
        time: newStatus === "present" ? `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}` : null,
        name: student.name,
        class: student.class || "",
        number: student.number || "",
      }
    }
  };
  await db.collection(colRecords()).doc(td).set(data, { merge: true });
}

async function setNote(student, note) {
  const td = todayStr();
  const now = hkNow();
  await db.collection(colRecords()).doc(td).set({
    date: td,
    timestamp: now.getTime() / 1000,
    records: {
      [student.id]: {
        dailyNote: note,
        name: student.name,
        class: student.class || "",
        number: student.number || "",
      }
    }
  }, { merge: true });
}

async function bulkSetSkipped(studentsList) {
  const td = todayStr();
  const now = hkNow();
  const recsMap = {};
  studentsList.forEach(s => {
    recsMap[s.id] = {
      status: "skipped", time: null,
      name: s.name, class: s.class || "", number: s.number || "",
    };
  });
  await db.collection(colRecords()).doc(td).set(
    { date: td, timestamp: now.getTime() / 1000, records: recsMap },
    { merge: true }
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// CSV
// ═══════════════════════════════════════════════════════════════════════════
function makeCsv(data, date) {
  let csv = `日期：${date}\n`;
  csv += "班級,學號,姓名,狀態,報到時間,今日通報,備註(跟隨),活動\n";
  data.forEach(s => {
    const acts = (s.activities || []).join("、");
    csv += [s.class||"", s.number||"", s.name||"",
            STAT_LABEL[s.status]||"未到", s.time||"", s.dailyNote||"",
            s.notes||"", acts].map(v => `"${String(v).replace(/"/g,'""')}"`).join(",") + "\n";
  });
  return "\ufeff" + csv;
}

function downloadCsv(content, filename) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/);
  const result = [];
  for (const line of lines) {
    const row = [];
    let inQuotes = false, field = "";
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"' && line[i+1] === '"') { field += '"'; i++; }
        else if (c === '"') inQuotes = false;
        else field += c;
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ',') { row.push(field); field = ""; }
        else field += c;
      }
    }
    row.push(field);
    result.push(row);
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════════════════════════════
function initLogin() {
  const screen = document.getElementById("login-screen");
  const app = document.getElementById("app");
  const teamSel = document.getElementById("login-team");
  const pwdInput = document.getElementById("login-pwd");
  const btn = document.getElementById("login-btn");
  const errMsg = document.getElementById("login-error");

  teamSel.value = currentTeam;

  if (authenticated) {
    screen.style.display = "none";
    app.style.display = "block";
    initApp();
    return;
  }

  btn.addEventListener("click", () => {
    if (pwdInput.value === PWD) {
      currentTeam = teamSel.value;
      authenticated = true;
      localStorage.setItem("wt_auth", "1");
      localStorage.setItem("wt_team", currentTeam);
      screen.style.display = "none";
      app.style.display = "block";
      errMsg.style.display = "none";
      initApp();
    } else {
      errMsg.style.display = "block";
    }
  });

  pwdInput.addEventListener("keydown", e => {
    if (e.key === "Enter") btn.click();
  });
}

function logout() {
  authenticated = false;
  localStorage.removeItem("wt_auth");
  document.getElementById("app").style.display = "none";
  document.getElementById("login-screen").style.display = "flex";
  document.getElementById("login-pwd").value = "";
  if (qrScanner) {
    try { qrScanner.stop(); } catch(e) {}
    qrScanner = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// APP INIT
// ═══════════════════════════════════════════════════════════════════════════
async function initApp() {
  startClock();
  initTabs();
  initSettingsEvents();
  showLoading("載入資料中…");
  try {
    await refreshData();
  } catch(e) {
    console.error(e);
    showToast("❌ Firebase 連線失敗", "error");
  }
  hideLoading();
  initQrScanner();
  initManualSearch();
  document.getElementById("refresh-btn").addEventListener("click", async () => {
    showLoading("重新整理…");
    await refreshData();
    hideLoading();
    showToast("✅ 已更新");
  });
}

async function refreshData() {
  const td = todayStr();
  [students, records] = await Promise.all([loadStudents(), loadRecords(td)]);
  computed = mergeData(students, records);
  updateHeader();
  renderCurrentTab();
}

// ═══════════════════════════════════════════════════════════════════════════
// CLOCK
// ═══════════════════════════════════════════════════════════════════════════
function startClock() {
  function tick() {
    const now = hkNow();
    const pad = n => String(n).padStart(2, '0');
    document.getElementById("hkt-clock").textContent =
      `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }
  tick();
  setInterval(tick, 1000);
}

// ═══════════════════════════════════════════════════════════════════════════
// HEADER
// ═══════════════════════════════════════════════════════════════════════════
function updateHeader() {
  document.getElementById("header-team-label").textContent = teamLabel();
  document.getElementById("header-date").textContent = todayLabel();
  const presentN = computed.filter(s => s.status === "present").length;
  const skippedN = computed.filter(s => s.status === "skipped").length;
  const totalN = computed.length;
  const pct = totalN ? Math.round(presentN / totalN * 100) : 0;
  document.getElementById("header-present").textContent = presentN;
  document.getElementById("header-total").textContent = totalN;
  document.getElementById("header-progress").style.width = pct + "%";
  document.getElementById("header-pct").textContent = `出席率 ${pct}%`;
  const badge = document.getElementById("header-skipped-badge");
  if (skippedN > 0) {
    badge.style.display = "inline-block";
    badge.textContent = `🚫 ${skippedN}  不跟歸程隊`;
  } else {
    badge.style.display = "none";
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TABS
// ═══════════════════════════════════════════════════════════════════════════
let activeTab = "scan";

function initTabs() {
  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab;
      document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".tab-content").forEach(c => c.style.display = "none");
      document.getElementById(`tab-${activeTab}`).style.display = "block";
      renderCurrentTab();
    });
  });
}

function renderCurrentTab() {
  switch(activeTab) {
    case "scan": renderScanTab(); break;
    case "list": renderListTab(); break;
    case "history": renderHistoryTab(); break;
    case "settings": break;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// QR SCANNER
// ═══════════════════════════════════════════════════════════════════════════
function initQrScanner() {
  if (qrScanner) return;
  const reader = document.getElementById("qr-reader");
  qrScanner = new Html5Qrcode("qr-reader");

  qrScanner.start(
    { facingMode: "environment" },
    { fps: 15, qrbox: { width: 200, height: 200 }, aspectRatio: 1.333 },
    onQrDecoded,
    () => {}
  ).then(() => {
    document.getElementById("qr-loading").style.display = "none";
    reader.style.display = "block";
    document.getElementById("qr-overlay").style.display = "flex";
  }).catch(err => {
    document.getElementById("qr-loading").innerHTML =
      `<div style="color:#f87171;text-align:center;padding:16px;font-size:13px;">
        ⚠️ 無法開啟相機<br><small style="opacity:.7;margin-top:6px;display:block">${escHtml(String(err))}</small>
      </div>`;
  });
}

async function onQrDecoded(text) {
  const now = Date.now();
  if (text === onQrDecoded._lastText && now - onQrDecoded._lastTs < 3000) return;
  onQrDecoded._lastText = text;
  onQrDecoded._lastTs = now;

  const bar = document.getElementById("qr-status");
  const barTxt = document.getElementById("qr-status-text");
  bar.className = "qr-status ok";
  barTxt.textContent = "✅  " + text;
  setTimeout(() => {
    bar.className = "qr-status";
    barTxt.textContent = "對準學生 QR 碼，自動掃描點名";
  }, 2000);

  await processQr(text.trim());
}
onQrDecoded._lastText = "";
onQrDecoded._lastTs = 0;

async function processQr(name) {
  const match = computed.find(s => s.name === name || s.id === name);
  const resultDiv = document.getElementById("scan-result");

  if (!match) {
    resultDiv.innerHTML = `<div class="scan-fail"><div style="font-weight:700;color:#dc2626;">⚠️ 找不到學生：${escHtml(name)}</div></div>`;
    return;
  }

  if (match.status === "present") {
    resultDiv.innerHTML = `<div class="scan-fail" style="background:#eff6ff;border-color:#93c5fd;">
      <div style="font-weight:700;color:#2563eb;">ℹ️ ${escHtml(match.name)} 已報到（${escHtml(match.time)}）</div></div>`;
    return;
  }

  let extraMsg = "";
  if (match.status === "skipped") {
    extraMsg = "（已更新不跟歸程隊→已到）";
  }

  await setStatus(match, "present");
  records = await loadRecords(todayStr());
  computed = mergeData(students, records);
  updateHeader();
  renderScanTab(false);

  const actsText = todayActs(match).join("　");
  const actsRow = actsText ? `<div style="font-size:.78rem;color:#7c3aed;margin-top:3px;">🏃 ${escHtml(actsText)}</div>` : "";
  const noteRow = match.dailyNote ?
    `<div style="font-size:.78rem;color:#b91c1c;background:#fef2f2;border-radius:6px;padding:3px 8px;margin-top:4px;">📢 ${escHtml(match.dailyNote)}</div>` : "";

  const now = hkNow();
  resultDiv.innerHTML = `
    <div class="scan-success">
      <div style="font-size:.72rem;color:#16a34a;font-weight:700;letter-spacing:.5px;margin-bottom:6px;">✅  SCANNED</div>
      <div style="font-size:1.4rem;font-weight:800;color:#14532d;">${escHtml(match.name)}</div>
      <div style="font-size:.82rem;color:#166534;margin-top:2px;">${escHtml(match.class||"")}　${escHtml(match.number||"")}號</div>
      ${actsRow}${noteRow}
      <div style="font-size:.75rem;color:#16a34a;margin-top:6px;opacity:.8;">
        ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')} 報到成功${extraMsg}
      </div>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// MANUAL SEARCH
// ═══════════════════════════════════════════════════════════════════════════
function initManualSearch() {
  const input = document.getElementById("manual-search");
  input.addEventListener("input", () => renderManualResults());
}

function renderManualResults() {
  const q = (document.getElementById("manual-search").value || "").trim().toLowerCase();
  const div = document.getElementById("manual-results");
  if (!q) { div.innerHTML = ""; return; }

  const hits = computed.filter(s =>
    s.name.toLowerCase().includes(q) ||
    (s.class || "").toLowerCase().includes(q) ||
    String(s.number || "") === q ||
    ((s.class || "").toLowerCase() + String(s.number || "")) === q
  ).slice(0, 8);

  if (!hits.length) {
    div.innerHTML = '<div style="font-size:.82rem;color:#64748b;padding:8px 0;">❌ 找不到符合的學生</div>';
    return;
  }

  div.innerHTML = hits.map(m => {
    const isP = m.status === "present";
    const timeTag = isP ? `<span class="mr-time">✅ ${escHtml(m.time)}</span>` : "";
    const cls = isP ? "present" : "absent";
    const btnLabel = isP ? "↩️ 取消" : "✅ 報到";
    const btnClass = isP ? "btn-secondary" : "btn-primary";
    return `
      <div class="manual-result ${cls}">
        <span style="font-weight:700;">${escHtml(m.name)}</span>
        <span style="font-size:.8rem;color:#64748b;margin-left:8px;">${escHtml(m.class||"")} ${escHtml(m.number||"")}號</span>
        ${timeTag}
      </div>
      <button class="${btnClass} full-width" style="margin-bottom:6px;"
              onclick="manualToggle('${m.id.replace(/'/g,"\\'")}', '${isP ? "absent" : "present"}')">${btnLabel}</button>`;
  }).join("");
}

window.manualToggle = async function(id, newStatus) {
  const s = computed.find(x => x.id === id);
  if (!s) return;
  showLoading();
  await setStatus(s, newStatus);
  records = await loadRecords(todayStr());
  computed = mergeData(students, records);
  updateHeader();
  renderManualResults();
  renderScanTab(false);
  hideLoading();
};

// ═══════════════════════════════════════════════════════════════════════════
// SCAN TAB RENDER
// ═══════════════════════════════════════════════════════════════════════════
function renderScanTab(clearResult = true) {
  if (clearResult) {} // keep scan result
  renderRecentCheckins();
}

function renderRecentCheckins() {
  const recent = computed
    .filter(s => s.status === "present" && s.time)
    .sort((a, b) => (b.time || "").localeCompare(a.time || ""))
    .slice(0, 8);

  const div = document.getElementById("recent-checkins");
  if (!recent.length) {
    div.innerHTML = '<div style="font-size:.82rem;color:#64748b;">暫無報到紀錄</div>';
    return;
  }
  div.innerHTML = recent.map(s => `
    <div class="recent-item">
      <span class="recent-name">${escHtml(s.name)}</span>
      <span class="recent-class">${escHtml(s.class||"")} ${escHtml(s.number||"")}號</span>
      <span class="recent-time">🕐 ${escHtml(s.time)}</span>
    </div>
  `).join("");
}

// ═══════════════════════════════════════════════════════════════════════════
// LIST TAB
// ═══════════════════════════════════════════════════════════════════════════
function renderListTab() {
  if (!students.length) {
    document.getElementById("list-empty").style.display = "block";
    document.getElementById("list-content").style.display = "none";
    return;
  }
  document.getElementById("list-empty").style.display = "none";
  document.getElementById("list-content").style.display = "block";

  const searchInput = document.getElementById("list-search");
  const filterSel = document.getElementById("list-filter");

  // Remove old listeners by cloning
  const newSearch = searchInput.cloneNode(true);
  searchInput.parentNode.replaceChild(newSearch, searchInput);
  const newFilter = filterSel.cloneNode(true);
  filterSel.parentNode.replaceChild(newFilter, filterSel);

  newSearch.addEventListener("input", () => renderListCards());
  newFilter.addEventListener("change", () => renderListCards());

  renderActivityAlert();
  renderListCards();
}

function renderActivityAlert() {
  const actAbsent = computed.filter(s => todayActs(s).length > 0 && s.status === "absent");
  const div = document.getElementById("activity-alert");
  if (!actAbsent.length) { div.style.display = "none"; return; }
  div.style.display = "block";
  div.innerHTML = `
    <div class="activity-alert">
      <div class="activity-alert-title">📋 今日有活動、尚未標記的學生（${actAbsent.length} 人）</div>
      <div class="activity-alert-names">${actAbsent.map(s => escHtml(s.name)).join("、")}</div>
      <div class="activity-alert-hint">可一鍵預先標記為不跟歸程隊，方便老師點名。</div>
    </div>
    <button class="btn-primary full-width" onclick="bulkSkipActivity()">🚫 一鍵標記為不跟歸程隊（${actAbsent.length} 人）</button>`;
}

window.bulkSkipActivity = async function() {
  const actAbsent = computed.filter(s => todayActs(s).length > 0 && s.status === "absent");
  if (!actAbsent.length) return;
  showLoading("標記中…");
  await bulkSetSkipped(actAbsent);
  records = await loadRecords(todayStr());
  computed = mergeData(students, records);
  updateHeader();
  renderListTab();
  hideLoading();
  showToast(`✅ 已標記 ${actAbsent.length} 人不跟歸程隊`, "success");
};

function renderListCards() {
  const sq = (document.getElementById("list-search").value || "").trim().toLowerCase();
  const filt = document.getElementById("list-filter").value;

  let view = [...computed];
  if (sq) {
    view = view.filter(s => s.name.toLowerCase().includes(sq) || (s.class||"").toLowerCase().includes(sq));
  }
  if (filt === "absent") view = view.filter(s => s.status === "absent");
  else if (filt === "present") view = view.filter(s => s.status === "present");
  else if (filt === "skipped") view = view.filter(s => s.status === "skipped");

  const absN = view.filter(s => s.status === "absent").length;
  const presV = view.filter(s => s.status === "present").length;
  const skipV = view.filter(s => s.status === "skipped").length;

  document.getElementById("list-stats").innerHTML = `
    <div class="stats-row">
      <span class="stat-badge total">共 ${view.length} 人</span>
      <span class="stat-badge present">✅ 已到 ${presV}</span>
      <span class="stat-badge absent">⬜ 未到 ${absN}</span>
      ${skipV ? `<span class="stat-badge skipped">🚫 不跟 ${skipV}</span>` : ""}
    </div>`;

  document.getElementById("list-cards").innerHTML = view.map(s => renderStudentCard(s, "L_")).join("");
}

function renderStudentCard(s, prefix) {
  const isP = s.status === "present";
  const isSk = s.status === "skipped";
  const icon = isP ? "✅" : (isSk ? "🚫" : "⬜");
  const statusClass = isP ? "present" : (isSk ? "skipped" : "absent");
  const timeHtml = s.time ? `<span class="student-time">🕐 ${escHtml(s.time)}</span>` : "";
  const notesHtml = s.notes ? `<div class="student-notes">👨‍👧 ${escHtml(s.notes)}</div>` : "";
  const acts = todayActs(s);
  const actsHtml = acts.length ? `<div style="margin-top:5px;">${acts.map(a => `<span class="student-activity">${escHtml(a)}</span>`).join("")}</div>` : "";
  const noteBadge = s.dailyNote ? `<div class="student-daily-note"><span>📢</span><span>${escHtml(s.dailyNote)}</span></div>` : "";
  const skipBadge = isSk ? `<div class="student-skip-badge"><span>🚫</span><span>不跟歸程隊放學</span></div>` : "";

  const btnLabel = isP ? "↩️ 取消報到" : "✅ 報到";
  const btnClass = isP ? "btn-secondary" : "btn-primary";
  const skipBtnHtml = isSk
    ? `<button class="btn-secondary" onclick="cardAction('${esc(s.id)}','absent')">↩️ 取消不跟</button>`
    : `<button class="btn-secondary" onclick="cardAction('${esc(s.id)}','skipped')">🚫 不跟歸程隊</button>`;
  const noteBtnLabel = s.dailyNote ? "✏️ 編輯通報" : "📝 通報";
  const noteFormId = `note_${prefix}${s.id}`;
  const noteFormHtml = noteEditing[s.id] ? `
    <div class="note-form" id="nf_${esc(s.id)}">
      <div style="font-size:.82rem;color:#64748b;margin-bottom:4px;">📢 今日通報 — ${escHtml(s.class||"")} ${escHtml(s.name)}</div>
      <textarea id="nt_${esc(s.id)}">${escHtml(s.dailyNote || "")}</textarea>
      <div class="quick-notes">快速：家長接回　早退　病假/事假　自行放學</div>
      <div class="note-form-buttons">
        <button class="btn-primary" onclick="saveNote('${esc(s.id)}')">💾 儲存</button>
        <button class="btn-secondary" onclick="cancelNote('${esc(s.id)}')">取消</button>
      </div>
    </div>` : "";

  return `
    <div class="student-card ${statusClass}">
      <span class="student-name">${icon} ${escHtml(s.name)}</span>${timeHtml}
      <div class="student-meta">
        <span class="student-class">${escHtml(s.class||"")}</span>
        <span class="student-number">${escHtml(s.number||"")}號</span>
      </div>
      ${notesHtml}${actsHtml}${noteBadge}${skipBadge}
      <div class="card-buttons">
        <button class="${btnClass}" onclick="cardAction('${esc(s.id)}','${isP ? "absent" : "present"}')">${btnLabel}</button>
        ${skipBtnHtml}
        <button class="btn-secondary" onclick="toggleNote('${esc(s.id)}')">${noteBtnLabel}</button>
      </div>
      ${noteFormHtml}
    </div>`;
}

function esc(s) { return String(s).replace(/'/g, "\\'").replace(/"/g, "&quot;"); }

window.cardAction = async function(id, newStatus) {
  const s = computed.find(x => x.id === id);
  if (!s) return;
  showLoading();
  await setStatus(s, newStatus);
  records = await loadRecords(todayStr());
  computed = mergeData(students, records);
  updateHeader();
  renderCurrentTab();
  hideLoading();
};

window.toggleNote = function(id) {
  noteEditing[id] = !noteEditing[id];
  renderCurrentTab();
};

window.saveNote = async function(id) {
  const ta = document.getElementById(`nt_${id}`);
  const val = ta ? ta.value.trim() : "";
  const s = computed.find(x => x.id === id);
  if (!s) return;
  showLoading();
  await setNote(s, val);
  noteEditing[id] = false;
  records = await loadRecords(todayStr());
  computed = mergeData(students, records);
  updateHeader();
  renderCurrentTab();
  hideLoading();
  showToast("✅ 已儲存通報", "success");
};

window.cancelNote = function(id) {
  noteEditing[id] = false;
  renderCurrentTab();
};

// ═══════════════════════════════════════════════════════════════════════════
// HISTORY TAB
// ═══════════════════════════════════════════════════════════════════════════
let historyDates = [];
let historyLoaded = false;

async function renderHistoryTab() {
  if (!historyLoaded) {
    showLoading("載入歷史紀錄…");
    historyDates = await loadDates();
    historyLoaded = false; // will be set when date selected
    hideLoading();
  }

  if (!historyDates.length) {
    document.getElementById("history-empty").style.display = "block";
    document.getElementById("history-content").style.display = "none";
    return;
  }

  document.getElementById("history-empty").style.display = "none";
  document.getElementById("history-content").style.display = "block";

  const sel = document.getElementById("history-date");
  // Repopulate
  if (sel.options.length !== historyDates.length) {
    sel.innerHTML = historyDates.map(d => `<option value="${d}">${d}</option>`).join("");
  }

  // Remove old listener
  const newSel = sel.cloneNode(true);
  sel.parentNode.replaceChild(newSel, sel);
  newSel.addEventListener("change", () => renderHistoryCards());

  // Export button
  const expBtn = document.getElementById("history-export-btn");
  const newExpBtn = expBtn.cloneNode(true);
  expBtn.parentNode.replaceChild(newExpBtn, expBtn);
  newExpBtn.addEventListener("click", async () => {
    const date = document.getElementById("history-date").value;
    if (!date) return;
    showLoading();
    const hRec = await loadRecords(date);
    const hData = buildHistoryData(hRec);
    hideLoading();
    downloadCsv(makeCsv(hData, date), `歸程隊${currentTeam}隊歷史_${date}.csv`);
  });

  await renderHistoryCards();
}

function buildHistoryData(hRec) {
  let hData = mergeData(students, hRec);
  const known = new Set(students.map(s => s.id));
  for (const [rid, rec] of Object.entries(hRec)) {
    if (!known.has(rid)) {
      hData.push({
        id: rid, name: rec.name || "未知",
        class: rec.class || "", number: rec.number || "",
        notes: "", activities: [],
        status: rec.status === "present" ? "present" : "absent",
        time: rec.time || "", dailyNote: rec.dailyNote || "",
      });
    }
  }
  hData.sort((a, b) => {
    if (a.class !== b.class) return (a.class || "").localeCompare(b.class || "");
    return (parseInt(a.number) || 0) - (parseInt(b.number) || 0);
  });
  return hData;
}

async function renderHistoryCards() {
  const date = document.getElementById("history-date").value;
  if (!date) return;

  showLoading();
  const hRec = await loadRecords(date);
  hideLoading();

  const hData = buildHistoryData(hRec);
  const hPres = hData.filter(s => s.status === "present").length;
  const hPct = hData.length ? Math.round(hPres / hData.length * 100) : 0;

  document.getElementById("history-summary").innerHTML = `
    <div class="history-summary">
      <span class="history-date-label">${escHtml(date)}</span>
      <span class="history-stats">出席 <strong>${hPres}</strong> / ${hData.length} 人　(${hPct}%)</span>
    </div>
    <div class="history-progress"><div class="history-progress-fill" style="width:${hPct}%"></div></div>`;

  document.getElementById("history-cards").innerHTML = hData.map(s => {
    const isP = s.status === "present";
    const isSk = s.status === "skipped";
    const dim = (!isP && !isSk) ? "dim" : "";
    const icon = isP ? "✅" : (isSk ? "🚫" : "❌");
    const tt = s.time ? `<span style="font-size:.75rem;color:#16a34a;margin-left:8px;">🕐 ${escHtml(s.time)}</span>` : "";
    const skipT = isSk ? '<span style="font-size:.75rem;color:#92400e;margin-left:8px;background:#fef9c3;border-radius:4px;padding:1px 6px;">不跟歸程隊</span>' : "";
    const nt = s.dailyNote ? `<div style="font-size:.78rem;color:#b91c1c;margin-top:3px;">📢 ${escHtml(s.dailyNote)}</div>` : "";
    return `
      <div class="history-card ${dim}">
        <span style="font-weight:700;">${icon} ${escHtml(s.name)}</span>${tt}${skipT}
        <div style="font-size:.78rem;color:#64748b;margin-top:2px;">
          <span style="background:#e2e8f0;border-radius:4px;padding:1px 6px;margin-right:4px;">${escHtml(s.class||"")}</span>${escHtml(s.number||"")}號
        </div>
        ${nt}
      </div>`;
  }).join("");
}

// ═══════════════════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════════════════
function initSettingsEvents() {
  // Export today
  document.getElementById("export-today-btn").addEventListener("click", () => {
    if (!computed.length) { showToast("沒有資料可匯出", "error"); return; }
    downloadCsv(makeCsv(computed, todayStr()), `歸程隊${currentTeam}隊點名_${todayStr()}.csv`);
  });

  // Export students
  document.getElementById("export-students-btn").addEventListener("click", () => {
    if (!students.length) { showToast("沒有學生資料", "error"); return; }
    let csv = "\ufeff班級,學號,姓名,跟隨兄/姊回家,星期一,星期二,星期三,星期四,星期五\n";
    students.forEach(s => {
      const acts = {};
      (s.activities || []).forEach(a => {
        const parts = a.split(": ");
        if (parts.length === 2) acts[parts[0]] = parts[1];
      });
      csv += [s.class||"", s.number||"", s.name||"", s.notes||"",
              acts["星期一"]||"", acts["星期二"]||"", acts["星期三"]||"",
              acts["星期四"]||"", acts["星期五"]||""]
        .map(v => `"${String(v).replace(/"/g,'""')}"`).join(",") + "\n";
    });
    downloadCsv(csv, "歸程隊現有名單.csv");
  });

  // Template
  document.getElementById("download-template-btn").addEventListener("click", () => {
    let csv = "\ufeff班級,學號,姓名,跟隨兄/姊回家,星期一,星期二,星期三,星期四,星期五\n";
    csv += '1A,1,陳大文,,升旗隊,,,,\n';
    csv += '1A,2,李小明,李大文,,,,,\n';
    downloadCsv(csv, "歸程隊名單範本.csv");
  });

  // CSV upload
  const csvInput = document.getElementById("csv-upload");
  document.getElementById("choose-csv-btn").addEventListener("click", () => csvInput.click());
  csvInput.addEventListener("change", handleCsvUpload);

  // Upload confirm
  document.getElementById("csv-upload-confirm-btn").addEventListener("click", confirmCsvUpload);

  // Logout
  document.getElementById("logout-btn").addEventListener("click", logout);

  // Fix timezone
  document.getElementById("fix-tz-btn").addEventListener("click", fixTimezone);
}

async function handleCsvUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  const text = await file.text();
  const content = text.replace(/^\uFEFF/, ""); // strip BOM
  const rows = parseCsv(content);

  let cidx = {};
  let hrow = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const ci = row.findIndex(c => c.includes("班級"));
    const ni = row.findIndex(c => c.includes("姓名"));
    if (ci !== -1 && ni !== -1) {
      hrow = i;
      cidx.class = ci;
      cidx.name = ni;
      cidx.num = row.findIndex(c => c.includes("學號"));
      cidx.notes = row.findIndex(c => c.includes("跟隨"));
      ["星期一","星期二","星期三","星期四","星期五"].forEach((lbl, j) => {
        cidx[["mon","tue","wed","thu","fri"][j]] = row.findIndex(c => c.includes(lbl));
      });
      if (cidx.mon === -1 && cidx.notes !== -1) {
        ["mon","tue","wed","thu","fri"].forEach((d, j) => { cidx[d] = cidx.notes + 1 + j; });
      }
      break;
    }
  }

  if (hrow === -1) {
    showToast("❌ 找不到標題列，請確認 CSV 包含「班級」和「姓名」欄位。", "error");
    return;
  }

  function getVal(row, key) {
    const idx = cidx[key];
    if (idx === undefined || idx === -1 || idx >= row.length) return "";
    return (row[idx] || "").trim();
  }

  const newList = [];
  const dayLabels = [["mon","星期一"],["tue","星期二"],["wed","星期三"],["thu","星期四"],["fri","星期五"]];

  for (let i = hrow + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row.some(c => c.trim())) continue;
    const cls = getVal(row, "class");
    const name = getVal(row, "name");
    if (!cls || !name || cls.includes("班級") || name.includes("姓名")) continue;
    const num = getVal(row, "num");
    const notes = getVal(row, "notes");
    const acts = [];
    dayLabels.forEach(([key, lbl]) => {
      const val = getVal(row, key);
      if (val && !/^\d+$/.test(val) && !val.includes(lbl)) {
        acts.push(`${lbl}: ${val}`);
      }
    });
    newList.push({
      id: `C_${cls}_${num}_${name}`, class: cls,
      number: num, name: name,
      notes: notes, activities: acts,
    });
  }

  csvParsed = newList;

  const previewDiv = document.getElementById("csv-preview");
  const infoDiv = document.getElementById("csv-preview-info");
  const tableDiv = document.getElementById("csv-preview-table-wrap");

  infoDiv.textContent = `解析完成，共 ${newList.length} 筆資料`;
  tableDiv.innerHTML = `
    <div class="csv-table-wrap">
      <table class="csv-table">
        <thead><tr><th>班級</th><th>學號</th><th>姓名</th><th>備註</th></tr></thead>
        <tbody>${newList.slice(0, 50).map(s =>
          `<tr><td>${escHtml(s.class)}</td><td>${escHtml(s.number)}</td><td>${escHtml(s.name)}</td><td>${escHtml(s.notes)}</td></tr>`
        ).join("")}
        ${newList.length > 50 ? `<tr><td colspan="4" style="text-align:center;color:#64748b;">…共 ${newList.length} 筆</td></tr>` : ""}
        </tbody>
      </table>
    </div>`;
  previewDiv.style.display = "block";
}

async function confirmCsvUpload() {
  if (!csvParsed || !csvParsed.length) return;
  showLoading("上傳中…");
  try {
    const batch = db.batch();
    const snap = await db.collection(colStudents()).get();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    csvParsed.forEach(s => {
      batch.set(db.collection(colStudents()).doc(s.id), s);
    });
    await batch.commit();
    await refreshData();
    showToast(`✅ 已上傳 ${csvParsed.length} 筆學生資料！`, "success");
    csvParsed = null;
    document.getElementById("csv-preview").style.display = "none";
    document.getElementById("csv-upload").value = "";
  } catch(e) {
    showToast("❌ 上傳失敗：" + e.message, "error");
  }
  hideLoading();
}

async function fixTimezone() {
  if (!confirm("確定要將所有歷史紀錄時間 +8 小時？此操作不可撤銷，請勿重複執行。")) return;
  showLoading("修正中…");
  let fixed = 0;
  try {
    const snap = await db.collection(colRecords()).get();
    for (const doc of snap.docs) {
      const data = doc.data();
      const recs = data.records || {};
      const updated = {};
      let changed = false;
      for (const [uid, rec] of Object.entries(recs)) {
        const t = rec.time;
        if (t && String(t).includes(":")) {
          try {
            const [h, m] = String(t).split(":").map(Number);
            const totalM = h * 60 + m + 8 * 60;
            const newT = `${String(Math.floor(totalM / 60) % 24).padStart(2,'0')}:${String(totalM % 60).padStart(2,'0')}`;
            updated[uid] = { ...rec, time: newT };
            fixed++;
            changed = true;
          } catch(e) { updated[uid] = rec; }
        } else {
          updated[uid] = rec;
        }
      }
      if (changed) {
        await doc.ref.update({ records: updated });
      }
    }
    showToast(`✅ 已修正 ${fixed} 筆時間紀錄！`, "success");
  } catch(e) {
    showToast("❌ 修正失敗：" + e.message, "error");
  }
  hideLoading();
}

// ═══════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", () => {
  if (!CONFIG_READY) { showConfigError(); return; }
  initLogin();
});
