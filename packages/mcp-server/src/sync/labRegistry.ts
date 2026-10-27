import { createHash } from "node:crypto";

// Adapter for a lab-side dataset registry (the SQLite `datasets` table behind
// the Wang lab's `lab data` CLI): one registry row -> one Seine Data Hub
// dataset. The registry stays the source of truth for these rows; Seine is the
// browsable, access-controlled view. Mapping is pure so it can be unit-tested.

export const REGISTRY_SYSTEM = "lab-registry";

export interface RegistryRow {
  id: string;
  study_name: string;
  accession: string | null;
  subset: string | null;
  paper_url: string | null;
  location: string;
  tags: string | null;
  samples: string | null;
  status_line: string;
  verified: number | null;
  verified_how: string | null;
  usage: string;
  size_bytes: number | null;
  n_files: number | null;
  md5_checked: number | null;
  pair_of: string | null;
  role: string | null;
  ref_genome: string | null;
  benchmark_valid: number | null;
  benchmark_note: string | null;
  provenance: string | null;
  notes: string | null;
  added_by: string | null;
  updated_by: string;
  created: string;
  updated: string;
}

export type AccessLevel = "open-lab" | "request-required" | "restricted" | "private";

export interface DatasetPayload {
  name: string;
  description: string | null;
  dataset_type: string;
  source_type: string;
  status: string;
  access_level: AccessLevel;
  organism: string | null;
  sample_type: string | null;
  assay_platform: string | null;
  external_accession: string | null;
  citation: string | null;
  license: string | null;
  usage_conditions: string | null;
  recommended_use: string | null;
  not_recommended_use: string | null;
  qc_summary: string | null;
  notes: string | null;
  tags: string[];
  storage_uri: string;
}

const ACCESSION_RE =
  /^(GSE|GSM|GDS|SRP|SRR|SRX|SRS|ERP|ERR|ERX|ERS|DRP|DRR|DRX|PRJNA|PRJEB|PRJDB|SAMN|SAMEA|E-MTAB-|E-GEOD-|PXD|EGAS|EGAD)\d+/i;
const PDB_RE = /^\d[A-Za-z0-9]{3}$/;

export const isPublicAccession = (acc: string | null | undefined): boolean => {
  const a = (acc ?? "").trim();
  return a !== "" && (ACCESSION_RE.test(a) || PDB_RE.test(a));
};

const ORGANISMS: Array<[RegExp, string]> = [
  [/\b(human|homo sapiens|hek293t?|hela|h9|hesc|k562|hepg2|grch38)\b/i, "Homo sapiens"],
  [/\b(mouse|mus musculus|grcm\d+)\b/i, "Mus musculus"],
  [/\b(yeast|s\.\s?cerevisiae|cerevisiae)\b/i, "Saccharomyces cerevisiae"],
  [/\b(e\.\s?coli|ecoli|escherichia)\b/i, "Escherichia coli"],
  [/\b(c\.\s?albicans|calbicans|candida)\b/i, "Candida albicans"],
  [/\bsars-?cov-?2\b/i, "SARS-CoV-2"],
  [/\binfluenza\b/i, "Influenza A virus"],
  [/\bhiv(-1)?\b/i, "HIV-1"],
  [/\b(rice|oryza)\b/i, "Oryza sativa"],
];

const PLATFORMS: Array<[RegExp, string]> = [
  [/\brna004\b/i, "ONT direct RNA (RNA004)"],
  [/\brna002\b/i, "ONT direct RNA (RNA002)"],
  [/\b(illumina|illumina-map|cdna-map|shapemapper2?|bisulfite|glori|bid-seq|ubs-seq|dreem|map-?seq)\b/i, "Illumina"],
];

const unique = <T>(xs: T[]): T[] => [...new Set(xs)];

export const splitTags = (raw: string | null): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of (raw ?? "").split(/[\s,]+/)) {
    const tag = t.trim().slice(0, 60);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
};

const humanBytes = (n: number | null): string | null => {
  if (n === null || n === undefined) return null;
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
};

export function mapRegistryRow(row: RegistryRow, opts: { accessLevel?: AccessLevel } = {}): DatasetPayload {
  const tags = splitTags(row.tags);
  const haystack = [row.id, row.study_name, row.subset, row.samples, tags.join(" ")].filter(Boolean).join(" ");
  const tagSet = new Set(tags.map((t) => t.toLowerCase()));

  const organism = unique(ORGANISMS.filter(([re]) => re.test(haystack)).map(([, name]) => name));
  let platforms = unique(PLATFORMS.filter(([re]) => re.test(haystack)).map(([, name]) => name));
  if (!platforms.some((p) => p.startsWith("ONT")) && /\b(drs|nanopore|pod5|fast5)\b/i.test(haystack)) {
    platforms = ["Oxford Nanopore", ...platforms];
  }
  if (tagSet.has("not-nanopore")) platforms = platforms.filter((p) => !p.startsWith("ONT") && p !== "Oxford Nanopore");

  const datasetType =
    platforms.length > 0
      ? "sequencing"
      : /\b(gold|reference|crystal|pdb|annotation|catalog)\b/i.test(haystack)
        ? "annotation"
        : /\b(synthetic|simulat\w*)\b/i.test(haystack)
          ? "simulation"
          : "other";

  const inHouse = /\b(in-house|inhouse|wetlab|wet-lab)\b/i.test(haystack) || /^(inhouse|wetlab)/i.test(row.id);
  const derived =
    row.role === "derived" ||
    /\b(derived|calls|embeddings|fixed|two-channel|intermediates|per-read|results|signalbam)\b/i.test(haystack);
  const publicAcc = isPublicAccession(row.accession);
  const sourceType = inHouse ? "internal-generated" : publicAcc && !derived ? "external-public" : "internal-generated";

  const status = /\b(deprecated|superseded|retired)\b/i.test(row.status_line)
    ? "deprecated"
    : row.verified
      ? "validated"
      : /\b(pod5|fast5|raw)\b/i.test(haystack)
        ? "raw-available"
        : "processing";

  const name = (row.subset ? `${row.study_name} — ${row.subset}` : row.study_name).slice(0, 300);
  const description = [row.samples ? `Samples: ${row.samples}` : null, row.status_line].filter(Boolean).join("\n\n");

  const sizeBits = [row.n_files != null ? `${row.n_files} files` : null, humanBytes(row.size_bytes)].filter(Boolean);
  const qc = [
    row.verified ? `Verified in lab registry: ${row.verified_how ?? "(no method recorded)"}` : "Not yet verified in the lab registry.",
    row.md5_checked ? "Checksums verified." : null,
    sizeBits.length ? `Size: ${sizeBits.join(", ")}.` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const benchmark =
    row.benchmark_valid === null || row.benchmark_valid === undefined
      ? null
      : `Benchmark-valid: ${row.benchmark_valid ? "yes" : "no"}${row.benchmark_note ? ` — ${row.benchmark_note}` : ""}`;
  const notes = [
    `Synced from the lab dataset registry (id: ${row.id}). Edit it there — the next sync overwrites these fields.`,
    row.accession && !publicAcc ? `Registry accession field: ${row.accession}` : null,
    row.role ? `Role: ${row.role}` : null,
    row.pair_of ? `Pair of: ${row.pair_of}` : null,
    row.ref_genome ? `Reference: ${row.ref_genome}` : null,
    benchmark,
    row.provenance ? `Provenance: ${row.provenance}` : null,
    row.notes ? `Notes: ${row.notes}` : null,
    `Registered by ${row.added_by ?? "?"} ${row.created}; last updated by ${row.updated_by} ${row.updated}.`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    name,
    description: description || null,
    dataset_type: datasetType,
    source_type: sourceType,
    status,
    access_level: opts.accessLevel ?? "open-lab",
    organism: organism.length ? organism.join("; ") : null,
    sample_type: null,
    assay_platform: platforms.length ? platforms.join("; ") : null,
    external_accession: publicAcc ? (row.accession as string).trim().slice(0, 200) : null,
    citation: row.paper_url?.trim() || null,
    license: null,
    usage_conditions: null,
    recommended_use: row.usage?.trim() || null,
    not_recommended_use: null,
    qc_summary: qc,
    notes,
    tags: [...tags.slice(0, 39), REGISTRY_SYSTEM],
    storage_uri: row.location.trim(),
  };
}

const stable = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v as Record<string, unknown>)
            .sort()
            .map((k) => [k, stable((v as Record<string, unknown>)[k])])
        )
      : v;

export const payloadHash = (p: DatasetPayload): string =>
  createHash("sha256").update(JSON.stringify(stable(p))).digest("hex");

export async function readRegistry(dbPath: string, ids?: string[]): Promise<RegistryRow[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const where = ids?.length ? `where id in (${ids.map(() => "?").join(",")})` : "";
    return db.prepare(`select * from datasets ${where} order by id`).all(...(ids ?? [])) as unknown as RegistryRow[];
  } finally {
    db.close();
  }
}
