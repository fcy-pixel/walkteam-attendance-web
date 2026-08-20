import test from "node:test";
import assert from "node:assert/strict";
import { onRequestPost } from "../functions/api/analyze-attendance.js";

const sampleBody = {
  fileName: "daily.pdf",
  documentText: "缺席名單 2026-08-20 上午\n一信 8 林浩鋒 病假 感冒",
  targetDate: "2026-08-20",
  team: "ALL",
  roster: [
    { team: "A", id: "A_一信_8_林浩鋒", class: "一信", number: "8", name: "林浩鋒" },
    { team: "B", id: "B_二望_3_測試同學", class: "二望", number: "3", name: "測試同學" },
    { team: "C", id: "C_三信_5_示例學生", class: "三信", number: "5", name: "示例學生" },
  ],
};

function context(body, env = {}) {
  return {
    request: new Request("https://walkteam-attendance-web.pages.dev/api/analyze-attendance", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": "https://walkteam-attendance-web.pages.dev" },
      body: JSON.stringify(body),
    }),
    env,
  };
}

test("returns a clear error when the Qwen secret is missing", async () => {
  const response = await onRequestPost(context(sampleBody));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /Qwen API/);
});

test("rejects a cross-origin request", async () => {
  const ctx = context(sampleBody, { QWEN_API_KEY: "test-key" });
  ctx.request = new Request(ctx.request, { headers: { "Content-Type": "application/json", "Origin": "https://example.com" } });
  const response = await onRequestPost(ctx);
  assert.equal(response.status, 403);
});

test("normalizes and validates Qwen structured output", async () => {
  const originalFetch = globalThis.fetch;
  let qwenRequestBody;
  globalThis.fetch = async (_url, options) => {
    qwenRequestBody = JSON.parse(options.body);
    return Response.json({
      choices: [{ message: { content: JSON.stringify({
        records: [
          { team: "A", studentId: "A_一信_8_林浩鋒", type: "absent", reason: "病假", remark: "感冒", confidence: "high" },
          { team: "B", studentId: "B_二望_3_測試同學", type: "early_leave", time: "13:30", confidence: "high" },
          { team: "C", studentId: "invented", type: "absent", confidence: "high" },
        ],
        unmatched: [],
      }) } }],
    });
  };
  try {
    const response = await onRequestPost(context(sampleBody, { QWEN_API_KEY: "test-key" }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(qwenRequestBody.model, "qwen-flash");
    assert.equal(result.records.length, 2);
    assert.equal(result.records[0].team, "A");
    assert.equal(result.records[0].studentId, "A_一信_8_林浩鋒");
    assert.equal(result.records[0].note, "缺席（病假；感冒），不跟歸程隊放學");
    assert.equal(result.records[1].team, "B");
    assert.equal(result.records[1].note, "早退（13:30），不跟歸程隊放學");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps identical student ids separate across teams", async () => {
  const duplicateIdBody = {
    ...sampleBody,
    roster: [
      { team: "A", id: "shared-id", class: "一信", number: "8", name: "甲同學" },
      { team: "B", id: "shared-id", class: "二望", number: "3", name: "乙同學" },
    ],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    choices: [{ message: { content: JSON.stringify({
      records: [
        { team: "B", studentId: "shared-id", type: "absent", reason: "事假", confidence: "high" },
      ],
      unmatched: [],
    }) } }],
  });
  try {
    const response = await onRequestPost(context(duplicateIdBody, { QWEN_API_KEY: "test-key" }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].team, "B");
    assert.equal(result.records[0].studentId, "shared-id");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
