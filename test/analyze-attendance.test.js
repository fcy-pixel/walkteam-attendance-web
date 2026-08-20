import test from "node:test";
import assert from "node:assert/strict";
import { onRequestPost } from "../functions/api/analyze-attendance.js";

const sampleBody = {
  fileName: "daily.pdf",
  documentText: "缺席名單 2026-08-20 上午\n一信 8 林浩鋒 病假 感冒",
  targetDate: "2026-08-20",
  team: "A",
  roster: [{ id: "A_一信_8_林浩鋒", class: "一信", number: "8", name: "林浩鋒" }],
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
  globalThis.fetch = async () => Response.json({
    choices: [{ message: { content: JSON.stringify({
      records: [
        { studentId: "A_一信_8_林浩鋒", type: "absent", reason: "病假", remark: "感冒", confidence: "high" },
        { studentId: "invented", type: "absent", confidence: "high" },
      ],
      unmatched: [],
    }) } }],
  });
  try {
    const response = await onRequestPost(context(sampleBody, { QWEN_API_KEY: "test-key" }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].studentId, "A_一信_8_林浩鋒");
    assert.equal(result.records[0].note, "缺席（病假；感冒），不跟歸程隊放學");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
