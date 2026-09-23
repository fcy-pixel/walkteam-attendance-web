import { activitiesForWeekday, combineAttendanceNotes, parseCsv, matchAttendanceNames } from "./attendance-import.js?v=20260910-team-lists";
import { AttendanceOutbox, makeIntent, makeFirestoreCommit, openOutbox, syncPresentation } from "./sync-engine.js?v=20260906-quick-attendance";
import { rosterCollection } from "./roster-version.js?v=20260923-roster";

/* ═══════════════════════════════════════════════════════════════════════════
   歸程隊點名系統 — Pure Frontend (Firebase Client SDK)
   ═══════════════════════════════════════════════════════════════════════════ */

// ── Firebase Config ──────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyBdHVgUd1xuAey4m6PNht2J0zzn2NlDwhY",
  authDomain: "walkteam-6ffb5.firebaseapp.com",
  projectId: "walkteam-6ffb5",
  storageBucket: "walkteam-6ffb5.firebasestorage.app",
  messagingSenderId: "383316920662",
  appId: "1:383316920662:web:b8d2c1f23c075b674b6ef7",
  measurementId: "G-1X71R19KXL",
};

// ── Config validation ────────────────────────────────────────────────────────
const CONFIG_READY = true;

let db;
if (CONFIG_READY) {
  firebase.initializeApp(firebaseConfig);
  db = firebase.firestore();
  // 有 proxy/過濾嘅網絡（學校 WiFi）會令預設 WebChannel 連線間歇性卡死，自動偵測改用 long-polling
  db.settings({
    merge: true,
    experimentalAutoDetectLongPolling: true,
    experimentalLongPollingOptions: { timeoutSeconds: 25 },
  });
}

function showConfigError() {
  document.getElementById("login-screen").innerHTML = `
    <div class="login-box" style="max-width:500px;">
      <div class="login-icon"><img src="school-logo.png" alt="基慈學校校章"></div>
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
const APP_VERSION = "2026.09.23-roster-restore";
const WEEKDAYS = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"];
const STAT_LABEL = { present: "已到", absent: "未到", skipped: "不跟歸程隊" };

// ── State ────────────────────────────────────────────────────────────────────
let currentTeam = localStorage.getItem("wt_team") || "C";
let authenticated = localStorage.getItem("wt_auth") === "1";
let students = [];
let records = {};
let computed = [];
let noteEditing = {};
let csvParsed = null;
let attendanceImportDate = "";
let attendanceFormBusy = false;
let attendanceImportAnalysis = null;
let attendanceImportRoster = [];
let attendanceRosterCache = null;
let attendanceRosterPromise = null;
let attendanceRosterCachedAt = 0;
let attendanceRosterDate = "";
let unsubStudents = null;      // Firestore 實時監聽取消函數
let unsubLegacyToday = null;
let unsubToday = null;
let legacyTodayRecords = {};   // 舊格式（單一大 doc）當日紀錄，升級當日兼容用
let legacyRecordRevisions = {};
let legacySnapshotReady = false;
let todayEntries = {};         // 新格式：entries 子集合，一個學生一份 doc
let entryRecordRevisions = {};
let boundDate = "";            // 監聽器綁定嘅日期，過午夜自動重新綁
let boundTeam = "";
let confirmedTodayEntries = {}; // Server-confirmed saves awaiting the live listener.
let uiInited = false;          // 一次性 UI 事件只綁一次（重複登入唔會重複綁）
const ensuredDates = {};
const syncHealth = { students: false, legacy: false, entries: false, pending: 0, error: "" };
const syncSources = Object.fromEntries(["students", "legacy", "entries"].map(key => [key, { ready: false, fromCache: true, hasPendingWrites: false, error: "" }]));
let listenerGeneration = 0;
let outbox = null;
let outboxReady;
let storageError = "";
let pendingItems = [];
let renderScheduled = false;
let lastRenderedData = "";
let noteBaselines = {};
let lastPendingView = "";
let studentDetails = {};
let hkCacheSecond = -1;
let hkCacheTime = 0;
let actorId = localStorage.getItem("wt_device_id");
if (!actorId) { actorId = crypto.randomUUID(); localStorage.setItem("wt_device_id", actorId); }
const syncChannel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("walkteam-pending-v1") : null;

function pendingFor(id) {
  return pendingItems.find(item => item.team === currentTeam && item.date === (boundDate || todayStr()) && item.student.id === id);
}

function getActor() {
  return { id: actorId, label: `裝置 ${actorId.slice(0, 4)}` };
}

async function initOutbox() {
  try {
    const store = await openOutbox(indexedDB);
    const commit = makeFirestoreCommit(db, () => firebase.firestore.FieldValue.serverTimestamp());
    outbox = new AttendanceOutbox({
      store, commit: async item => {
        const result = await commit(item);
        if (authenticated && item.team === boundTeam && item.date === boundDate) {
          // A transaction acknowledgement can arrive before its collection snapshot.
          // Keep the actual server record visible before removing the pending intent.
          const saved = await db.collection(colRecordsFor(item.team)).doc(item.date)
            .collection("entries").doc(item.student.id).get({ source: "server" });
          if (saved.exists && authenticated && item.team === boundTeam && item.date === boundDate) {
            confirmedTodayEntries[item.student.id] = saved.data();
            recompute();
          }
        }
        return result;
      },
      locks: navigator.locks,
      onChange(items) { pendingItems = items; renderSyncStatus(); renderPendingItems(); if (authenticated) recompute(); },
      notify() { syncChannel?.postMessage("changed"); },
    });
    await outbox.refresh();
    syncChannel?.addEventListener("message", () => outbox.refresh().catch(handleStorageError));
    setInterval(() => outbox.flush().catch(handleStorageError), 5000);
    outbox.flush().catch(handleStorageError);
  } catch (error) { handleStorageError(error); }
}

function handleStorageError(error) {
  storageError = error?.message || "本機保存不可用";
  renderSyncStatus();
  renderPendingItems();
}

async function queueChange(team, date, student, patch, groups, baseline) {
  await outboxReady;
  if (!outbox || storageError) throw new Error("本機保存不可用，未提交點名。請使用一般瀏覽模式或釋放儲存空間。");
  await outbox.enqueue(makeIntent({ team, date, student, patch, groups, record: baseline, actor: getActor() }));
  outbox.flush().catch(handleStorageError);
}

function renderPendingItems() {
  const attention = pendingItems.filter(item => item.state !== "queued");
  const view = JSON.stringify([storageError, attention, pendingItems.length]);
  if (view === lastPendingView) return;
  lastPendingView = view;
  for (const id of ["pending-home", "pending-app"]) {
    const container = document.getElementById(id);
    if (!container) continue;
    container.hidden = !attention.length && !storageError && (id === "pending-app" || !pendingItems.length);
    if (!attention.length && !storageError) {
      container.innerHTML = id === "pending-home" && pendingItems.length ? `<span>${pendingItems.length} 筆點名已保存，連線後會自動同步。</span>` : "";
      continue;
    }
    container.innerHTML = storageError ? `<strong>本機保存不可用，暫停點名</strong><p>請使用一般瀏覽模式或釋放儲存空間後重新開啟。未提交的操作不會當作成功。</p>` : `
      <strong>${attention.length} 筆點名需要處理</strong>
      ${attention.map(item => `<div class="pending-row">
        <div>${escHtml(item.date)} · ${escHtml(item.team)} 隊 · ${escHtml(item.student.name)}<br>
        <span>${item.groups.includes("status") ? `擬改為「${escHtml(STAT_LABEL[item.patch.status] || item.patch.status)}」` : "通報修改"} · ${item.state === "queued" ? "已保存在本機，等待雲端確認" : escHtml(item.error)}</span></div>
        ${item.state !== "queued" ? `<div class="pending-actions"><button class="btn-outline" data-pending-review="${item.id}">核對並重試</button><button class="btn-outline" data-pending-discard="${item.id}">保留雲端紀錄</button></div>` : ""}
      </div>`).join("")}`;
    container.querySelectorAll("[data-pending-review]").forEach(button => button.onclick = () => reviewPending(button.dataset.pendingReview));
    container.querySelectorAll("[data-pending-discard]").forEach(button => button.onclick = async () => {
      if (confirm("保留雲端紀錄，放棄這筆尚未送出的本機修改？")) {
        try { await outbox.discard(button.dataset.pendingDiscard); } catch (e) { showToast(e.message, "error"); }
      }
    });
  }
}

async function reviewPending(id) {
  if (!navigator.onLine) { showToast("請先連線，再核對雲端紀錄。", "error"); return; }
  const item = pendingItems.find(row => row.id === id);
  if (!item) return;
  try {
    const parent = db.collection(colRecordsFor(item.team)).doc(item.date);
    const snap = await parent.collection("entries").doc(item.student.id).get({ source: "server" });
    const remote = snap.exists ? snap.data() : ((await parent.get({ source: "server" })).data()?.records?.[item.student.id] || {});
    const message = `${item.date} ${item.team}隊 ${item.student.name}\n雲端狀態：${STAT_LABEL[remote.status || "absent"]}\n雲端通報：${combineAttendanceNotes(remote.dailyNote, remote.attendanceImportNote) || "無"}\n${remote.updatedBy?.label ? `最後修改：${remote.updatedBy.label}\n` : ""}你的修改：${item.groups.includes("status") ? STAT_LABEL[item.patch.status] : item.patch.dailyNote || "清除通報"}\n\n確認按以上最新紀錄重新提交？`;
    if (!confirm(message)) return;
    await outbox.rebase(id, remote);
    outbox.flush().catch(handleStorageError);
  } catch (e) { showToast("未能取得最新紀錄，請保持連線後再試。", "error"); }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function hkNow() {
  const second = Math.floor(Date.now() / 1000);
  if (second !== hkCacheSecond) {
    hkCacheSecond = second;
    hkCacheTime = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Hong_Kong" })).getTime();
  }
  return new Date(hkCacheTime);
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
  if (student.activityException) return [];
  const wd = WEEKDAYS[hkNow().getDay() === 0 ? 6 : hkNow().getDay()-1];
  return activitiesForWeekday(student, wd);
}
function colStudents() { return colStudentsFor(currentTeam); }
function colRecords() { return `daily_records_${currentTeam}`; }
function teamLabel() { return `歸程隊${TEAMS[currentTeam] || currentTeam}`; }
function colStudentsFor(team) { return rosterCollection(team); }
function colRecordsFor(team) { return `daily_records_${team}`; }

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

// ── Sync health ─────────────────────────────────────────────────────────────
function normalizeRevision(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return numeric < 1e12 ? numeric * 1000 : numeric;
}

function recordsEqual(a, b) {
  return JSON.stringify(a || {}) === JSON.stringify(b || {});
}

function renderSyncStatus() {
  const el = document.getElementById("sync-status");
  if (!el) return;
  const { state, label } = syncPresentation({ online: navigator.onLine,
    sources: [...Object.values(syncSources), { ready: true, fromCache: false, error: syncHealth.error }],
    pending: pendingItems.length + syncHealth.pending,
    conflicts: pendingItems.filter(item => item.state !== "queued").length, storageError });
  el.className = `sync-status ${state}`;
  el.textContent = label;
  el.title = `版本 ${APP_VERSION}`;
}

function markSyncSource(source, snapshot, error = "") {
  syncSources[source] = { ready: !!snapshot, fromCache: snapshot?.metadata?.fromCache ?? true,
    hasPendingWrites: snapshot?.metadata?.hasPendingWrites ?? false, error };
  syncHealth[source] = !!snapshot && !syncSources[source].fromCache && !syncSources[source].hasPendingWrites;
  renderSyncStatus();
}

function isFullySynced() {
  return syncHealth.students
    && syncHealth.legacy
    && syncHealth.entries
    && !syncHealth.error && !pendingItems.length && !storageError
    && !Object.values(syncSources).some(source => source.error);
}

function handleRefresh() {
  // Firestore 已用 onSnapshot 保持即時同步；正常情況不需要重建連線。
  renderSyncStatus();

  if (!navigator.onLine) {
    showToast("目前離線，請檢查網絡", "error");
    return;
  }
  if (syncHealth.pending > 0 || pendingItems.length) {
    outbox?.flush().catch(handleStorageError);
    showToast(pendingItems.some(item => item.state !== "queued") ? "請在待處理紀錄核對衝突或重試。" : "紀錄已保存在本機，正在等候雲端確認。");
    return;
  }
  if (isFullySynced()) {
    showToast("資料已是最新", "success");
    return;
  }
  showLoading("重新連線…");
  startListeners();
  setTimeout(hideLoading, 12000);
}

function trackWrite(promise) {
  syncHealth.pending += 1;
  syncHealth.error = "";
  renderSyncStatus();
  return promise.then(result => {
    syncHealth.pending = Math.max(0, syncHealth.pending - 1);
    renderSyncStatus();
    return result;
  }).catch(error => {
    syncHealth.pending = Math.max(0, syncHealth.pending - 1);
    syncHealth.error = error?.message || "write-failed";
    renderSyncStatus();
    throw error;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// DATA
// ═══════════════════════════════════════════════════════════════════════════
function entriesCol(date) {
  return entriesColFor(currentTeam, date);
}

function entriesColFor(team, date) {
  return db.collection(colRecordsFor(team)).doc(date).collection("entries");
}

// 歷史頁靠列出日期主文件搵日期，所以要確保主文件存在。每部裝置每隊每日只寫一次。
function ensureDateDoc(date) {
  ensureDateDocFor(currentTeam, date);
}

function ensureDateDocFor(team, date) {
  const key = `${team}_${date}`;
  if (ensuredDates[key]) return;
  ensuredDates[key] = true;
  db.collection(colRecordsFor(team)).doc(date)
    .set({ date: date, timestamp: hkNow().getTime() / 1000 }, { merge: true })
    .catch(() => { ensuredDates[key] = false; });
}

// 讀取某日紀錄：兼容舊格式（主文件 records map）+ 新格式（entries 子集合），新格式優先
async function loadRecords(date) {
  const ref = db.collection(colRecords()).doc(date);
  const [snap, entriesSnap] = await Promise.all([ref.get(), ref.collection("entries").get()]);
  const recs = snap.exists ? { ...(snap.data().records || {}) } : {};
  entriesSnap.docs.forEach(d => { recs[d.id] = { ...(recs[d.id] || {}), ...d.data() }; });
  return recs;
}

async function loadDates() {
  const snap = await db.collection(colRecords()).get();
  return snap.docs.map(d => d.id).sort().reverse();
}

// ── 實時監聽：任何一部裝置點名，其他裝置自動更新 ────────────────────────────
function stopListeners() {
  listenerGeneration += 1;
  if (unsubStudents) { unsubStudents(); unsubStudents = null; }
  if (unsubLegacyToday) { unsubLegacyToday(); unsubLegacyToday = null; }
  if (unsubToday) { unsubToday(); unsubToday = null; }
}

function startListeners() {
  stopListeners();
  const generation = listenerGeneration;
  const td = todayStr();
  if (boundTeam !== currentTeam || boundDate !== td) {
    confirmedTodayEntries = {};
    records = {};
    computed = [];
    showLoading("載入資料中…");
  }
  boundTeam = currentTeam;
  boundDate = td;
  attendanceRosterCache = null;
  attendanceRosterCachedAt = 0;
  students = [];
  legacyTodayRecords = {};
  legacyRecordRevisions = {};
  legacySnapshotReady = false;
  todayEntries = {};
  entryRecordRevisions = {};
  syncHealth.students = false;
  syncHealth.legacy = false;
  syncHealth.entries = false;
  syncHealth.error = "";
  Object.keys(syncSources).forEach(key => { syncSources[key] = { ready: false, fromCache: true, hasPendingWrites: false, error: "" }; });
  lastRenderedData = "";
  renderSyncStatus();

  unsubStudents = db.collection(colStudents()).onSnapshot({ includeMetadataChanges: true }, snap => {
    if (generation !== listenerGeneration) return;
    students = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    students.sort((a, b) => {
      const classDiff = compareSchoolClasses(a.class, b.class);
      if (classDiff) return classDiff;
      return (parseInt(a.number) || 0) - (parseInt(b.number) || 0);
    });
    markSyncSource("students", snap);
    recompute();
  }, err => {
    if (generation !== listenerGeneration) return;
    console.error(err);
    markSyncSource("students", false, err.message);
    hideLoading();
    showToast("學生名單同步失敗", "error");
  });

  // 同時監聽舊格式，確保仍開着舊版 App 的裝置更新時，新版也會即時收到。
  unsubLegacyToday = db.collection(colRecords()).doc(td)
    .onSnapshot({ includeMetadataChanges: true }, snap => {
    if (generation !== listenerGeneration) return;
    const next = snap.exists ? (snap.data().records || {}) : {};
    const parentRevision = normalizeRevision(snap.exists ? snap.data().timestamp : 0);
    const nextRevisions = {};

    for (const [id, rec] of Object.entries(next)) {
      const previous = legacyTodayRecords[id];
      const recRevision = normalizeRevision(rec.updatedAt);
      const previousRecRevision = normalizeRevision(previous?.updatedAt);

      if (!legacySnapshotReady) {
        // 首次載入時，只有明確的逐筆版本時間才可覆蓋 entries；否則新版 entries 優先。
        nextRevisions[id] = recRevision;
      } else if (!recordsEqual(previous, rec)) {
        // 舊版 App 不會寫 updatedAt。若內容變了但 updatedAt 沒變，使用主文件時間判定。
        nextRevisions[id] = recRevision !== previousRecRevision ? recRevision : parentRevision;
      } else {
        nextRevisions[id] = legacyRecordRevisions[id] || recRevision;
      }
    }

    legacyTodayRecords = next;
    legacyRecordRevisions = nextRevisions;
    legacySnapshotReady = true;
    markSyncSource("legacy", snap);
    recompute();
  }, err => {
    if (generation !== listenerGeneration) return;
    console.error(err);
    markSyncSource("legacy", false, err.message);
    hideLoading();
    showToast("舊版點名紀錄同步失敗", "error");
  });

  unsubToday = entriesCol(td).onSnapshot({ includeMetadataChanges: true }, snap => {
    if (generation !== listenerGeneration) return;
    todayEntries = {};
    entryRecordRevisions = {};
    snap.docs.forEach(d => {
      const data = d.data();
      todayEntries[d.id] = data;
      entryRecordRevisions[d.id] = normalizeRevision(data.updatedAt);
    });
    markSyncSource("entries", snap);
    recompute();
  }, err => {
    if (generation !== listenerGeneration) return;
    console.error(err);
    markSyncSource("entries", false, err.message);
    hideLoading();
    showToast("點名紀錄同步失敗", "error");
  });
}

function recompute() {
  // Wait for all initial sources; a roster arriving first does not mean everyone is absent.
  if (!Object.values(syncSources).every(source => source.ready)) return;
  records = { ...legacyTodayRecords };
  for (const [id, rec] of Object.entries(todayEntries)) {
    const legacy = legacyTodayRecords[id] || {};
    // Once an individual entry exists it is authoritative; device clocks cannot revert it.
    records[id] = { ...legacy, ...rec };
  }
  for (const [id, confirmed] of Object.entries(confirmedTodayEntries)) {
    const observed = todayEntries[id];
    const confirmedAt = normalizeRevision(confirmed.serverUpdatedAt);
    const observedAt = normalizeRevision(observed?.serverUpdatedAt);
    if (recordsEqual(observed, confirmed) || (confirmedAt && observedAt >= confirmedAt)) {
      delete confirmedTodayEntries[id];
    } else {
      records[id] = { ...(records[id] || {}), ...confirmed };
    }
  }
  const visibleRecords = { ...records };
  pendingItems.filter(item => item.team === currentTeam && item.date === boundDate && item.state === "queued").forEach(item => {
    visibleRecords[item.student.id] = { ...(visibleRecords[item.student.id] || {}), ...item.patch };
  });
  computed = mergeData(students, visibleRecords);
  const fingerprint = JSON.stringify([students, visibleRecords, pendingItems.map(item => [item.id, item.state]), storageError]);
  if (fingerprint === lastRenderedData) return;
  lastRenderedData = fingerprint;
  if (!renderScheduled) {
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      if (!authenticated) return;
      updateHeader();
      rerenderPreservingInput();
      hideLoading();
    });
  }
}

// 重新渲染當前分頁，但保留正在輸入嘅搜尋框／通報欄內容同游標
function rerenderPreservingInput() {
  if (activeTab === "history" || activeTab === "settings") return;

  const act = document.activeElement;
  const actId = act ? act.id : "";
  const isText = act && (act.tagName === "INPUT" || act.tagName === "TEXTAREA");
  const sel = isText ? { val: act.value, start: act.selectionStart, end: act.selectionEnd } : null;

  const openNotes = {};
  Object.keys(noteEditing).forEach(id => {
    if (!noteEditing[id]) return;
    const ta = document.getElementById(`nt_${id}`);
    if (ta) openNotes[id] = ta.value;
  });

  renderCurrentTab();

  Object.entries(openNotes).forEach(([id, val]) => {
    const ta = document.getElementById(`nt_${id}`);
    if (ta) ta.value = val;
  });

  if (actId && isText) {
    const el = document.getElementById(actId);
    if (el) {
      el.value = sel.val;
      el.focus();
      try { el.setSelectionRange(sel.start, sel.end); } catch (e) {}
    }
  }
}

function mergeData(studs, recs) {
  return studs.map(s => {
    const rec = recs[s.id] || {};
    return {
      ...s,
      status: rec.status || "absent",
      time: rec.time || "",
      dailyNote: combineAttendanceNotes(rec.dailyNote, rec.attendanceImportNote),
      activityException: rec.activityException === true,
      updatedBy: rec.updatedBy || null,
      changes: rec.changes || [],
    };
  });
}

function setStatus(student, newStatus) {
  const td = todayStr();
  const now = hkNow();
  return queueChange(currentTeam, td, student, {
    status: newStatus,
    time: newStatus === "present" ? `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}` : null,
  }, ["status"], records[student.id] || {});
}

function setNote(student, note) {
  const td = todayStr();
  return queueChange(currentTeam, td, student, {
    dailyNote: note,
    attendanceImportNote: "",
  }, ["note"], noteBaselines[student.id] || records[student.id] || {});
}

async function applyAttendanceImport(recordsToApply) {
  const td = todayStr();
  const teams = new Set(recordsToApply.map(result => result.team).filter(team => TEAMS[team]));
  if (!navigator.onLine) throw new Error("匯入前需要連線核對最新點名紀錄。");
  const rosterSnapshots = await Promise.all(Object.keys(TEAMS).map(team => db.collection(colStudentsFor(team)).get({ source: "server" })));
  const freshRoster = rosterSnapshots.flatMap((snapshot, index) => snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id, team: Object.keys(TEAMS)[index] })));
  for (const result of recordsToApply) {
    const matches = matchAttendanceNames(result.name, freshRoster, result.type).records;
    const match = matches.find(item => item.team === result.team && item.studentId === result.studentId);
    if (!match || match.class !== result.class || match.number !== result.number) {
      throw new Error(`${result.name} 的名單資料已變更，請重新配對。`);
    }
  }
  const baselines = {};
  await Promise.all([...teams].map(async team => {
    const ref = db.collection(colRecordsFor(team)).doc(td);
    const [parent, entries] = await Promise.all([ref.get({ source: "server" }), ref.collection("entries").get({ source: "server" })]);
    baselines[team] = { ...(parent.data()?.records || {}) };
    entries.docs.forEach(doc => { baselines[team][doc.id] = { ...(baselines[team][doc.id] || {}), ...doc.data() }; });
  }));

  const rosterById = new Map(attendanceImportRoster.map(student => [`${student.team}\u0000${student.id}`, student]));
  const prepared = recordsToApply.map(result => {
    const student = rosterById.get(`${result.team}\u0000${result.studentId}`);
    if (!student || !TEAMS[result.team]) return null;
    return { result, student };
  });

  if (todayStr() !== td) throw new Error("日期已變更，請重新配對今日姓名清單。");
  for (const { result, student } of prepared.filter(Boolean)) {
    const baseline = baselines[result.team][student.id] || {};
    // An absence import must never silently turn a student who has arrived into skipped.
    const expected = baseline.status === "present" ? { ...baseline, status: "absent" } : baseline;
    await queueChange(result.team, td, student, {
      status: "skipped",
      time: null,
      attendanceImportNote: (result.note || "").trim(),
      attendanceImport: {
        type: result.type,
        sourceDate: td,
        source: "name_list",
        matchMethod: result.matchMethod || "unique_name",
        appliedAt: hkNow().getTime() / 1000,
      },
    }, ["status", "note"], expected);
  }
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

// ═══════════════════════════════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════════════════════════════
function initLogin() {
  const screen = document.getElementById("login-screen");
  const app = document.getElementById("app");
  const teamSel = document.getElementById("login-team");
  const btn = document.getElementById("login-btn");

  // 每次進入都預設A隊，使用者需要手動選隊
  teamSel.value = "A";
  currentTeam = "A";
  initAttendanceImportEvents();

  // 已取消密碼：選隊後按「進入」即可
  btn.addEventListener("click", () => {
    currentTeam = teamSel.value;
    authenticated = true;
    students = []; records = {}; computed = []; noteEditing = {}; noteBaselines = {}; studentDetails = {};
    historyDates = []; historyLoaded = false;
    activeTab = "list";
    document.getElementById("history-date").replaceChildren();
    document.querySelectorAll(".tab").forEach(tab => tab.classList.toggle("active", tab.dataset.tab === "list"));
    document.querySelectorAll(".tab-content").forEach(tab => { tab.style.display = tab.id === "tab-list" ? "block" : "none"; });
    localStorage.setItem("wt_team", currentTeam);
    screen.style.display = "none";
    app.style.display = "block";
    initApp();
  });
}

function logout() {
  authenticated = false;
  stopListeners();
  localStorage.removeItem("wt_auth");
  document.getElementById("app").style.display = "none";
  document.getElementById("login-screen").style.display = "flex";
}

// ═══════════════════════════════════════════════════════════════════════════
// APP INIT
// ═══════════════════════════════════════════════════════════════════════════
function initApp() {
  if (!uiInited) {
    uiInited = true;
    startClock();
    initTabs();
    initSettingsEvents();
    document.getElementById("refresh-btn").addEventListener("click", handleRefresh);
  }
  showLoading("載入資料中…");
  // 保險：就算連線完全失敗，spinner 最多顯示 12 秒
  setTimeout(hideLoading, 12000);
  startListeners();
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
    // 過咗午夜自動切換去新一日嘅紀錄
    if (authenticated && boundDate && todayStr() !== boundDate) {
      noteEditing = {}; noteBaselines = {}; historyLoaded = false;
      startListeners();
    }
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
    badge.textContent = `${skippedN} 人不跟歸程隊`;
  } else {
    badge.style.display = "none";
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TABS
// ═══════════════════════════════════════════════════════════════════════════
let activeTab = "list";

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
    case "list": renderListTab(); break;
    case "history": renderHistoryTab(); break;
    case "settings": break;
  }
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
  const gradeSel = document.getElementById("list-grade-filter");
  const classSel = document.getElementById("list-class-filter");
  const activitySel = document.getElementById("list-activity-filter");
  const filterSel = document.getElementById("list-filter");

  // Save current values before cloning (cloneNode resets .value to DOM default)
  const savedSearch = searchInput.value;
  const savedGrade = gradeSel.value;
  const savedClass = classSel.value;
  const savedActivity = activitySel.value;
  const savedFilter = filterSel.value;

  const classes = [...new Set(students.map(s => (s.class || "").trim()).filter(Boolean))]
    .filter(className => !savedGrade || schoolGrade(className) === savedGrade)
    .sort(compareSchoolClasses);
  classSel.replaceChildren(
    new Option("所有班別", ""),
    ...classes.map(className => new Option(className, className)),
  );

  // Remove old listeners by cloning
  const newSearch = searchInput.cloneNode(true);
  searchInput.parentNode.replaceChild(newSearch, searchInput);
  const newGrade = gradeSel.cloneNode(true);
  gradeSel.parentNode.replaceChild(newGrade, gradeSel);
  const newClass = classSel.cloneNode(true);
  classSel.parentNode.replaceChild(newClass, classSel);
  const newActivity = activitySel.cloneNode(true);
  activitySel.parentNode.replaceChild(newActivity, activitySel);
  const newFilter = filterSel.cloneNode(true);
  filterSel.parentNode.replaceChild(newFilter, filterSel);

  // Restore values after clone
  newSearch.value = savedSearch;
  newGrade.value = savedGrade;
  newClass.value = classes.includes(savedClass) ? savedClass : "";
  newActivity.value = savedActivity;
  newFilter.value = savedFilter;

  newSearch.addEventListener("input", () => renderListCards());
  newGrade.addEventListener("change", () => renderListTab());
  newClass.addEventListener("change", () => renderListCards());
  newActivity.addEventListener("change", () => renderListCards());
  newFilter.addEventListener("change", () => renderListCards());

  renderListCards();
}

function schoolGrade(className) {
  const first = String(className || "").normalize("NFKC").trim().charAt(0);
  const chineseGrades = { "一": "1", "二": "2", "三": "3", "四": "4", "五": "5", "六": "6" };
  return chineseGrades[first] || (/^[1-6]$/.test(first) ? first : "");
}

function compareSchoolClasses(a, b) {
  const classNameA = String(a || "").trim();
  const classNameB = String(b || "").trim();
  const gradeRank = value => Number(schoolGrade(value)) || 99;
  const gradeDiff = gradeRank(classNameA) - gradeRank(classNameB);
  if (gradeDiff) return gradeDiff;

  // 同一年級依學校常用班別次序排列，而不是依中文字典排序。
  const streamRanks = { "信": 1, "望": 2, "愛": 3, "智": 4 };
  const streamRank = value => streamRanks[value.charAt(1)] || 99;
  const streamDiff = streamRank(classNameA) - streamRank(classNameB);
  return streamDiff || classNameA.localeCompare(classNameB, "zh-HK", { numeric: true, sensitivity: "base" });
}

function renderListCards() {
  const sq = (document.getElementById("list-search").value || "").trim().toLowerCase();
  const selectedGrade = document.getElementById("list-grade-filter").value;
  const selectedClass = document.getElementById("list-class-filter").value;
  const activityFilter = document.getElementById("list-activity-filter").value;
  const filt = document.getElementById("list-filter").value;

  let view = [...computed];
  if (selectedGrade) view = view.filter(s => schoolGrade(s.class) === selectedGrade);
  if (selectedClass) view = view.filter(s => (s.class || "").trim() === selectedClass);
  if (activityFilter === "with") view = view.filter(s => todayActs(s).length > 0);
  else if (activityFilter === "without") view = view.filter(s => todayActs(s).length === 0);
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
      <span class="stat-badge present">已到 ${presV}</span>
      <span class="stat-badge absent">未到 ${absN}</span>
      ${skipV ? `<span class="stat-badge skipped">不跟 ${skipV}</span>` : ""}
    </div>`;

  const container = document.getElementById("list-cards");
  const existing = new Map([...container.children].map(card => [card.dataset.studentId, card]));
  const wanted = new Set(view.map(student => student.id));
  for (const [id, card] of existing) if (!wanted.has(id)) card.remove();
  view.forEach((student, index) => {
    const html = renderStudentCard(student, "L_");
    let card = existing.get(student.id);
    if (!card || card.renderedHtml !== html) {
      const template = document.createElement("template");
      template.innerHTML = html.trim();
      const replacement = template.content.firstElementChild;
      replacement.dataset.studentId = student.id;
      replacement.renderedHtml = html;
      if (card) card.replaceWith(replacement);
      card = replacement;
    }
    if (container.children[index] !== card) container.insertBefore(card, container.children[index] || null);
  });
}

function renderStudentCard(s, prefix) {
  const pending = pendingFor(s.id);
  const disabled = pending || storageError || !outbox ? "disabled" : "";
  const syncBadge = pending ? `<span class="student-pending" title="${pending.state === "queued" ? "已保存，正在背景同步" : "請核對修改"}">${pending.state === "queued" ? "↻" : "!"}</span>` : "";
  const isP = s.status === "present";
  const isSk = s.status === "skipped";
  const statusClass = isP ? "present" : (isSk ? "skipped" : "absent");
  const statusLabel = isP ? "已到" : (isSk ? "不跟" : "未到");
  const timeHtml = s.time ? `<span class="student-time">${escHtml(s.time)}</span>` : "";
  const notesHtml = s.notes ? `<div class="student-notes"><span class="meta-label">跟隨</span>${escHtml(s.notes)}</div>` : "";
  const acts = todayActs(s);
  const actsHtml = acts.length ? `
    <div class="student-today-activity">
      <span class="meta-label activity-label">今日活動</span>
      <div class="student-activity-list">${acts.map(a => `<span class="student-activity">${escHtml(a)}</span>`).join("")}</div>
    </div>` : "";
  const noteBadge = s.dailyNote ? `<div class="student-daily-note"><span class="meta-label">通報</span><span>${escHtml(s.dailyNote)}</span></div>` : "";
  const expanded = !!studentDetails[s.id];

  const btnLabel = isP ? "取消報到" : "報到";
  const btnClass = isP ? "btn-secondary" : "btn-primary";
  const skipBtnHtml = isSk
    ? `<button ${disabled} class="btn-secondary" onclick="cardAction('${esc(s.id)}','absent')">取消不跟</button>`
    : `<button ${disabled} class="btn-secondary" onclick="cardAction('${esc(s.id)}','skipped')">不跟歸程隊</button>`;
  const noteBtnLabel = s.dailyNote ? "編輯通報" : "通報";
  const noteFormId = `note_${prefix}${s.id}`;
  const noteFormHtml = noteEditing[s.id] ? `
    <div class="note-form" id="nf_${esc(s.id)}">
      <div class="note-form-title">今日通報 · ${escHtml(s.class||"")} ${escHtml(s.name)}</div>
      <textarea id="nt_${esc(s.id)}">${escHtml(s.dailyNote || "")}</textarea>
      <div class="quick-notes">快速：家長接回　早退　病假/事假　自行放學</div>
      <div class="note-form-buttons">
        <button ${disabled} class="btn-primary" onclick="saveNote('${esc(s.id)}')">儲存</button>
        <button class="btn-secondary" onclick="cancelNote('${esc(s.id)}')">取消</button>
      </div>
    </div>` : "";

  return `
    <div class="student-card ${statusClass}">
      <div class="student-main-row">
      <div class="student-main-info">
      <div class="student-heading">
        <span class="status-dot" aria-hidden="true"></span>
        <span class="student-name">${escHtml(s.name)}</span>
        <span class="student-status">${statusLabel}</span>
        ${syncBadge}
      </div>
      <div class="student-meta">
        <span class="student-class">${escHtml(s.class||"")}</span>
        <span class="student-number">${escHtml(s.number||"")}號</span>
        ${timeHtml}
      </div>
      </div>
      <div class="student-quick-actions">
        <button ${disabled} class="${btnClass} quick-attendance" aria-label="${escHtml(s.name)} ${btnLabel}" onclick="cardAction('${esc(s.id)}','${isP ? "absent" : "present"}')">${btnLabel}</button>
        <button class="btn-secondary student-more" aria-label="${escHtml(s.name)} 更多操作" aria-expanded="${expanded}" onclick="toggleStudentDetails('${esc(s.id)}')">${expanded ? "收起" : "更多"}</button>
      </div>
      </div>
      ${notesHtml}${actsHtml}${noteBadge}
      ${expanded ? `<div class="student-extra">
      <div class="card-buttons">
        ${skipBtnHtml}
        <button ${disabled} class="btn-secondary" onclick="toggleNote('${esc(s.id)}')">${noteBtnLabel}</button>
      </div>
      ${s.updatedBy?.label ? `<div class="student-last-editor">最後修改：${escHtml(s.updatedBy.label)}</div>` : ""}
      ${s.changes?.length ? `<details class="student-audit"><summary>最近修改（${s.changes.length}）</summary>${[...s.changes].reverse().map(change => `<div>${escHtml(new Date(change.savedAt).toLocaleTimeString("zh-HK", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit" }))} · ${escHtml(change.actor?.label || "老師")} · ${change.values?.status ? escHtml(STAT_LABEL[change.values.status]) : "更新通報"}</div>`).join("")}</details>` : ""}
      </div>` : ""}
      ${noteFormHtml}
    </div>`;
}

function esc(s) { return String(s).replace(/'/g, "\\'").replace(/"/g, "&quot;"); }

window.toggleStudentDetails = function(id) {
  studentDetails[id] = !studentDetails[id];
  rerenderPreservingInput();
};

window.cardAction = function(id, newStatus) {
  if (pendingFor(id)) { showToast("請先完成這位學生的待同步紀錄。"); return; }
  const s = computed.find(x => x.id === id);
  if (!s) return;
  setStatus(s, newStatus).catch(e => {
    console.error(e);
    showToast(`${s.name}：${e.message}`, "error");
  });
};

window.toggleNote = function(id) {
  if (!noteEditing[id]) noteBaselines[id] = structuredClone(records[id] || {});
  noteEditing[id] = !noteEditing[id];
  renderCurrentTab();
};

window.saveNote = async function(id) {
  const ta = document.getElementById(`nt_${id}`);
  const val = ta ? ta.value.trim() : "";
  const s = computed.find(x => x.id === id);
  if (!s) return;
  try {
    await setNote(s, val);
    noteEditing[id] = false;
    delete noteBaselines[id];
    renderCurrentTab();
    showToast("通報已保存在本機，等候雲端確認");
  } catch (e) { showToast(e.message, "error"); }
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
    try {
      historyDates = await loadDates();
    } catch(e) {
      console.error(e);
      showToast("讀取歷史紀錄失敗", "error");
    } finally {
      hideLoading();
    }
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
    try {
      const hRec = await loadRecords(date);
      const hData = buildHistoryData(hRec, await loadHistoryStudents(date));
      downloadCsv(makeCsv(hData, date), `歸程隊${currentTeam}隊歷史_${date}.csv`);
    } catch(e) {
      console.error(e);
      showToast("匯出失敗", "error");
    } finally {
      hideLoading();
    }
  });

  await renderHistoryCards();
}

async function loadHistoryStudents(date) {
  const collection = rosterCollection(currentTeam, date);
  if (collection === colStudents()) return students;
  const snapshot = await db.collection(collection).get();
  return snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
}

function buildHistoryData(hRec, historyStudents) {
  let hData = mergeData(historyStudents, hRec);
  const known = new Set(historyStudents.map(s => s.id));
  for (const [rid, rec] of Object.entries(hRec)) {
    if (!known.has(rid)) {
      hData.push({
        id: rid, name: rec.name || "未知",
        class: rec.class || "", number: rec.number || "",
        notes: "", activities: [],
        status: ["present", "skipped"].includes(rec.status) ? rec.status : "absent",
        time: rec.time || "", dailyNote: combineAttendanceNotes(rec.dailyNote, rec.attendanceImportNote),
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
  let hRec;
  let historyStudents;
  try {
    [hRec, historyStudents] = await Promise.all([loadRecords(date), loadHistoryStudents(date)]);
  } catch(e) {
    console.error(e);
    showToast("讀取失敗", "error");
    return;
  } finally {
    hideLoading();
  }

  const hData = buildHistoryData(hRec, historyStudents);
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
    const statusClass = isP ? "present" : (isSk ? "skipped" : "absent");
    const statusLabel = isP ? "已到" : (isSk ? "不跟" : "未到");
    const tt = s.time ? `<span class="history-time">${escHtml(s.time)}</span>` : "";
    const nt = s.dailyNote ? `<div class="history-note"><span class="meta-label">通報</span>${escHtml(s.dailyNote)}</div>` : "";
    return `
      <div class="history-card ${dim} ${statusClass}">
        <div class="history-card-heading">
          <span class="status-dot" aria-hidden="true"></span>
          <span class="history-name">${escHtml(s.name)}</span>
          <span class="history-status">${statusLabel}</span>${tt}
        </div>
        <div class="history-meta">
          <span class="student-class">${escHtml(s.class||"")}</span>${escHtml(s.number||"")}號
        </div>
        ${nt}
      </div>`;
  }).join("");
}

// ═══════════════════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════════════════
function initSettingsEvents() {
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

}

function initAttendanceImportEvents() {
  const invalidate = () => { resetAttendanceImportPreview(); setAttendanceFormBusy(false); };
  document.getElementById("attendance-names").addEventListener("input", invalidate);
  document.getElementById("attendance-list-type").addEventListener("change", invalidate);
  document.getElementById("process-attendance-list-btn").addEventListener("click", processAttendanceList);
}

function setAttendanceFormBusy(busy) {
  attendanceFormBusy = busy;
  document.getElementById("attendance-names").disabled = busy;
  document.getElementById("attendance-list-type").disabled = busy;
  document.getElementById("process-attendance-list-btn").disabled = busy || !document.getElementById("attendance-names").value.trim();
  const applyButton = document.getElementById("apply-ai-attendance-btn");
  if (applyButton) applyButton.disabled = busy || !document.querySelector(".ai-result-check:checked");
}

function resetAttendanceImportPreview() {
  attendanceImportAnalysis = null;
  attendanceImportRoster = [];
  attendanceImportDate = "";
  const preview = document.getElementById("attendance-import-preview");
  preview.style.display = "none";
  preview.innerHTML = "";
}

async function loadAllTeamStudents() {
  const rosterDate = todayStr();
  if (attendanceRosterDate !== rosterDate) {
    attendanceRosterCache = null;
    attendanceRosterPromise = null;
    attendanceRosterDate = rosterDate;
  }
  if (attendanceRosterCache && Date.now() - attendanceRosterCachedAt < 60_000) return attendanceRosterCache;
  attendanceRosterCache = null;
  if (attendanceRosterPromise) return attendanceRosterPromise;

  const teams = ["A", "B", "C"];
  const request = Promise.all(teams.map(team => db.collection(colStudentsFor(team)).get()))
    .then(snapshots => {
      if (todayStr() !== rosterDate) return loadAllTeamStudents();
      attendanceRosterCache = snapshots.flatMap((snapshot, index) => {
        const team = teams[index];
        return snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id, team }));
      });
      attendanceRosterCachedAt = Date.now();
      return attendanceRosterCache;
    })
    .finally(() => { if (attendanceRosterPromise === request) attendanceRosterPromise = null; });
  attendanceRosterPromise = request;
  return request;
}

async function processAttendanceList() {
  if (attendanceFormBusy) return;
  const text = document.getElementById("attendance-names").value;
  const type = document.getElementById("attendance-list-type").value;
  if (!text.trim()) return;
  setAttendanceFormBusy(true);
  showLoading("配對 A、B、C 三隊姓名…");
  resetAttendanceImportPreview();

  try {
    attendanceImportRoster = await loadAllTeamStudents();
    if (!attendanceImportRoster.length) throw new Error("A、B、C 三隊尚未有學生名單。");
    attendanceImportAnalysis = matchAttendanceNames(text, attendanceImportRoster, type);
    attendanceImportDate = todayStr();
    renderAttendanceImportPreview();
  } catch (e) {
    console.error(e);
    showToast(e.message || "名單處理失敗", "error");
  } finally {
    hideLoading();
    setAttendanceFormBusy(false);
  }
}

function renderAttendanceImportPreview() {
  const preview = document.getElementById("attendance-import-preview");
  const analysis = attendanceImportAnalysis || {};
  const results = Array.isArray(analysis.records) ? analysis.records : [];
  const studentCount = new Set(results.map(result => result.studentId)).size;
  const unmatched = Array.isArray(analysis.unmatched) ? analysis.unmatched : [];
  const counts = ["A", "B", "C"].map(team => ({
    team,
    count: results.filter(result => result.team === team).length,
  }));

  const resultRows = results.map((result, index) => {
    const student = attendanceImportRoster.find(s => s.team === result.team && s.id === result.studentId);
    if (!student) return "";
    const typeLabel = result.type === "early_leave" ? "早退" : "缺席";
    return `
      <label class="ai-result-row">
        <input type="checkbox" class="ai-result-check" data-index="${index}" checked>
        <span class="ai-result-main">
          <span class="ai-result-heading">
            <strong>${escHtml(student.name)}</strong>
            <span class="ai-team-badge">${escHtml(result.team)}隊</span>
            <span>${escHtml(student.class || "")} ${escHtml(student.number || "")}號</span>
            <span class="ai-type-badge">${typeLabel}</span>
            <span class="ai-confidence">${result.matchMethod === "same_student_multiple_teams" ? "同一學生・跨隊" : "姓名相符"}</span>
          </span>
          <span class="ai-result-note">${escHtml(result.note || "")}</span>
        </span>
      </label>`;
  }).join("");

  preview.innerHTML = `
    <div class="ai-preview-head">
      <strong>姓名配對結果：共 ${studentCount} 人</strong>
      <span>套用至 ${attendanceImportDate}</span>
    </div>
    <div class="ai-team-summary">${counts.map(item => `<span>${item.team}隊 <strong>${item.count}</strong> 人</span>`).join("")}</div>
    ${results.length > studentCount ? `<p class="caption">同一學生列於多隊，會在各隊分別列出供核對。</p>` : ""}
    ${analysis.duplicateCount ? `<p class="caption">已略過 ${analysis.duplicateCount} 筆重複姓名。</p>` : ""}
    ${results.length ? `<div class="ai-result-list">${resultRows}</div>` : `<div class="info-box">未找到屬於 A、B、C 隊的學生，未有任何資料被更改。</div>`}
    ${unmatched.length ? `<div class="ai-unmatched"><strong>未能配對（${unmatched.length}）</strong><div>${unmatched.map(item => escHtml(typeof item === "string" ? item : `${item.text || item.name || "未知資料"}（${item.reason || "請檢查"}）`)).join("、")}</div></div>` : ""}
    ${results.length ? `<button class="btn-primary full-width" id="apply-ai-attendance-btn">確認標記為不跟歸程隊</button>` : ""}`;
  preview.style.display = "block";

  const applyButton = document.getElementById("apply-ai-attendance-btn");
  if (applyButton) applyButton.addEventListener("click", confirmAttendanceImportApply);
  preview.querySelectorAll(".ai-result-check").forEach(checkbox => checkbox.addEventListener("change", () => setAttendanceFormBusy(attendanceFormBusy)));
}

async function confirmAttendanceImportApply() {
  if (!attendanceImportAnalysis || attendanceFormBusy) return;
  if (attendanceImportDate !== todayStr()) {
    resetAttendanceImportPreview();
    showToast("日期已變更，請重新配對今日姓名清單。", "error");
    return;
  }
  const selected = [...document.querySelectorAll(".ai-result-check:checked")]
    .map(input => attendanceImportAnalysis.records[Number(input.dataset.index)])
    .filter(Boolean);
  if (!selected.length) {
    showToast("請至少選擇一名學生", "error");
    return;
  }

  const selectedIds = new Set(selected.map(result => `${result.team}/${result.studentId}`));
  const remainingNames = [...attendanceImportAnalysis.unmatched.map(item => item.text),
    ...attendanceImportAnalysis.records.filter(result => !selectedIds.has(`${result.team}/${result.studentId}`)).map(result => result.name)];
  setAttendanceFormBusy(true);
  showLoading("套用今日通報…");
  try {
    await applyAttendanceImport(selected);
    const teamText = ["A", "B", "C"]
      .map(team => `${team}隊 ${selected.filter(result => result.team === team).length} 人`)
      .join("、");
    const successMessage = `${selected.length} 筆已保存，等候雲端確認（${teamText}）`;
    showToast(successMessage);
    resetAttendanceImportPreview();
    document.getElementById("attendance-names").value = remainingNames.join("\n");
    const loginScreen = document.getElementById("login-screen");
    if (getComputedStyle(loginScreen).display !== "none") {
      const preview = document.getElementById("attendance-import-preview");
      preview.innerHTML = `<div class="ai-apply-success"><strong>通報已加入待同步清單</strong><span>${escHtml(successMessage)}</span></div>`;
      preview.style.display = "block";
    } else {
      document.querySelector('.tab[data-tab="list"]').click();
    }
  } catch (e) {
    console.error(e);
    showToast(`部分紀錄未能加入：${e.message}`, "error");
  } finally {
    hideLoading();
    setAttendanceFormBusy(false);
  }
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
    showToast("找不到標題列，請確認 CSV 包含「班級」和「姓名」欄位。", "error");
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
    const snap = await db.collection(colStudents()).get();
    // Firestore batch 上限 500 個操作，分批 commit
    const ops = [];
    snap.docs.forEach(doc => ops.push(b => b.delete(doc.ref)));
    csvParsed.forEach(s => ops.push(b => b.set(db.collection(colStudents()).doc(s.id), s)));
    for (let i = 0; i < ops.length; i += 400) {
      const batch = db.batch();
      ops.slice(i, i + 400).forEach(op => op(batch));
      await batch.commit();
    }
    // 本頁可能剛更新其中一隊名單，下次首頁配對時重新取得三隊最新資料。
    attendanceRosterCache = null;
    attendanceRosterCachedAt = 0;
    // 學生名單由實時監聽自動更新，毋須手動重讀
    showToast(`已上傳 ${csvParsed.length} 筆學生資料`, "success");
    csvParsed = null;
    document.getElementById("csv-preview").style.display = "none";
    document.getElementById("csv-upload").value = "";
  } catch(e) {
    showToast("上傳失敗：" + e.message, "error");
  } finally {
    hideLoading();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", () => {
  if (!CONFIG_READY) { showConfigError(); return; }
  window.addEventListener("online", () => {
    syncHealth.error = "";
    renderSyncStatus();
    if (authenticated) startListeners();
    outbox?.flush().catch(handleStorageError);
  });
  window.addEventListener("offline", renderSyncStatus);
  window.addEventListener("beforeunload", event => {
    if (pendingItems.length || syncHealth.pending) { event.preventDefault(); event.returnValue = ""; }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      outbox?.flush().catch(handleStorageError);
      if (authenticated && !isFullySynced()) startListeners();
    }
  });
  outboxReady = initOutbox();
  renderSyncStatus();
  initLogin();
});
