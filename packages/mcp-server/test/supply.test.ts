import assert from "node:assert/strict";
import { test } from "node:test";
import { latestCheck, lowStockFilter, openRequestsOf, stockOf, type CheckRow, type ItemRow } from "../src/tools/supply.ts";

const check = (stock_status: CheckRow["stock_status"], checked_at: string): CheckRow => ({
  stock_status,
  estimated_quantity: null,
  unit: null,
  location: null,
  checked_by: null,
  checked_at,
});

const item = (name: string, checks: CheckRow[], extra: Partial<ItemRow> = {}): ItemRow => ({
  id: name,
  lab_id: "lab",
  name,
  details: null,
  classification: "reagent",
  default_unit: null,
  storage_location: null,
  catalog_number: null,
  preferred_vendor: null,
  is_active: true,
  created_at: "",
  updated_at: "",
  inventory_checks: checks,
  ...extra,
});

test("latestCheck ignores server ordering", () => {
  const c = latestCheck([check("plenty", "2026-01-01T00:00:00Z"), check("out", "2026-03-01T00:00:00Z"), check("low", "2026-02-01T00:00:00Z")]);
  assert.equal(c?.stock_status, "out");
  assert.equal(latestCheck([]), null);
});

test("stockOf reports unchecked when there is no check", () => {
  assert.equal(stockOf(item("a", [])), "unchecked");
  assert.equal(stockOf(item("a", [check("medium", "2026-01-01")])), "medium");
});

test("lowStockFilter: out before low, optional unknown/unchecked, skips archived", () => {
  const items = [
    item("zeta", [check("low", "2026-01-01")]),
    item("alpha", [check("out", "2026-01-01")]),
    item("beta", [check("plenty", "2026-01-01")]),
    item("gamma", [check("unknown", "2026-01-01")]),
    item("delta", []),
    item("archived", [check("out", "2026-01-01")], { is_active: false }),
  ];
  assert.deepEqual(lowStockFilter(items, { includeUnknown: false, includeUnchecked: false }).map((i) => i.name), ["alpha", "zeta"]);
  assert.deepEqual(
    lowStockFilter(items, { includeUnknown: true, includeUnchecked: true }).map((i) => i.name),
    ["alpha", "zeta", "gamma", "delta"]
  );
});

test("openRequestsOf keeps only open statuses and accepts object or array embeds", () => {
  const it = item("x", [], {
    order_request_items: [
      { requested_quantity: 2, unit: "box", order_requests: { id: "r1", status: "submitted", created_at: "t1" } },
      { requested_quantity: 1, unit: null, order_requests: [{ id: "r2", status: "received", created_at: "t2" }] },
      { requested_quantity: 5, unit: null, order_requests: [{ id: "r3", status: "ordered", created_at: "t3" }] },
      { requested_quantity: 5, unit: null, order_requests: null },
    ],
  });
  assert.deepEqual(
    openRequestsOf(it).map((r) => [r.request_id, r.status]),
    [
      ["r1", "submitted"],
      ["r3", "ordered"],
    ]
  );
});
