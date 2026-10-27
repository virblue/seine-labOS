import type { SeineContext } from "../context.ts";

// update_dataset is a FULL replace: every column, the tag set, the project
// links and the primary storage link are rewritten from its arguments. Any
// partial edit therefore has to load the current state and pass it all back.

export const DATASET_COLS =
  "id, lab_id, name, description, dataset_type, source_type, status, access_level, owner_user_id, contact_user_id, " +
  "organism, sample_type, assay_platform, external_accession, citation, license, usage_conditions, recommended_use, " +
  "not_recommended_use, qc_summary, notes, created_by, updated_by, created_at, updated_at, archived_at";

export const DATASET_FIELDS = [
  "name",
  "description",
  "dataset_type",
  "source_type",
  "status",
  "access_level",
  "owner_user_id",
  "contact_user_id",
  "organism",
  "sample_type",
  "assay_platform",
  "external_accession",
  "citation",
  "license",
  "usage_conditions",
  "recommended_use",
  "not_recommended_use",
  "qc_summary",
  "notes",
] as const;

export type DatasetField = (typeof DATASET_FIELDS)[number];

export interface ProjectLink {
  project_id: string;
  relationship_type: string;
  note?: string | null;
}

export type DatasetValues = Partial<Record<DatasetField, string | null>> & {
  tags: string[];
  storage_uri: string | null;
};

export interface DatasetState extends DatasetValues {
  id: string;
  lab_id: string;
  owner_user_id: string | null;
  contact_user_id: string | null;
  updated_at: string;
  archived_at: string | null;
  project_links: ProjectLink[];
  raw: Record<string, unknown>;
}

export async function loadDatasetState(ctx: SeineContext, datasetId: string): Promise<DatasetState> {
  const { data, error } = await ctx.sb
    .from("datasets")
    .select(
      `${DATASET_COLS}, dataset_tags(tag), dataset_project_links(project_id, relationship_type, note), ` +
        "dataset_storage_links(storage_uri, dataset_version_id, label, created_at)"
    )
    .eq("id", datasetId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`No dataset ${datasetId} is visible to you.`);
  const d = data as any;
  const primary = (d.dataset_storage_links ?? [])
    .filter((s: any) => s.dataset_version_id === null)
    .sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  const state: DatasetState = {
    id: d.id,
    lab_id: d.lab_id,
    owner_user_id: d.owner_user_id,
    contact_user_id: d.contact_user_id,
    updated_at: d.updated_at,
    archived_at: d.archived_at,
    tags: (d.dataset_tags ?? []).map((t: any) => t.tag as string),
    storage_uri: primary?.storage_uri ?? null,
    project_links: (d.dataset_project_links ?? []).map((l: any) => ({
      project_id: l.project_id,
      relationship_type: l.relationship_type,
      note: l.note,
    })),
    raw: d,
  };
  for (const f of DATASET_FIELDS) (state as unknown as Record<string, unknown>)[f] = d[f] ?? null;
  return state;
}

// Arguments shared by create_dataset and update_dataset (minus p_lab_id /
// p_dataset_id, which the caller adds).
export const datasetRpcArgs = (v: DatasetValues, projectLinks: ProjectLink[]): Record<string, unknown> => {
  const args: Record<string, unknown> = {};
  for (const f of DATASET_FIELDS) args[`p_${f}`] = v[f] ?? null;
  args.p_dataset_type = v.dataset_type ?? "other";
  args.p_source_type = v.source_type ?? "internal-generated";
  args.p_status = v.status ?? "planned";
  args.p_access_level = v.access_level ?? "request-required";
  args.p_tags = v.tags;
  args.p_project_links = projectLinks.map((l) => ({
    project_id: l.project_id,
    relationship_type: l.relationship_type,
    note: l.note ?? null,
  }));
  args.p_storage_uri = v.storage_uri;
  return args;
};
