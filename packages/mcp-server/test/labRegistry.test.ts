import assert from "node:assert/strict";
import { test } from "node:test";
import { isPublicAccession, mapRegistryRow, payloadHash, splitTags, type RegistryRow } from "../src/sync/labRegistry.ts";

const base: RegistryRow = {
  id: "x",
  study_name: "Study",
  accession: null,
  subset: null,
  paper_url: null,
  location: "/mnt/isilon/wang_lab/shared/datasets/x",
  tags: null,
  samples: null,
  status_line: "ok",
  verified: 1,
  verified_how: "checked",
  usage: "use it",
  size_bytes: null,
  n_files: null,
  md5_checked: 0,
  pair_of: null,
  role: null,
  ref_genome: null,
  benchmark_valid: null,
  benchmark_note: null,
  provenance: null,
  notes: null,
  added_by: "novamod",
  updated_by: "novamod",
  created: "2026-10-01T00:00:00",
  updated: "2026-10-02T00:00:00",
};

// Rows shaped like real entries of ~/lab/datasets.db.
const bidseq: RegistryRow = {
  ...base,
  id: "bidseq-pseu-gse179798",
  study_name: "BID-seq pseudouridine HEK293T/HeLa",
  accession: "GSE179798",
  tags: "pseudouridine pseU BID-seq bisulfite deletion Illumina ground-truth label HEK293T HeLa unfiltered",
  ref_genome: "GRCh38_noalts",
  md5_checked: 1,
  size_bytes: 5 * 1024 ** 3,
  n_files: 12,
};

test("public GEO accession from an external study maps to external-public sequencing", () => {
  const p = mapRegistryRow(bidseq);
  assert.equal(p.external_accession, "GSE179798");
  assert.equal(p.source_type, "external-public");
  assert.equal(p.dataset_type, "sequencing");
  assert.equal(p.assay_platform, "Illumina");
  assert.equal(p.organism, "Homo sapiens");
  assert.equal(p.status, "validated");
  assert.equal(p.access_level, "open-lab");
  assert.equal(p.storage_uri, bidseq.location);
  assert.match(p.qc_summary ?? "", /Checksums verified\. Size: 12 files, 5\.0 GB\./);
  assert.match(p.notes ?? "", /lab dataset registry \(id: bidseq-pseu-gse179798\)/);
  assert.match(p.notes ?? "", /Reference: GRCh38_noalts/);
  assert.equal(p.tags.at(-1), "lab-registry");
});

test("non-accession registry strings go to notes, not external_accession", () => {
  const p = mapRegistryRow({
    ...base,
    id: "ont-all5mer-rnamod-2026-07",
    accession: "ont-open-data:rna-mod-validation-all5mer-2026.07",
    tags: "RNA004 DRS synthetic all-5mer m6A m5C pseU inosine",
  });
  assert.equal(p.external_accession, null);
  assert.match(p.notes ?? "", /Registry accession field: ont-open-data:rna-mod-validation-all5mer-2026\.07/);
  assert.equal(p.assay_platform, "ONT direct RNA (RNA004)");
  assert.equal(p.dataset_type, "sequencing");
});

test("derived outputs built on a public accession count as internal-generated", () => {
  const p = mapRegistryRow({
    ...base,
    id: "v3-h9-transcriptome-fixed",
    accession: "GSE133361",
    subset: "H9 transcriptome, v3 FIXED",
    tags: "poreior-v3 CH1 CH2 DRS RNA002 ONT-FM blackout-fixed",
  });
  assert.equal(p.external_accession, "GSE133361");
  assert.equal(p.source_type, "internal-generated");
  assert.equal(p.name, "Study — H9 transcriptome, v3 FIXED");
  assert.equal(p.assay_platform, "ONT direct RNA (RNA002)");
  assert.equal(p.organism, "Homo sapiens");
});

test("NOT-nanopore tag suppresses the nanopore platform guess", () => {
  const p = mapRegistryRow({
    ...base,
    accession: "GSE210563",
    tags: "m6A GLORI Illumina A-to-G ground-truth HEK293T HeLa unfiltered NOT-nanopore",
  });
  assert.equal(p.assay_platform, "Illumina");
});

test("in-house wet-lab runs are internal-generated; unverified raw is raw-available", () => {
  const p = mapRegistryRow({
    ...base,
    id: "inhouse-rna004-native-ivt-pairs",
    verified: 0,
    tags: "RNA004 DRS in-house native IVT HEK293T HeLa pod5",
  });
  assert.equal(p.source_type, "internal-generated");
  assert.equal(p.status, "raw-available");
  assert.match(p.qc_summary ?? "", /Not yet verified/);
});

test("model checkpoints without assay tokens map to type other, no organism", () => {
  const p = mapRegistryRow({
    ...base,
    id: "morpheus-invivo-backbone",
    location: "/scr1/users/zouy1/claude_tmp/ft_models/invivo_hybrid_real.pt",
    tags: "morpheus backbone icSHAPE RibonanzaNet JEPA in-vivo",
  });
  assert.equal(p.dataset_type, "other");
  assert.equal(p.organism, null);
  assert.equal(p.assay_platform, null);
});

test("deprecated / superseded status lines win over verified", () => {
  assert.equal(mapRegistryRow({ ...base, status_line: "SUPERSEDED by v4 — do not use" }).status, "deprecated");
});

test("PDB ids count as public accessions; comma-separated tags split", () => {
  const p = mapRegistryRow({
    ...base,
    accession: "8QOI",
    tags: "rRNA,18S,28S,5.8S,gold,structure,Nm,m6A,pseudouridine,human,B2-spike",
  });
  assert.equal(p.external_accession, "8QOI");
  assert.deepEqual(p.tags.slice(0, 3), ["rRNA", "18S", "28S"]);
  assert.equal(p.dataset_type, "annotation");
});

test("splitTags dedupes case-insensitively and keeps first spelling", () => {
  assert.deepEqual(splitTags("DRS drs RNA004, rna004  m6A"), ["DRS", "RNA004", "m6A"]);
});

test("isPublicAccession", () => {
  for (const ok of ["GSE1", "PRJNA1036687", "SRR9878470-475 (cell-free)", "E-MTAB-123", "8QOI"]) assert.ok(isPublicAccession(ok), ok);
  for (const bad of [null, "", "morpheus-internal", "derived-from-v4", "rasp2.zhanglab.net", "s41422-021-00476-y"])
    assert.ok(!isPublicAccession(bad), String(bad));
});

test("payload hash is stable and sensitive to content", () => {
  const a = mapRegistryRow(bidseq);
  const b = JSON.parse(JSON.stringify(a));
  assert.equal(payloadHash(a), payloadHash(b));
  assert.notEqual(payloadHash(a), payloadHash(mapRegistryRow({ ...bidseq, status_line: "changed" })));
});
