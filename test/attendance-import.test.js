import test from "node:test";
import assert from "node:assert/strict";
import { matchAttendanceRecords, parseAttendanceCsv, parseCsv } from "../attendance-import.js";

const templateCsv = `檢視缺席名單 2026-05-06 (上午)
姓名,班別,班號,性別,拍咭時間,出席?,豁免,已呈交證明文件,原因,老師備註,校務處備註,監護人資料
測試甲,二信,018,男,,缺席,否,是,病假,,感冒、咳,--
測試乙,三望,03,女,13:30:45,早退,否,否,家長接走,覆診,,--`;

test("parses the school's daily absence CSV layout", () => {
  const parsed = parseAttendanceCsv(templateCsv);
  assert.equal(parsed.records.length, 2);
  assert.deepEqual(parsed.records[0], {
    name: "測試甲",
    class: "二信",
    number: "018",
    type: "absent",
    reason: "病假",
    remark: "感冒、咳",
    time: "",
    confidence: "high",
    note: "缺席（病假；感冒、咳），不跟歸程隊放學",
  });
  assert.equal(parsed.records[1].type, "early_leave");
  assert.equal(parsed.records[1].note, "早退（13:30；家長接走；覆診），不跟歸程隊放學");
});

test("matches by exact name, class and normalized class number", () => {
  const parsed = parseAttendanceCsv(templateCsv);
  const result = matchAttendanceRecords(parsed.records, [
    { team: "A", id: "same-id", name: "測試甲", class: "二信", number: "18" },
    { team: "B", id: "same-id", name: "測試乙", class: "三望", number: "3" },
  ]);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].team, "A");
  assert.equal(result.records[1].team, "B");
  assert.equal(result.unmatched.length, 0);
});

test("does not auto-apply missing or cross-team duplicate students", () => {
  const records = parseAttendanceCsv(templateCsv).records;
  const result = matchAttendanceRecords(records, [
    { team: "A", id: "a-1", name: "測試甲", class: "二信", number: "18" },
    { team: "C", id: "c-1", name: "測試甲", class: "二信", number: "18" },
  ]);
  assert.equal(result.records.length, 0);
  assert.equal(result.unmatched.length, 2);
  assert.match(result.unmatched[0].reason, /多隊/);
  assert.match(result.unmatched[1].reason, /找不到/);
});

test("keeps quoted commas in CSV fields", () => {
  const rows = parseCsv('姓名,備註\n測試甲,"發燒,咳嗽"');
  assert.equal(rows[1][1], "發燒,咳嗽");
});
