function clean(value) {
  return String(value ?? "").trim();
}

function normalizeText(value) {
  return clean(value).normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

function normalizeNumber(value) {
  const normalized = normalizeText(value);
  return normalized.replace(/^0+(?=\d)/, "");
}

export function parseCsv(text) {
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const result = [];
  for (const line of lines) {
    const row = [];
    let inQuotes = false;
    let field = "";
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (inQuotes) {
        if (char === '"' && line[i + 1] === '"') {
          field += '"';
          i++;
        } else if (char === '"') {
          inQuotes = false;
        } else {
          field += char;
        }
      } else if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        row.push(field);
        field = "";
      } else {
        field += char;
      }
    }
    row.push(field);
    result.push(row);
  }
  return result;
}

function findColumn(header, aliases) {
  const normalizedAliases = aliases.map(normalizeText);
  return header.findIndex(value => normalizedAliases.includes(normalizeText(value)));
}

function cell(row, index) {
  return index >= 0 && index < row.length ? clean(row[index]) : "";
}

function uniqueDetails(values) {
  const seen = new Set();
  return values.filter(value => {
    const text = clean(value);
    const key = normalizeText(text);
    if (!text || text === "--" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function attendanceType(title, status, reason, teacherRemark, officeRemark) {
  const signal = [title, status, reason, teacherRemark, officeRemark].join(" ");
  return /早退|提早離校|早離|家長接走/.test(signal) ? "early_leave" : "absent";
}

function makeNote(type, time, reason, teacherRemark, officeRemark) {
  const details = uniqueDetails([
    type === "early_leave" ? time : "",
    reason,
    teacherRemark,
    officeRemark,
  ]);
  const label = type === "early_leave" ? "早退" : "缺席";
  return `${label}${details.length ? `（${details.join("；")}）` : ""}，不跟歸程隊放學`;
}

export function parseAttendanceCsv(text) {
  const table = parseCsv(text);
  const headerIndex = table.findIndex(row => {
    const columns = row.map(normalizeText);
    return columns.includes("姓名") &&
      (columns.includes("班別") || columns.includes("班級")) &&
      (columns.includes("班號") || columns.includes("學號"));
  });
  if (headerIndex < 0) {
    throw new Error("找不到「姓名、班別、班號」欄位，請使用學校每日缺席名單 CSV。");
  }

  const header = table[headerIndex];
  const indexes = {
    name: findColumn(header, ["姓名", "學生姓名"]),
    className: findColumn(header, ["班別", "班級"]),
    number: findColumn(header, ["班號", "學號"]),
    scanTime: findColumn(header, ["拍咭時間", "拍卡時間", "時間"]),
    status: findColumn(header, ["出席?", "出席", "狀態", "出席狀況"]),
    reason: findColumn(header, ["原因", "缺席原因"]),
    teacherRemark: findColumn(header, ["老師備註", "教師備註"]),
    officeRemark: findColumn(header, ["校務處備註", "學校備註"]),
  };
  const title = table.slice(0, headerIndex).flat().map(clean).filter(Boolean).join(" ");

  const records = table.slice(headerIndex + 1).map(row => {
    const name = cell(row, indexes.name);
    const className = cell(row, indexes.className);
    const number = cell(row, indexes.number);
    if (!name || !className || !number) return null;
    const status = cell(row, indexes.status);
    const reason = cell(row, indexes.reason);
    const teacherRemark = cell(row, indexes.teacherRemark);
    const officeRemark = cell(row, indexes.officeRemark);
    const scanTime = cell(row, indexes.scanTime);
    const type = attendanceType(title, status, reason, teacherRemark, officeRemark);
    const timeMatch = scanTime.match(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/);
    const time = timeMatch ? timeMatch[0] : "";
    return {
      name,
      class: className,
      number,
      type,
      reason,
      remark: uniqueDetails([teacherRemark, officeRemark]).join("；"),
      time,
      confidence: "high",
      note: makeNote(type, time, reason, teacherRemark, officeRemark),
    };
  }).filter(Boolean);

  if (!records.length) throw new Error("名單內沒有可處理的學生資料。");
  return { title, records };
}

function rosterKey(student) {
  return [normalizeText(student.name), normalizeText(student.class), normalizeNumber(student.number)].join("\u0000");
}

export function matchAttendanceRecords(records, roster) {
  const rosterByKey = new Map();
  roster.forEach(student => {
    const key = rosterKey(student);
    const candidates = rosterByKey.get(key) || [];
    candidates.push(student);
    rosterByKey.set(key, candidates);
  });

  const matched = [];
  const unmatched = [];
  const seenStudents = new Set();
  records.forEach(record => {
    const candidates = rosterByKey.get(rosterKey(record)) || [];
    if (candidates.length !== 1) {
      unmatched.push({
        text: `${record.class} ${normalizeNumber(record.number)}號 ${record.name}`,
        reason: candidates.length ? "同一學生出現在多隊" : "三隊名單找不到完全相符學生",
      });
      return;
    }
    const student = candidates[0];
    const studentKey = `${student.team}\u0000${student.id}`;
    if (seenStudents.has(studentKey)) return;
    seenStudents.add(studentKey);
    matched.push({
      ...record,
      team: student.team,
      studentId: student.id,
      name: student.name,
      class: student.class || record.class,
      number: String(student.number || record.number),
    });
  });
  return { records: matched, unmatched };
}
