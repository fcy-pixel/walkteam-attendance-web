// Durable pending intentions; Firestore transactions check only the fields being edited.
// No production connection is created by this module, allowing isolated emulator tests.
const GROUPS = {
  status: { status: "absent", time: null },
  note: { dailyNote: "", attendanceImportNote: "" },
};

export function fieldState(record = {}, groups = ["status"]) {
  return Object.fromEntries(groups.map(group => [group, {
    ...Object.fromEntries(Object.entries(GROUPS[group]).map(([field, fallback]) =>
      [field, record[field] ?? fallback])),
    revision: record.fieldVersions?.[group] || "",
  }]));
}

export function makeIntent({ team, date, student, patch, groups, record = {}, actor }) {
  const id = crypto.randomUUID();
  return {
    id, target: `${team}/${date}/${student.id}`, team, date,
    student: { id: student.id, name: student.name || "", class: student.class || "", number: student.number || "" },
    patch, groups, expected: fieldState(record, groups), actor,
    createdAt: Date.now(), state: "queued", error: "",
  };
}

export class AttendanceConflict extends Error {
  constructor(remote) {
    super("其他老師已修改這位學生，請核對最新紀錄。");
    this.code = "attendance/conflict";
    this.remote = remote;
  }
}

export function makeFirestoreCommit(db, serverTimestamp) {
  return async function commit(intent) {
    const parent = db.collection(`daily_records_${intent.team}`).doc(intent.date);
    const entry = parent.collection("entries").doc(intent.student.id);
    return db.runTransaction(async transaction => {
      const snapshot = await transaction.get(entry);
      let parentSnapshot;
      if (!snapshot.exists) parentSnapshot = await transaction.get(parent);
      const current = snapshot.exists ? snapshot.data() : (parentSnapshot.data()?.records?.[intent.student.id] || {});
      // A previous attempt may have committed even if the acknowledgement was lost.
      if ((current.recentOperations || []).includes(intent.id)) return { alreadyCommitted: true };
      // Two teachers reporting the same status is not a conflict. Keep the first
      // arrival time and audit record, and acknowledge the redundant intention.
      if (intent.groups.length === 1 && intent.groups[0] === "status" && current.status === intent.patch.status) {
        return { alreadySatisfied: true };
      }
      if (JSON.stringify(fieldState(current, intent.groups)) !== JSON.stringify(intent.expected)) {
        throw new AttendanceConflict(current);
      }
      const previous = Object.fromEntries(Object.keys(intent.patch).map(key => [key, current[key] ?? null]));
      const changes = [...(Array.isArray(current.changes) ? current.changes : []), {
        id: intent.id, actor: intent.actor, requestedAt: intent.createdAt,
        savedAt: Date.now(), previous, values: intent.patch,
      }].slice(-20);
      const payload = {
        ...intent.patch, name: intent.student.name, class: intent.student.class,
        number: intent.student.number, updatedAt: Date.now(), serverUpdatedAt: serverTimestamp(),
        updatedBy: intent.actor, changes,
        fieldVersions: { ...(current.fieldVersions || {}), ...Object.fromEntries(intent.groups.map(g => [g, intent.id])) },
        recentOperations: [...(current.recentOperations || []), intent.id].slice(-32),
      };
      if (parentSnapshot && !parentSnapshot.exists) transaction.set(parent, { date: intent.date, timestamp: Date.now() / 1000 });
      // When migrating a legacy-only student, retain status, notes and imported annotations.
      transaction.set(entry, snapshot.exists ? payload : { ...current, ...payload }, { merge: true });
      return { alreadyCommitted: false };
    });
  };
}

export function openOutbox(indexedDB, name = "walkteam-pending-v1") {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("intents", { keyPath: "id" });
      store.createIndex("target", "target", { unique: true });
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("請關閉其他舊版點名頁面後重試。"));
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      function run(mode, action) {
        return new Promise((done, fail) => {
          const tx = database.transaction("intents", mode);
          const req = action(tx.objectStore("intents"));
          tx.oncomplete = () => done(req?.result);
          tx.onabort = tx.onerror = () => fail(tx.error || req?.error || new Error("無法保存待同步紀錄"));
        });
      }
      resolve({
        all: () => run("readonly", s => s.getAll()),
        add: item => run("readwrite", s => s.add(item)),
        put: item => run("readwrite", s => s.put(item)),
        remove: id => run("readwrite", s => s.delete(id)),
        close: () => database.close(),
      });
    };
  });
}

export class AttendanceOutbox {
  constructor({ store, commit, onChange = () => {}, onSaved = () => {}, online = () => navigator.onLine, locks, notify = () => {} }) {
    Object.assign(this, { store, commit, onChange, onSaved, online, locks, notify });
    this.items = [];
    this.running = false;
    this.flushRequested = false;
    this.active = new Set();
  }
  async refresh() {
    this.items = (await this.store.all()).sort((a, b) => a.createdAt - b.createdAt);
    this.onChange(this.items);
  }
  async enqueue(intent) {
    try { await this.store.add(intent); }
    catch (error) {
      if (error.name === "ConstraintError") throw new Error("這位學生已有待同步紀錄，請先處理。");
      throw new Error("未能在本機保存，這次點名未提交。請檢查瀏覽器儲存空間後重試。");
    }
    await this.refresh();
    this.notify();
  }
  async flush() {
    if (!this.online()) return;
    if (this.running) { this.flushRequested = true; return; }
    this.running = true;
    this.flushRequested = false;
    const work = async () => {
      const attempted = new Set();
      try {
        // Pick up clicks arriving during an in-flight request immediately.
        // Retry a network-failed intention only on a later pass, not in a busy loop.
        while (this.online()) {
          await this.refresh();
          const group = this.items.filter(item => item.state === "queued" && !attempted.has(item.id)).slice(0, 3);
          if (!group.length) break;
          group.forEach(item => attempted.add(item.id));
          await Promise.all(group.map(item => this.send(item)));
        }
      } finally { await this.refresh(); }
    };
    try {
      if (this.locks) await this.locks.request("walkteam-outbox-flush", work);
      else await work(); // Transaction operation IDs also protect browsers without Web Locks.
    } finally {
      this.running = false;
      if (this.flushRequested) { this.flushRequested = false; await this.flush(); }
    }
  }
  async send(item) {
    this.active.add(item.id);
    this.onChange(this.items);
    try {
      if (Date.now() - item.createdAt > 24 * 60 * 60 * 1000 && !item.reviewedAt) {
        await this.store.put({ ...item, state: "conflict", error: "這筆點名已超過一天，請核對原本日期再提交。" });
        return;
      }
      await this.commit(item);
      await this.store.remove(item.id);
      this.onSaved(item);
    } catch (error) {
      if (error.code === "attendance/conflict") {
        await this.store.put({ ...item, state: "conflict", remote: error.remote, error: error.message });
      } else if (["permission-denied", "unauthenticated", "invalid-argument", "resource-exhausted"].includes(error.code)) {
        await this.store.put({ ...item, state: "error", error: "雲端拒絕儲存；紀錄仍保留在本機。請重試或聯絡管理員。" });
      }
      // Transient network failures leave the durable intention queued for retry.
    } finally {
      this.active.delete(item.id);
      this.notify();
    }
  }
  async discard(id) {
    if (this.active.has(id)) throw new Error("正在提交，請稍候再處理。");
    await this.store.remove(id);
    await this.refresh();
    this.notify();
  }
  async rebase(id, current) {
    const item = (await this.store.all()).find(row => row.id === id);
    if (!item || this.active.has(id)) return;
    await this.store.put({ ...item, expected: fieldState(current, item.groups), state: "queued", error: "", remote: null, reviewedAt: Date.now() });
    await this.refresh();
    this.notify();
  }
}

export function syncPresentation({ online, sources, pending = 0, conflicts = 0, storageError = "" }) {
  if (storageError) return { state: "error", label: "本機保存不可用，暫停點名" };
  if (conflicts) return { state: "error", label: `${conflicts} 筆紀錄需核對` };
  if (!online) return { state: "offline", label: pending ? `離線，${pending} 筆已保存在本機` : "離線，顯示暫存資料" };
  if (pending) return { state: "pending", label: `同步中 · ${pending} 筆` };
  if (sources.some(source => source.error)) return { state: "error", label: "同步失敗，請更新" };
  if (sources.every(source => source.ready && !source.fromCache && !source.hasPendingWrites)) return { state: "synced", label: "已同步" };
  return { state: "connecting", label: "正在確認雲端資料…" };
}
