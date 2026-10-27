import { z } from "zod";
import type { SeineContext } from "../context.ts";
import { applyTextSearch, cleanText, defineTool, first, labArg, patchText } from "./define.ts";

// Mirrors the Supply Manager web app (apps/supply-manager/src/lib/cloudAdapter.ts):
// same tables, same RPCs, same RLS. Writes an agent can make as a lab MEMBER:
// add/edit catalog items, record stock checks, and file (draft→submit) order
// requests. Approving, ordering and receiving stay with owners/admins.

export const CLASSIFICATIONS = ["reagent", "consumable", "supply", "sample", "equipment", "kit", "other"] as const;
export const STOCK_STATUSES = ["plenty", "medium", "low", "out", "unknown"] as const;
export const REQUEST_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "denied",
  "withdrawn",
  "ordered",
  "received",
  "cancelled",
] as const;
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const OPEN_REQUEST_STATUSES = ["draft", "submitted", "approved", "ordered"];

type StockStatus = (typeof STOCK_STATUSES)[number];
export type StockView = StockStatus | "unchecked";

const ITEM_COLS =
  "id, lab_id, name, details, classification, default_unit, storage_location, catalog_number, preferred_vendor, is_active, created_by, updated_by, created_at, updated_at";
const CHECK_COLS = "id, stock_status, estimated_quantity, unit, location, note, checked_by, checked_at";
const REQUEST_COLS =
  "id, lab_id, requested_by, project_id, status, reason, review_note, reviewed_by, reviewed_at, approved_funding_source_id, funding_assignment_status, created_at, updated_at";
const ITEM_SEARCH_COLUMNS = ["name", "details", "catalog_number", "preferred_vendor", "storage_location"];

export interface CheckRow {
  id?: string;
  stock_status: StockStatus;
  estimated_quantity: number | null;
  unit: string | null;
  location: string | null;
  note?: string | null;
  checked_by: string | null;
  checked_at: string;
}

interface RequestLineRow {
  requested_quantity: number | null;
  unit: string | null;
  order_requests: { id: string; status: string; created_at: string } | { id: string; status: string; created_at: string }[] | null;
}

export interface ItemRow {
  id: string;
  lab_id: string;
  name: string;
  details: string | null;
  classification: string;
  default_unit: string | null;
  storage_location: string | null;
  catalog_number: string | null;
  preferred_vendor: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  inventory_checks?: CheckRow[];
  order_request_items?: RequestLineRow[];
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export const latestCheck = (checks: CheckRow[] | undefined | null): CheckRow | null => {
  let best: CheckRow | null = null;
  for (const c of checks ?? []) if (!best || c.checked_at > best.checked_at) best = c;
  return best;
};

export const stockOf = (item: Pick<ItemRow, "inventory_checks">): StockView =>
  latestCheck(item.inventory_checks)?.stock_status ?? "unchecked";

// Lower = more urgent.
export const STOCK_RANK: Record<StockView, number> = { out: 0, low: 1, unknown: 2, unchecked: 3, medium: 4, plenty: 5 };

export const openRequestsOf = (item: Pick<ItemRow, "order_request_items">) =>
  (item.order_request_items ?? [])
    .map((line) => ({ line, req: first(line.order_requests) }))
    .filter(({ req }) => req && OPEN_REQUEST_STATUSES.includes(req.status))
    .map(({ line, req }) => ({
      request_id: req!.id,
      status: req!.status,
      quantity: line.requested_quantity,
      unit: line.unit,
      created_at: req!.created_at,
    }));

export const lowStockFilter = (
  items: ItemRow[],
  opts: { includeUnknown: boolean; includeUnchecked: boolean }
): ItemRow[] => {
  const wanted = new Set<StockView>(["out", "low"]);
  if (opts.includeUnknown) wanted.add("unknown");
  if (opts.includeUnchecked) wanted.add("unchecked");
  return items
    .filter((it) => it.is_active && wanted.has(stockOf(it)))
    .sort((a, b) => {
      const r = STOCK_RANK[stockOf(a)] - STOCK_RANK[stockOf(b)];
      return r !== 0 ? r : a.name.localeCompare(b.name);
    });
};

// ---------------------------------------------------------------------------
// Shaping for agent-readable output
// ---------------------------------------------------------------------------

async function shapeCheck(ctx: SeineContext, labId: string, c: CheckRow | null) {
  if (!c) return null;
  return {
    status: c.stock_status,
    quantity: c.estimated_quantity,
    unit: c.unit,
    location: c.location,
    note: c.note ?? undefined,
    checked_at: c.checked_at,
    checked_by: await ctx.memberName(labId, c.checked_by),
  };
}

async function shapeItem(ctx: SeineContext, it: ItemRow, extra: Record<string, unknown> = {}) {
  return {
    id: it.id,
    name: it.name,
    classification: it.classification,
    catalog_number: it.catalog_number,
    vendor: it.preferred_vendor,
    storage_location: it.storage_location,
    default_unit: it.default_unit,
    ...(it.is_active ? {} : { archived: true }),
    stock: await shapeCheck(ctx, it.lab_id, latestCheck(it.inventory_checks)),
    ...extra,
  };
}

async function fetchItems(
  ctx: SeineContext,
  labId: string,
  opts: { query?: string; classification?: string; location?: string; includeInactive?: boolean; withRequests?: boolean }
): Promise<ItemRow[]> {
  const embeds = [`inventory_checks(${CHECK_COLS})`];
  if (opts.withRequests) embeds.push("order_request_items(requested_quantity, unit, order_requests(id, status, created_at))");
  let q = ctx.sb
    .from("items")
    .select(`${ITEM_COLS}, ${embeds.join(", ")}`)
    .eq("lab_id", labId)
    .order("checked_at", { referencedTable: "inventory_checks", ascending: false })
    .limit(1, { referencedTable: "inventory_checks" })
    .order("name");
  if (!opts.includeInactive) q = q.eq("is_active", true);
  if (opts.classification) q = q.eq("classification", opts.classification);
  if (opts.location) q = q.ilike("storage_location", `%${opts.location.replace(/[%_*]/g, "")}%`);
  q = applyTextSearch(q, ITEM_SEARCH_COLUMNS, opts.query);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as ItemRow[];
}

async function fetchItem(ctx: SeineContext, itemId: string): Promise<ItemRow> {
  const { data, error } = await ctx.sb.from("items").select(ITEM_COLS).eq("id", itemId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`No supply item ${itemId} is visible to you.`);
  return data as unknown as ItemRow;
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

export const searchItems = defineTool({
  name: "supply_search_items",
  title: "Search supply catalog",
  kind: "read",
  description:
    "Search the lab's supply catalog (reagents, consumables, kits, equipment, samples) by free text over name, " +
    "details, catalog number, vendor and storage location; each item comes with its most recent stock check. " +
    "Use stock_status to filter by the latest check ('unchecked' = never checked).",
  input: {
    lab: labArg,
    query: z.string().optional().describe("Words to match, e.g. 'trizol' or 'qiagen rneasy'. All words must match."),
    classification: z.enum(CLASSIFICATIONS).optional(),
    stock_status: z.array(z.enum([...STOCK_STATUSES, "unchecked"])).optional(),
    location: z.string().optional().describe("Substring of the storage location, e.g. '-80' or 'shelf 3'."),
    include_archived: z.boolean().optional().describe("Include archived (inactive) items. Default false."),
    limit: z.number().int().min(1).max(500).optional().describe("Default 50."),
  },
  handler: async (args, ctx) => {
    const lab = await ctx.lab(args.lab);
    let items = await fetchItems(ctx, lab.id, {
      query: args.query,
      classification: args.classification,
      location: args.location,
      includeInactive: args.include_archived,
    });
    if (args.stock_status?.length) {
      const want = new Set<string>(args.stock_status);
      items = items.filter((it) => want.has(stockOf(it)));
    }
    const limit = args.limit ?? 50;
    return {
      lab: lab.name,
      matched: items.length,
      returned: Math.min(limit, items.length),
      items: await Promise.all(items.slice(0, limit).map((it) => shapeItem(ctx, it))),
    };
  },
});

export const getItem = defineTool({
  name: "supply_get_item",
  title: "Supply item details",
  kind: "read",
  description:
    "Full record for one supply item: catalog fields, recent stock-check history, received lots, linked " +
    "projects, and every order request that includes it (with order/shipping status). Look up by item_id, or " +
    "by name (exact, else unique partial match).",
  input: {
    lab: labArg,
    item_id: z.string().uuid().optional(),
    name: z.string().optional(),
    history: z.number().int().min(1).max(100).optional().describe("Stock checks / lots to return. Default 10."),
  },
  handler: async (args, ctx) => {
    let itemId = args.item_id;
    if (!itemId) {
      if (!args.name) throw new Error("Pass item_id or name.");
      const lab = await ctx.lab(args.lab);
      const hits = await fetchItems(ctx, lab.id, { query: args.name, includeInactive: true });
      const exact = hits.filter((h) => h.name.toLowerCase() === args.name!.trim().toLowerCase());
      const pick = exact.length === 1 ? exact : hits;
      if (pick.length !== 1) {
        return {
          ambiguous: true,
          message: pick.length ? `${pick.length} items match "${args.name}"; pass item_id.` : `No item matches "${args.name}".`,
          candidates: pick.slice(0, 20).map((h) => ({ id: h.id, name: h.name, catalog_number: h.catalog_number })),
        };
      }
      itemId = pick[0].id;
    }
    const n = args.history ?? 10;
    const { data, error } = await ctx.sb
      .from("items")
      .select(
        `${ITEM_COLS}, inventory_checks(${CHECK_COLS}), ` +
          "stock_lots(id, lot_number, received_quantity, unit, expiration_date, storage_location, received_at, received_by, note), " +
          "item_projects(project_id, association_type), " +
          "order_request_items(requested_quantity, unit, priority, note, order_requests(id, status, reason, requested_by, created_at, orders(status, company, order_number, tracking_number, expected_arrival, received_at)))"
      )
      .eq("id", itemId)
      .order("checked_at", { referencedTable: "inventory_checks", ascending: false })
      .limit(n, { referencedTable: "inventory_checks" })
      .order("received_at", { referencedTable: "stock_lots", ascending: false })
      .limit(n, { referencedTable: "stock_lots" })
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error(`No supply item ${itemId} is visible to you.`);
    const it = data as any;
    const labId = it.lab_id as string;
    const requests = await Promise.all(
      (it.order_request_items ?? []).map(async (line: any) => {
        const req = first<any>(line.order_requests);
        const order = first<any>(req?.orders);
        return {
          request_id: req?.id,
          status: req?.status,
          quantity: line.requested_quantity,
          unit: line.unit,
          priority: line.priority,
          reason: req?.reason,
          requested_by: await ctx.memberName(labId, req?.requested_by),
          created_at: req?.created_at,
          order: order ?? undefined,
        };
      })
    );
    requests.sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)));
    return {
      ...(await shapeItem(ctx, it)),
      details: it.details,
      created_at: it.created_at,
      updated_at: it.updated_at,
      projects: await Promise.all(
        (it.item_projects ?? []).map(async (p: any) => ({
          project: await ctx.projectName(labId, p.project_id),
          association: p.association_type,
        }))
      ),
      stock_history: await Promise.all(
        [...(it.inventory_checks ?? [])]
          .sort((a: CheckRow, b: CheckRow) => b.checked_at.localeCompare(a.checked_at))
          .map((c: CheckRow) => shapeCheck(ctx, labId, c))
      ),
      lots: it.stock_lots ?? [],
      order_requests: requests,
    };
  },
});

export const lowStock = defineTool({
  name: "supply_low_stock",
  title: "Low / out-of-stock items",
  kind: "read",
  description:
    "Items whose most recent stock check says 'out' or 'low' (optionally also 'unknown' and never-checked), most " +
    "urgent first, each annotated with any open order request (draft/submitted/approved/ordered) already covering " +
    "it. Use this before filing an order request so you don't double-order.",
  input: {
    lab: labArg,
    include_unknown: z.boolean().optional(),
    include_unchecked: z.boolean().optional(),
    classification: z.enum(CLASSIFICATIONS).optional(),
  },
  handler: async (args, ctx) => {
    const lab = await ctx.lab(args.lab);
    const items = await fetchItems(ctx, lab.id, { classification: args.classification, withRequests: true });
    const low = lowStockFilter(items, {
      includeUnknown: Boolean(args.include_unknown),
      includeUnchecked: Boolean(args.include_unchecked),
    });
    const rows = await Promise.all(
      low.map((it) => {
        const open = openRequestsOf(it);
        return shapeItem(ctx, it, {
          stock_view: stockOf(it),
          open_requests: open,
          needs_request: open.length === 0,
        });
      })
    );
    return {
      lab: lab.name,
      count: rows.length,
      needing_request: low.filter((it) => openRequestsOf(it).length === 0).length,
      items: rows,
    };
  },
});

export const listRequests = defineTool({
  name: "supply_list_requests",
  title: "List order requests",
  kind: "read",
  description:
    "Order requests in the lab with their line items, requester, review outcome and placed-order / shipping " +
    "status. Defaults to the open pipeline (submitted, approved, ordered). Drafts are only visible to their author " +
    "and admins.",
  input: {
    lab: labArg,
    status: z.array(z.enum(REQUEST_STATUSES)).optional().describe("Default: submitted, approved, ordered."),
    mine_only: z.boolean().optional().describe("Only requests filed by you (the signed-in user)."),
    item_id: z.string().uuid().optional().describe("Only requests that include this item."),
    limit: z.number().int().min(1).max(200).optional().describe("Default 30."),
  },
  handler: async (args, ctx) => {
    const lab = await ctx.lab(args.lab);
    const statuses = args.status?.length ? args.status : ["submitted", "approved", "ordered"];
    const itemEmbed = args.item_id ? "order_request_items!inner" : "order_request_items";
    let q = ctx.sb
      .from("order_requests")
      .select(
        `${REQUEST_COLS}, ${itemEmbed}(id, item_id, requested_quantity, unit, priority, note, items(name, catalog_number, preferred_vendor)), ` +
          "orders(id, status, company, order_number, tracking_number, placed_at, expected_arrival, received_at, note)"
      )
      .eq("lab_id", lab.id)
      .in("status", statuses)
      .order("created_at", { ascending: false })
      .limit(args.limit ?? 30);
    if (args.mine_only) q = q.eq("requested_by", ctx.userId);
    if (args.item_id) q = q.eq("order_request_items.item_id", args.item_id);
    const { data, error } = await q;
    if (error) throw error;
    const rows = await Promise.all(
      (data ?? []).map(async (r: any) => ({
        id: r.id,
        status: r.status,
        reason: r.reason,
        project: await ctx.projectName(lab.id, r.project_id),
        requested_by: await ctx.memberName(lab.id, r.requested_by),
        created_at: r.created_at,
        review:
          r.reviewed_by || r.review_note
            ? { by: await ctx.memberName(lab.id, r.reviewed_by), at: r.reviewed_at, note: r.review_note }
            : undefined,
        funding_assignment: r.funding_assignment_status,
        lines: (r.order_request_items ?? []).map((l: any) => ({
          item_id: l.item_id,
          item: first<any>(l.items)?.name,
          catalog_number: first<any>(l.items)?.catalog_number,
          quantity: l.requested_quantity,
          unit: l.unit,
          priority: l.priority,
          note: l.note,
        })),
        orders: r.orders ?? [],
      }))
    );
    return { lab: lab.name, statuses, count: rows.length, requests: rows };
  },
});

// ---------------------------------------------------------------------------
// Write tools (member-level)
// ---------------------------------------------------------------------------

export const createItem = defineTool({
  name: "supply_create_item",
  title: "Add catalog item",
  kind: "write",
  description:
    "Add a new item to the lab's supply catalog, optionally with an initial stock check. Refuses if an active " +
    "item with the same name or catalog number already exists (pass allow_duplicate to override) — prefer " +
    "supply_update_item or supply_record_stock_check for existing items.",
  input: {
    lab: labArg,
    name: z.string().min(1),
    classification: z.enum(CLASSIFICATIONS),
    details: z.string().optional(),
    default_unit: z.string().optional().describe("e.g. 'mL', 'box', 'kit', 'each'."),
    storage_location: z.string().optional(),
    catalog_number: z.string().optional(),
    preferred_vendor: z.string().optional(),
    initial_stock: z
      .object({
        stock_status: z.enum(STOCK_STATUSES),
        estimated_quantity: z.number().min(0).optional(),
        unit: z.string().optional(),
        note: z.string().optional(),
      })
      .optional(),
    allow_duplicate: z.boolean().optional(),
  },
  handler: async (args, ctx) => {
    const lab = await ctx.lab(args.lab);
    const name = args.name.trim();
    if (!args.allow_duplicate) {
      const { data: active, error } = await ctx.sb
        .from("items")
        .select("id, name, catalog_number")
        .eq("lab_id", lab.id)
        .eq("is_active", true);
      if (error) throw error;
      const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
      const catalog = norm(args.catalog_number);
      const dupes = (active ?? []).filter(
        (it: any) => norm(it.name) === norm(name) || (catalog !== "" && norm(it.catalog_number) === catalog)
      );
      if (dupes.length) {
        return {
          created: false,
          message: "An active item with this name or catalog number already exists. Update it instead, or pass allow_duplicate.",
          existing: dupes,
        };
      }
    }
    const uid = ctx.userId;
    const { data, error } = await ctx.sb
      .from("items")
      .insert({
        lab_id: lab.id,
        name,
        classification: args.classification,
        details: cleanText(args.details),
        default_unit: cleanText(args.default_unit),
        storage_location: cleanText(args.storage_location),
        catalog_number: cleanText(args.catalog_number),
        preferred_vendor: cleanText(args.preferred_vendor),
        created_by: uid,
        updated_by: uid,
      })
      .select(ITEM_COLS)
      .single();
    if (error) throw error;
    const item = data as unknown as ItemRow;
    let check: unknown = null;
    if (args.initial_stock) {
      const res = await ctx.sb
        .from("inventory_checks")
        .insert({
          item_id: item.id,
          stock_status: args.initial_stock.stock_status,
          estimated_quantity: args.initial_stock.estimated_quantity ?? null,
          unit: cleanText(args.initial_stock.unit) ?? item.default_unit,
          location: item.storage_location,
          note: await ctx.tag(args.initial_stock.note),
          checked_by: uid,
        })
        .select(CHECK_COLS)
        .single();
      if (res.error) throw res.error;
      check = res.data;
    }
    await ctx.logWrite({
      tool: "supply_create_item",
      lab_id: lab.id,
      summary: `created item "${item.name}"${args.initial_stock ? ` (stock ${args.initial_stock.stock_status})` : ""}`,
      ids: { item_id: item.id },
    });
    return { created: true, item: await shapeItem(ctx, { ...item, inventory_checks: check ? [check as CheckRow] : [] }) };
  },
});

export const updateItem = defineTool({
  name: "supply_update_item",
  title: "Edit catalog item",
  kind: "write",
  description:
    "Edit an existing supply item's catalog fields. Only the fields you pass change; pass an empty string to " +
    "clear a field. (Archiving/deleting items is an admin action in the web app and not available here.)",
  input: {
    item_id: z.string().uuid(),
    name: z.string().min(1).optional(),
    classification: z.enum(CLASSIFICATIONS).optional(),
    details: z.string().optional(),
    default_unit: z.string().optional(),
    storage_location: z.string().optional(),
    catalog_number: z.string().optional(),
    preferred_vendor: z.string().optional(),
  },
  handler: async (args, ctx) => {
    const before = await fetchItem(ctx, args.item_id);
    const update: Record<string, unknown> = { updated_by: ctx.userId };
    if (args.name !== undefined) update.name = args.name.trim();
    if (args.classification !== undefined) update.classification = args.classification;
    const textFields = ["details", "default_unit", "storage_location", "catalog_number", "preferred_vendor"] as const;
    for (const f of textFields) {
      const v = patchText(args[f]);
      if (v !== undefined) update[f] = v;
    }
    const changed = Object.keys(update).filter((k) => k !== "updated_by");
    if (changed.length === 0) return { updated: false, message: "Nothing to change." };
    const { data, error } = await ctx.sb.from("items").update(update).eq("id", args.item_id).select(ITEM_COLS).maybeSingle();
    if (error) throw error;
    if (!data) {
      throw new Error(
        "Seine did not apply the update — your account can't edit this item (archived, or project-restricted)."
      );
    }
    const diff = Object.fromEntries(
      changed.map((k) => [k, { from: (before as any)[k] ?? null, to: (data as any)[k] ?? null }])
    );
    await ctx.logWrite({
      tool: "supply_update_item",
      lab_id: before.lab_id,
      summary: `updated "${before.name}": ${changed.join(", ")}`,
      ids: { item_id: args.item_id, diff },
    });
    return { updated: true, item_id: args.item_id, changes: diff };
  },
});

export const recordCheck = defineTool({
  name: "supply_record_stock_check",
  title: "Record stock check",
  kind: "write",
  description:
    "Append a stock check for an item (what's on the shelf right now): status plenty/medium/low/out/unknown, with " +
    "optional estimated quantity, unit, location and note. Checks are append-only history; the latest one is the " +
    "item's current stock status. The note is tagged as written by an agent.",
  input: {
    item_id: z.string().uuid(),
    stock_status: z.enum(STOCK_STATUSES),
    estimated_quantity: z.number().min(0).optional(),
    unit: z.string().optional().describe("Defaults to the item's default unit when a quantity is given."),
    location: z.string().optional().describe("Defaults to the item's storage location."),
    note: z.string().optional().describe("Who/what observed it, e.g. 'per Zac at bench, 2 bottles left'."),
  },
  handler: async (args, ctx) => {
    const item = await fetchItem(ctx, args.item_id);
    const { data, error } = await ctx.sb
      .from("inventory_checks")
      .insert({
        item_id: item.id,
        stock_status: args.stock_status,
        estimated_quantity: args.estimated_quantity ?? null,
        unit: cleanText(args.unit) ?? (args.estimated_quantity !== undefined ? item.default_unit : null),
        location: cleanText(args.location) ?? item.storage_location,
        note: await ctx.tag(args.note),
        checked_by: ctx.userId,
      })
      .select(CHECK_COLS)
      .single();
    if (error) throw error;
    await ctx.logWrite({
      tool: "supply_record_stock_check",
      lab_id: item.lab_id,
      summary: `stock check "${item.name}": ${args.stock_status}${args.estimated_quantity !== undefined ? ` (${args.estimated_quantity})` : ""}`,
      ids: { item_id: item.id, check_id: (data as any).id },
    });
    return { recorded: true, item: item.name, check: await shapeCheck(ctx, item.lab_id, data as unknown as CheckRow) };
  },
});

export const requestOrder = defineTool({
  name: "supply_request_order",
  title: "File order request",
  kind: "write",
  description:
    "File an order request for one or more catalog items. By default it is SUBMITTED for review (visible to the " +
    "lab; an owner/admin approves or denies it and assigns funding); pass submit=false to leave a private draft " +
    "for the user to finish in the web app. Refuses when an open request already covers one of the items, unless " +
    "allow_duplicate. Every item must already exist in the catalog (use supply_create_item first).",
  input: {
    lab: labArg,
    lines: z
      .array(
        z.object({
          item_id: z.string().uuid(),
          quantity: z.number().positive().optional(),
          unit: z.string().optional().describe("Defaults to the item's default unit."),
          priority: z.enum(PRIORITIES).optional(),
          note: z.string().optional(),
        })
      )
      .min(1)
      .max(50),
    reason: z.string().min(3).describe("Why it's needed — reviewers see this."),
    project: z.string().optional().describe("Project id or name to attribute the request to."),
    submit: z.boolean().optional().describe("Default true."),
    allow_duplicate: z.boolean().optional(),
  },
  handler: async (args, ctx) => {
    const lab = await ctx.lab(args.lab);
    const ids = [...new Set(args.lines.map((l) => l.item_id))];
    const { data: itemRows, error: itemErr } = await ctx.sb
      .from("items")
      .select(`${ITEM_COLS}, order_request_items(requested_quantity, unit, order_requests(id, status, created_at))`)
      .eq("lab_id", lab.id)
      .in("id", ids);
    if (itemErr) throw itemErr;
    const items = new Map((itemRows ?? []).map((r: any) => [r.id as string, r as ItemRow]));
    const missing = ids.filter((id) => !items.has(id));
    if (missing.length) throw new Error(`These item ids are not in ${lab.name}'s catalog (or not visible): ${missing.join(", ")}`);
    const inactive = ids.filter((id) => !items.get(id)!.is_active);
    if (inactive.length) throw new Error(`These items are archived: ${inactive.map((id) => items.get(id)!.name).join(", ")}`);
    if (!args.allow_duplicate) {
      const covered = ids
        .map((id) => ({ item: items.get(id)!.name, item_id: id, open_requests: openRequestsOf(items.get(id)!) }))
        .filter((x) => x.open_requests.length > 0);
      if (covered.length) {
        return {
          created: false,
          message: "Open order requests already cover some of these items. Pass allow_duplicate=true if a second order is really needed.",
          covered,
        };
      }
    }
    const projectId = args.project ? (await ctx.project(lab.id, args.project)).id : null;
    const { data: req, error: reqErr } = await ctx.sb
      .from("order_requests")
      .insert({
        lab_id: lab.id,
        requested_by: ctx.userId,
        project_id: projectId,
        reason: await ctx.tag(args.reason),
        status: "draft",
      })
      .select(REQUEST_COLS)
      .single();
    if (reqErr) throw reqErr;
    const requestId = (req as any).id as string;
    try {
      const { error: lineErr } = await ctx.sb.from("order_request_items").insert(
        args.lines.map((l) => ({
          order_request_id: requestId,
          item_id: l.item_id,
          requested_quantity: l.quantity ?? null,
          unit: cleanText(l.unit) ?? items.get(l.item_id)!.default_unit,
          priority: l.priority ?? null,
          note: cleanText(l.note),
        }))
      );
      if (lineErr) throw lineErr;
      let status = "draft";
      if (args.submit !== false) {
        const { data: sub, error: subErr } = await ctx.sb.rpc("submit_order_request", { p_request_id: requestId }).single();
        if (subErr) throw subErr;
        status = (sub as any).status;
      }
      await ctx.logWrite({
        tool: "supply_request_order",
        lab_id: lab.id,
        summary: `order request (${status}) for ${args.lines.map((l) => items.get(l.item_id)!.name).join(", ")}`,
        ids: { request_id: requestId },
      });
      return {
        created: true,
        request_id: requestId,
        status,
        lines: args.lines.map((l) => ({ item: items.get(l.item_id)!.name, quantity: l.quantity ?? null })),
        next:
          status === "submitted"
            ? "Waiting for an owner/admin to approve or deny it in Supply Manager."
            : "Draft saved — only you and admins can see it until it is submitted.",
      };
    } catch (err) {
      // Don't leave a half-built draft behind.
      await ctx.sb.from("order_requests").delete().eq("id", requestId).eq("status", "draft");
      throw err;
    }
  },
});

export const withdrawRequest = defineTool({
  name: "supply_withdraw_request",
  title: "Withdraw order request",
  kind: "write",
  description: "Withdraw an order request you submitted that hasn't been decided yet.",
  input: { request_id: z.string().uuid() },
  handler: async (args, ctx) => {
    const { data, error } = await ctx.sb.rpc("withdraw_order_request", { p_request_id: args.request_id }).single();
    if (error) throw error;
    await ctx.logWrite({
      tool: "supply_withdraw_request",
      lab_id: (data as any).lab_id,
      summary: "withdrew order request",
      ids: { request_id: args.request_id },
    });
    return { withdrawn: true, request_id: args.request_id, status: (data as any).status };
  },
});

// ---------------------------------------------------------------------------
// Admin tools (owner/admin role + SEINE_MCP_ENABLE_ADMIN_TOOLS=1)
// ---------------------------------------------------------------------------

export const reviewRequest = defineTool({
  name: "supply_review_request",
  title: "Approve / deny order request",
  kind: "admin",
  description:
    "Approve or deny a submitted order request (owner/admin only). A denial needs a note. On approval you may " +
    "assign a funding alias (see seine_list_funding_aliases) or mark funding not required.",
  input: {
    request_id: z.string().uuid(),
    decision: z.enum(["approve", "deny"]),
    note: z.string().optional(),
    funding_source_id: z.string().uuid().optional(),
    funding_required: z.boolean().optional().describe("Default true."),
  },
  handler: async (args, ctx) => {
    const note = args.note?.trim() ? await ctx.tag(args.note) : null;
    const call =
      args.decision === "approve"
        ? ctx.sb.rpc("approve_order_request", {
            p_request_id: args.request_id,
            p_note: note,
            p_funding_source_id: args.funding_source_id ?? null,
            p_funding_required: args.funding_required ?? true,
          })
        : (() => {
            if (!note) throw new Error("A denial note is required.");
            return ctx.sb.rpc("deny_order_request", { p_request_id: args.request_id, p_note: note });
          })();
    const { data, error } = await call.single();
    if (error) throw error;
    await ctx.logWrite({
      tool: "supply_review_request",
      lab_id: (data as any).lab_id,
      summary: `${args.decision} order request`,
      ids: { request_id: args.request_id },
    });
    return { request_id: args.request_id, status: (data as any).status };
  },
});

export const placeOrder = defineTool({
  name: "supply_place_order",
  title: "Mark order placed",
  kind: "admin",
  description: "Record that an approved request was ordered from a vendor (owner/admin only).",
  input: {
    request_id: z.string().uuid(),
    company: z.string().optional(),
    order_number: z.string().optional(),
    tracking_number: z.string().optional(),
    expected_arrival: z.string().optional().describe("ISO date/time."),
    note: z.string().optional(),
  },
  handler: async (args, ctx) => {
    const { data, error } = await ctx.sb
      .rpc("place_supply_order", {
        p_request_id: args.request_id,
        p_company: cleanText(args.company),
        p_order_number: cleanText(args.order_number),
        p_tracking_number: cleanText(args.tracking_number),
        p_expected_arrival: cleanText(args.expected_arrival),
        p_note: await ctx.tag(args.note),
      })
      .single();
    if (error) throw error;
    await ctx.logWrite({
      tool: "supply_place_order",
      summary: `placed order${args.company ? ` with ${args.company}` : ""}`,
      ids: { request_id: args.request_id, order_id: (data as any).id },
    });
    return { order: data };
  },
});

export const receiveOrder = defineTool({
  name: "supply_receive_order",
  title: "Receive order",
  kind: "admin",
  description:
    "Record delivery of a placed order (owner/admin only): one lot per received item, optionally partial, and " +
    "optionally mark those items' stock as 'plenty'.",
  input: {
    order_id: z.string().uuid(),
    lots: z
      .array(
        z.object({
          item_id: z.string().uuid(),
          lot_number: z.string().optional(),
          received_quantity: z.number().min(0).optional(),
          unit: z.string().optional(),
          expiration_date: z.string().optional().describe("YYYY-MM-DD"),
          storage_location: z.string().optional(),
          note: z.string().optional(),
        })
      )
      .min(1),
    partial: z.boolean().optional(),
    mark_inventory_full: z.boolean().optional(),
    note: z.string().optional(),
  },
  handler: async (args, ctx) => {
    const { data, error } = await ctx.sb
      .rpc("receive_supply_order", {
        p_order_id: args.order_id,
        p_lots: args.lots.map((l) => ({
          item_id: l.item_id,
          lot_number: cleanText(l.lot_number),
          received_quantity: l.received_quantity ?? null,
          unit: cleanText(l.unit),
          expiration_date: cleanText(l.expiration_date),
          storage_location: cleanText(l.storage_location),
          note: cleanText(l.note),
        })),
        p_partial: args.partial ?? false,
        p_mark_inventory_full: args.mark_inventory_full ?? false,
        p_note: await ctx.tag(args.note),
      })
      .single();
    if (error) throw error;
    await ctx.logWrite({
      tool: "supply_receive_order",
      summary: `received order (${args.lots.length} lot(s))${args.partial ? " — partial" : ""}`,
      ids: { order_id: args.order_id },
    });
    return { order: data };
  },
});

export const supplyTools = [
  searchItems,
  getItem,
  lowStock,
  listRequests,
  createItem,
  updateItem,
  recordCheck,
  requestOrder,
  withdrawRequest,
  reviewRequest,
  placeOrder,
  receiveOrder,
];
