import type { SeineContext } from "../context.ts";
import { datasetRpcArgs, loadDatasetState } from "../tools/datahubState.ts";
import {
  REGISTRY_SYSTEM,
  mapRegistryRow,
  payloadHash,
  readRegistry,
  type AccessLevel,
  type RegistryRow,
} from "./labRegistry.ts";

export type SyncAction = "create" | "update" | "unchanged" | "conflict" | "error" | "orphaned";

export interface SyncResult {
  lab: string;
  applied: boolean;
  counts: Record<SyncAction, number>;
  actions: Array<{ registry_id: string; action: SyncAction; dataset_id?: string; name?: string; reason?: string }>;
}

interface LinkRow {
  id: string;
  external_id: string;
  record_id: string;
  source_hash: string | null;
  last_synced_at: string;
}

// One-way sync: lab registry -> Seine Data Hub, keyed by integration_links.
//   - unchanged upstream (same payload hash)          -> skip
//   - edited in Seine since our last write            -> conflict, skip (force overrides)
//   - otherwise update, keeping Seine-side project links and any extra tags
// Registry rows that disappeared are reported as "orphaned", never deleted.
export async function syncLabRegistry(
  ctx: SeineContext,
  opts: { lab?: string | null; ids?: string[]; apply?: boolean; force?: boolean; accessLevel?: AccessLevel }
): Promise<SyncResult> {
  const dbPath = ctx.cfg.labRegistryDb;
  if (!dbPath) throw new Error("No lab registry configured (seine config --lab-registry-db <path>).");
  const lab = await ctx.lab(opts.lab);
  const rows: RegistryRow[] = await readRegistry(dbPath, opts.ids);
  if (opts.ids?.length) {
    const found = new Set(rows.map((r) => r.id));
    const missing = opts.ids.filter((id) => !found.has(id));
    if (missing.length) throw new Error(`Not in the lab registry: ${missing.join(", ")}`);
  }

  const { data: linkData, error: linkErr } = await ctx.sb
    .from("integration_links")
    .select("id, external_id, record_id, source_hash, last_synced_at")
    .eq("lab_id", lab.id)
    .eq("system", REGISTRY_SYSTEM)
    .eq("entity", "dataset");
  if (linkErr) {
    if (linkErr.code === "42P01" || /integration_links/.test(linkErr.message)) {
      throw new Error(
        "This Seine database has no integration_links table yet — apply supabase/migrations/20261027000000_integration_links.sql."
      );
    }
    throw linkErr;
  }
  const links = new Map<string, LinkRow>((linkData ?? []).map((l: any) => [l.external_id, l as LinkRow]));

  const linkedIds = [...links.values()].map((l) => l.record_id);
  const live = new Map<string, { id: string; updated_at: string; archived_at: string | null }>();
  for (let i = 0; i < linkedIds.length; i += 100) {
    const { data, error } = await ctx.sb
      .from("datasets")
      .select("id, updated_at, archived_at")
      .in("id", linkedIds.slice(i, i + 100));
    if (error) throw error;
    for (const d of data ?? []) live.set((d as any).id, d as any);
  }

  const result: SyncResult = {
    lab: lab.name,
    applied: Boolean(opts.apply),
    counts: { create: 0, update: 0, unchanged: 0, conflict: 0, error: 0, orphaned: 0 },
    actions: [],
  };
  const push = (a: SyncResult["actions"][number]) => {
    result.counts[a.action] += 1;
    result.actions.push(a);
  };

  for (const row of rows) {
    const payload = mapRegistryRow(row, { accessLevel: opts.accessLevel });
    const hash = payloadHash(payload);
    const link = links.get(row.id);
    const target = link ? live.get(link.record_id) : undefined;
    try {
      if (link && target) {
        if (link.source_hash === hash && !opts.force) {
          push({ registry_id: row.id, action: "unchanged", dataset_id: target.id });
          continue;
        }
        if (Date.parse(target.updated_at) > Date.parse(link.last_synced_at) && !opts.force) {
          push({
            registry_id: row.id,
            action: "conflict",
            dataset_id: target.id,
            reason: "edited in Seine since the last sync; re-run with force to overwrite",
          });
          continue;
        }
        if (!opts.apply) {
          push({ registry_id: row.id, action: "update", dataset_id: target.id, name: payload.name });
          continue;
        }
        const current = await loadDatasetState(ctx, target.id);
        const tags = [...new Set([...payload.tags, ...current.tags])];
        const { data, error } = await ctx.sb
          .rpc(
            "update_dataset",
            datasetRpcArgs(
              { ...payload, tags, owner_user_id: current.owner_user_id, contact_user_id: current.contact_user_id },
              current.project_links
            )
          )
          .single();
        if (error) throw error;
        const { error: upErr } = await ctx.sb
          .from("integration_links")
          .update({ source_hash: hash, last_synced_at: (data as any).updated_at })
          .eq("id", link.id);
        if (upErr) throw upErr;
        push({ registry_id: row.id, action: "update", dataset_id: target.id, name: payload.name });
        continue;
      }

      if (!opts.apply) {
        push({
          registry_id: row.id,
          action: "create",
          name: payload.name,
          reason: link ? "previously linked dataset is gone; will recreate" : undefined,
        });
        continue;
      }
      const { data, error } = await ctx.sb
        .rpc(
          "create_dataset",
          {
            p_lab_id: lab.id,
            ...datasetRpcArgs({ ...payload, owner_user_id: ctx.userId, contact_user_id: ctx.userId }, []),
          }
        )
        .single();
      if (error) throw error;
      const created = data as any;
      const linkRow = {
        lab_id: lab.id,
        system: REGISTRY_SYSTEM,
        entity: "dataset",
        external_id: row.id,
        record_id: created.id,
        source_hash: hash,
        last_synced_at: created.updated_at,
        created_by: ctx.userId,
      };
      const { error: lErr } = link
        ? await ctx.sb.from("integration_links").update(linkRow).eq("id", link.id)
        : await ctx.sb.from("integration_links").insert(linkRow);
      if (lErr) throw lErr;
      push({ registry_id: row.id, action: "create", dataset_id: created.id, name: payload.name });
    } catch (err) {
      push({ registry_id: row.id, action: "error", reason: (err as Error).message ?? String(err) });
    }
  }

  if (!opts.ids?.length) {
    const present = new Set(rows.map((r) => r.id));
    for (const [externalId, link] of links) {
      if (!present.has(externalId)) {
        push({
          registry_id: externalId,
          action: "orphaned",
          dataset_id: link.record_id,
          reason: "no longer in the lab registry; left untouched in Seine",
        });
      }
    }
  }

  if (opts.apply && (result.counts.create || result.counts.update)) {
    await ctx.logWrite({
      tool: "datahub_sync_lab_registry",
      lab_id: lab.id,
      summary: `lab registry sync: ${result.counts.create} created, ${result.counts.update} updated`,
      ids: {
        created: result.actions.filter((a) => a.action === "create").map((a) => a.registry_id),
        updated: result.actions.filter((a) => a.action === "update").map((a) => a.registry_id),
      },
    });
  }
  return result;
}
