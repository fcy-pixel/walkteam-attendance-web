import { test } from "node:test";
import { strict as assert } from "node:assert";
import { rosterCollection } from "../roster-version.js";

test("current and September 24 onwards use the updated roster", () => {
  assert.equal(rosterCollection("A"), "students_A_20260924");
  assert.equal(rosterCollection("B", "2026-09-23"), "students_B_20260923");
  assert.equal(rosterCollection("C", "2026-09-24"), "students_C_20260924");
  assert.equal(rosterCollection("C", "2026-09-25"), "students_C_20260924");
});

test("older dates keep their original roster versions", () => {
  assert.equal(rosterCollection("B", "2026-09-22"), "students_B_20260910");
  assert.equal(rosterCollection("B", "2026-09-09"), "students_B_20260909");
  assert.equal(rosterCollection("B", "2026-09-08"), "students_B");
});

test("invalid team and date cannot select a collection", () => {
  assert.throws(() => rosterCollection("D"));
  assert.throws(() => rosterCollection("A", "23/09/2026"));
});
