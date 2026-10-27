import assert from "node:assert/strict";
import { test } from "node:test";
import { describeError, orIlikeClause, patchText, searchWords } from "../src/tools/define.ts";

test("searchWords strips PostgREST/LIKE metacharacters and caps word count", () => {
  assert.deepEqual(searchWords('  TRIzol, (100 mL) "x" 50%  '), ["TRIzol", "100", "mL", "x", "50"]);
  assert.equal(searchWords("a b c d e f g h i j").length, 8);
  assert.deepEqual(searchWords(",,, ()"), []);
});

test("orIlikeClause quotes each value", () => {
  assert.equal(orIlikeClause(["name", "details"], "RNeasy"), 'name.ilike."%RNeasy%",details.ilike."%RNeasy%"');
});

test("patchText: undefined keeps, empty clears, text trims", () => {
  assert.equal(patchText(undefined), undefined);
  assert.equal(patchText("   "), null);
  assert.equal(patchText(" -80 freezer "), "-80 freezer");
});

test("describeError adds actionable hints", () => {
  assert.match(describeError({ code: "42501", message: "permission denied" }), /row-level security/);
  assert.match(describeError({ code: "PGRST116", message: "no rows" }), /No matching row/);
  assert.equal(describeError("plain"), "plain");
});
