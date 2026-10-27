import { z } from "zod";
import type { SeineContext } from "../context.ts";
import { REGISTRY_SYSTEM } from "../sync/labRegistry.ts";
import { syncLabRegistry } from "../sync/syncDatasets.ts";
import { applyTextSearch, cleanText, defineTool, labArg, patchText } from "./define.ts";
import { DATASET_COLS, DATASET_FIELDS, datasetRpcArgs, loadDatasetState, type ProjectLink } from "./datahubState.ts";

// Mirrors the Data Hub web app (apps/data-hub/src/lib/cloudAdapter.ts): writes
// go through the create_dataset / update_dataset / create_dataset_version RPCs,
// so visibility (open-lab / request-required / restricted / private) and edit
// rights (owner, contact, creator, or lab admin) are enforced server-side.

export const DATASET_TYPES = [
  "sequencing",
  "imaging",
  "flow-cytometry",
  "proteomics",
  "metabolomics",
  "simulation",
  "annotation",
  "clinical",
  "external-reference",
  "other",
] as const;
export const SOURCE_TYPES = [
  "internal-generated",
  "external-public",
  "collaborator-shared",
  "vendor-provided",
  "user-uploaded-metadata",
  "other",
] as const;
export const DATASET_STATUSES = [
  "planned",
  "generating",
  "raw-available",
  "processing",
  "processed",
  "validated",
  "archived",
  "deprecated",
] as const;
export const ACCESS_LEVELS = ["open-lab", "request-required", "restricted", "private"] as const;
export const VERSION_TYPES = [
  "raw",
  "processed",
  "analysis-ready",
  "derived",
  "annotation",
  "figure-source",
  "model-input",
  "other",
] as const;
export const RELATIONSHIP_TYPES = [
  "generated-by",
  "used-by",
  "derived-from",
  "supports-publication",
  "external-reference",
  "validation",
  "training",
  "benchmark",
] as const;

const DATASET_SEARCH_COLUMNS = [
  "name",
  "description",
  "external_accession",
  "organism",
  "assay_platform",
  "sample_type",
  "recommended_use",
  "notes",
];

const projectLinkInput = z.object({
  project: z.string().describe("Project id or name."),
  relationship_type: z.enum(RELATIONSHIP_TYPES).optional().describe("Default 'used-by'."),
  note: z.string().optional(),
});

const datasetFieldsInput = {
  description: z.string().optional(),
  dataset_type: z.enum(DATASET_TYPES).optional(),
  source_type: z.enum(SOURCE_TYPES).optional(),
  status: z.enum(DATASET_STATUSES).optional(),
  access_level: z.enum(ACCESS_LEVELS).optional(),
  organism: z.string().optional(),
  sample_type: z.string().optional(),
  assay_platform: z.string().optional(),
  external_accession: z.string().optional().describe("GEO/SRA/ENA/PDB accession."),
  citation: z.string().optional().describe("DOI / paper URL."),
  license: z.string().optional(),
  usage_conditions: z.string().optional(),
  recommended_use: z.string().optional(),
  not_recommended_use: z.string().optional(),
  qc_summary: z.string().optional(),
  notes: z.string().optional(),
  storage_uri: z.string().optional().describe("Primary location: filesystem path, s3://, https:// …"),
};

export const searchDatasets = defineTool({
  name: "datahub_search_datasets",
  title: "Search Data Hub",
  kind: "read",
  description:
    "Search the lab's Data Hub dataset registry by free text (name, description, accession, organism, platform, " +
    "notes) and/or filters. Returns compact rows; use datahub_get_dataset for versions, storage locations and " +
    "project links. Datasets you lack access to are hidden by Seine.",
  input: {
    lab: labArg,
    query: z.string().optional(),
    dataset_type: z.enum(DATASET_TYPES).optional(),
    status: z.enum(DATASET_STATUSES).optional(),
    tag: z.string().optional().describe("Exact tag (case-insensitive)."),
    include_archived: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional().describe("Default 30."),
  },
  handler: async (args, ctx) => {
    const lab = await ctx.lab(args.lab);
    let q = ctx.sb
      .from("datasets")
      .select(
        "id, name, dataset_type, source_type, status, access_level, organism, assay_platform, external_accession, updated_at, archived_at, dataset_tags(tag)"
      )
      .eq("lab_id", lab.id)
      .order("updated_at", { ascending: false });
    if (!args.include_archived) q = q.is("archived_at", null);
    if (args.dataset_type) q = q.eq("dataset_type", args.dataset_type);
    if (args.status) q = q.eq("status", args.status);
    q = applyTextSearch(q, DATASET_SEARCH_COLUMNS, args.query);
    const { data, error } = await q;
    if (error) throw error;
    let rows = (data ?? []) as any[];
    if (args.tag) {
      const want = args.tag.trim().toLowerCase();
      rows = rows.filter((r) => (r.dataset_tags ?? []).some((t: any) => String(t.tag).toLowerCase() === want));
    }
    const limit = args.limit ?? 30;
    return {
      lab: lab.name,
      matched: rows.length,
      datasets: rows.slice(0, limit).map((r) => ({
        id: r.id,
        name: r.name,
        type: r.dataset_type,
        source: r.source_type,
        status: r.status,
        access: r.access_level,
        organism: r.organism,
        platform: r.assay_platform,
        accession: r.external_accession,
        tags: (r.dataset_tags ?? []).map((t: any) => t.tag),
        updated_at: r.updated_at,
        ...(r.archived_at ? { archived_at: r.archived_at } : {}),
      })),
    };
  },
});

export const getDataset = defineTool({
  name: "datahub_get_dataset",
  title: "Dataset details",
  kind: "read",
  description:
    "Everything Seine knows about one dataset: metadata, owner/contact, tags, storage locations (if you're " +
    "allowed to see them), versions with lineage, linked projects, and the lab-registry id it was synced from.",
  input: { dataset_id: z.string().uuid() },
  handler: async (args, ctx) => {
    const state = await loadDatasetState(ctx, args.dataset_id);
    const labId = state.lab_id;
    const [{ data: versions, error: vErr }, { data: storage, error: sErr }, { data: links }] = await Promise.all([
      ctx.sb
        .from("dataset_versions")
        .select(
          "id, version_name, version_type, description, parent_version_id, processing_summary, software_environment, qc_summary, file_summary, notes, created_at"
        )
        .eq("dataset_id", args.dataset_id)
        .order("created_at"),
      ctx.sb
        .from("dataset_storage_links")
        .select("label, storage_uri, storage_type, dataset_version_id, notes")
        .eq("dataset_id", args.dataset_id),
      ctx.sb
        .from("integration_links")
        .select("system, external_id, last_synced_at")
        .eq("entity", "dataset")
        .eq("record_id", args.dataset_id),
    ]);
    if (vErr) throw vErr;
    if (sErr) throw sErr;
    const raw = state.raw as Record<string, any>;
    return {
      id: state.id,
      ...Object.fromEntries(DATASET_FIELDS.filter((f) => !f.endsWith("_user_id")).map((f) => [f, raw[f] ?? null])),
      owner: await ctx.memberName(labId, state.owner_user_id),
      contact: await ctx.memberName(labId, state.contact_user_id),
      tags: state.tags,
      storage: storage ?? [],
      versions: versions ?? [],
      projects: await Promise.all(
        state.project_links.map(async (l) => ({
          project: await ctx.projectName(labId, l.project_id),
          relationship: l.relationship_type,
          note: l.note,
        }))
      ),
      external_links: links ?? [],
      created_at: raw.created_at,
      updated_at: raw.updated_at,
      ...(raw.archived_at ? { archived_at: raw.archived_at } : {}),
    };
  },
});

async function resolveLinks(
  ctx: SeineContext,
  labId: string,
  links: Array<z.infer<typeof projectLinkInput>> | undefined
): Promise<ProjectLink[]> {
  return Promise.all(
    (links ?? []).map(async (l) => ({
      project_id: (await ctx.project(labId, l.project)).id,
      relationship_type: l.relationship_type ?? "used-by",
      note: cleanText(l.note),
    }))
  );
}

export const createDataset = defineTool({
  name: "datahub_create_dataset",
  title: "Register dataset",
  kind: "write",
  description:
    "Register a new dataset in the lab's Data Hub (metadata + location only; Seine never stores the files). Needs " +
    "at least one of storage_uri, external_accession or citation. You become owner and contact unless the web app " +
    "changes it. Default access_level is 'request-required' (same as the web app). Refuses if a dataset with the " +
    "same name already exists, unless allow_duplicate.",
  input: {
    lab: labArg,
    name: z.string().min(1),
    ...datasetFieldsInput,
    tags: z.array(z.string()).optional(),
    project_links: z.array(projectLinkInput).optional(),
    allow_duplicate: z.boolean().optional(),
  },
  handler: async (args, ctx) => {
    const lab = await ctx.lab(args.lab);
    if (!args.allow_duplicate) {
      const { data: same, error } = await ctx.sb.from("datasets").select("id, name").eq("lab_id", lab.id).ilike("name", args.name.trim().replace(/[%_]/g, "\\$&"));
      if (error) throw error;
      if (same?.length) return { created: false, message: "A dataset with this name already exists.", existing: same };
    }
    const projectLinks = await resolveLinks(ctx, lab.id, args.project_links);
    const values = {
      name: args.name.trim(),
      ...Object.fromEntries(DATASET_FIELDS.filter((f) => f !== "name").map((f) => [f, cleanText((args as any)[f])])),
      owner_user_id: ctx.userId,
      contact_user_id: ctx.userId,
      notes: args.notes?.trim() ? await ctx.tag(args.notes) : await ctx.tag("Registered"),
      tags: [...new Set((args.tags ?? []).map((t) => t.trim()).filter(Boolean))],
      storage_uri: cleanText(args.storage_uri),
    };
    const { data, error } = await ctx.sb
      .rpc("create_dataset", { p_lab_id: lab.id, ...datasetRpcArgs(values, projectLinks) })
      .single();
    if (error) throw error;
    const d = data as any;
    await ctx.logWrite({ tool: "datahub_create_dataset", lab_id: lab.id, summary: `registered dataset "${d.name}"`, ids: { dataset_id: d.id } });
    return { created: true, dataset_id: d.id, name: d.name, status: d.status, access_level: d.access_level };
  },
});

export const updateDataset = defineTool({
  name: "datahub_update_dataset",
  title: "Edit dataset",
  kind: "write",
  description:
    "Edit a dataset's metadata. Only fields you pass change (empty string clears); tags can be replaced (tags) or " +
    "adjusted (add_tags / remove_tags); add_project_links appends links. Existing tags, links and storage are " +
    "preserved otherwise. Needs edit rights (owner, contact, creator, or lab admin).",
  input: {
    dataset_id: z.string().uuid(),
    name: z.string().min(1).optional(),
    ...datasetFieldsInput,
    tags: z.array(z.string()).optional().describe("Replace the whole tag set."),
    add_tags: z.array(z.string()).optional(),
    remove_tags: z.array(z.string()).optional(),
    add_project_links: z.array(projectLinkInput).optional(),
  },
  handler: async (args, ctx) => {
    const cur = await loadDatasetState(ctx, args.dataset_id);
    const next: Record<string, unknown> = { ...cur };
    const changed: string[] = [];
    if (args.name !== undefined && args.name.trim() !== cur.name) {
      next.name = args.name.trim();
      changed.push("name");
    }
    for (const f of DATASET_FIELDS) {
      if (f === "name" || f.endsWith("_user_id")) continue;
      const v = patchText((args as any)[f]);
      if (v !== undefined && v !== (cur as any)[f]) {
        next[f] = v;
        changed.push(f);
      }
    }
    if (args.notes !== undefined && args.notes.trim()) next.notes = await ctx.tag(args.notes);
    const sv = patchText(args.storage_uri);
    if (sv !== undefined && sv !== cur.storage_uri) {
      next.storage_uri = sv;
      changed.push("storage_uri");
    }
    let tags = args.tags ? args.tags.map((t) => t.trim()).filter(Boolean) : [...cur.tags];
    if (args.add_tags) tags.push(...args.add_tags.map((t) => t.trim()).filter(Boolean));
    if (args.remove_tags) {
      const drop = new Set(args.remove_tags.map((t) => t.trim().toLowerCase()));
      tags = tags.filter((t) => !drop.has(t.toLowerCase()));
    }
    tags = [...new Set(tags)];
    if (tags.join("\u0000") !== cur.tags.join("\u0000")) changed.push("tags");
    next.tags = tags;
    const extra = await resolveLinks(ctx, cur.lab_id, args.add_project_links);
    const key = (l: ProjectLink) => `${l.project_id}/${l.relationship_type}`;
    const have = new Set(cur.project_links.map(key));
    const added = extra.filter((l) => !have.has(key(l)));
    if (added.length) changed.push("project_links");
    if (changed.length === 0) return { updated: false, message: "Nothing to change." };

    const { data, error } = await ctx.sb
      .rpc("update_dataset", {
        p_dataset_id: cur.id,
        ...datasetRpcArgs(next as any, [...cur.project_links, ...added]),
      })
      .single();
    if (error) throw error;
    await ctx.logWrite({
      tool: "datahub_update_dataset",
      lab_id: cur.lab_id,
      summary: `updated dataset "${(data as any).name}": ${changed.join(", ")}`,
      ids: { dataset_id: cur.id },
    });
    return { updated: true, dataset_id: cur.id, changed };
  },
});

export const addVersion = defineTool({
  name: "datahub_add_version",
  title: "Add dataset version",
  kind: "write",
  description:
    "Record a new version of a dataset (raw / processed / analysis-ready / derived …) with its own storage " +
    "location, processing summary and software environment; set parent_version_id to record lineage.",
  input: {
    dataset_id: z.string().uuid(),
    version_name: z.string().min(1).describe("e.g. 'v2 dorado 2.1.0 sup@v6 rebasecall'"),
    version_type: z.enum(VERSION_TYPES).optional().describe("Default 'processed'."),
    description: z.string().optional(),
    parent_version_id: z.string().uuid().optional(),
    processing_summary: z.string().optional(),
    software_environment: z.string().optional(),
    qc_summary: z.string().optional(),
    file_summary: z.string().optional(),
    notes: z.string().optional(),
    storage_uri: z.string().optional(),
  },
  handler: async (args, ctx) => {
    const { data, error } = await ctx.sb
      .rpc("create_dataset_version", {
        p_dataset_id: args.dataset_id,
        p_version_name: args.version_name.trim(),
        p_version_type: args.version_type ?? "processed",
        p_description: cleanText(args.description),
        p_parent_version_id: args.parent_version_id ?? null,
        p_processing_summary: cleanText(args.processing_summary),
        p_software_environment: cleanText(args.software_environment),
        p_qc_summary: cleanText(args.qc_summary),
        p_file_summary: cleanText(args.file_summary),
        p_notes: await ctx.tag(args.notes),
        p_storage_uri: cleanText(args.storage_uri),
      })
      .single();
    if (error) throw error;
    const v = data as any;
    await ctx.logWrite({
      tool: "datahub_add_version",
      lab_id: v.lab_id,
      summary: `added version "${v.version_name}"`,
      ids: { dataset_id: args.dataset_id, version_id: v.id },
    });
    return { created: true, version_id: v.id, version_name: v.version_name, version_type: v.version_type };
  },
});

export const syncRegistry = defineTool({
  name: "datahub_sync_lab_registry",
  title: "Sync lab registry → Data Hub",
  kind: "write",
  description:
    `Mirror entries from the lab's own dataset registry (\`lab data\`, system "${REGISTRY_SYSTEM}") into Seine's ` +
    "Data Hub. DRY RUN by default: returns what would be created/updated; pass apply=true to write. Re-syncs " +
    "update the same Seine dataset (via integration_links), skip unchanged rows, and refuse to overwrite datasets " +
    "edited in Seine since the last sync unless force=true. Pass ids to sync just the entries you registered.",
  input: {
    lab: labArg,
    ids: z.array(z.string()).optional().describe("Registry ids (as shown by `lab data show`). Omit for all."),
    apply: z.boolean().optional(),
    force: z.boolean().optional(),
    access_level: z.enum(ACCESS_LEVELS).optional().describe("For newly mirrored datasets. Default 'open-lab'."),
  },
  handler: async (args, ctx) =>
    syncLabRegistry(ctx, {
      lab: args.lab,
      ids: args.ids,
      apply: args.apply,
      force: args.force,
      accessLevel: args.access_level,
    }),
});

export const datahubTools = [searchDatasets, getDataset, createDataset, updateDataset, addVersion, syncRegistry];
