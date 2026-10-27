import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireProject, type SeineConfig } from "./config.ts";
import { SessionManager } from "./session.ts";
import { VERSION } from "./version.ts";

export interface LabRef {
  id: string;
  name: string;
  slug: string | null;
  role: "owner" | "admin" | "member";
}

export interface Member {
  user_id: string;
  role: string;
  display_name: string | null;
  email: string | null;
}

export interface ProjectRef {
  id: string;
  name: string;
  status: string | null;
  state: string | null;
}

const resolveAgentName = (cfg: SeineConfig): Promise<string> => {
  if (cfg.agentName) return Promise.resolve(cfg.agentName);
  const fallback = `${process.env.USER || "user"}-agent`;
  if (!cfg.agentNameCommand) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", cfg.agentNameCommand as string], { timeout: 10_000 }, (err, stdout) => {
      const name = String(stdout || "").trim().split("\n")[0]?.trim();
      resolve(!err && name ? name : fallback);
    });
  });
};

class TtlCache<V> {
  private store = new Map<string, { at: number; value: V }>();
  private readonly ttlMs: number;
  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }
  async get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.store.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const value = await load();
    this.store.set(key, { at: Date.now(), value });
    return value;
  }
  clear(): void {
    this.store.clear();
  }
}

// Everything a tool handler needs: an RLS-scoped client acting as the signed-in
// user, who that user is, which agent is driving, and cached lab lookups.
export class SeineContext {
  readonly cfg: SeineConfig;
  readonly session: SessionManager;
  readonly sb: SupabaseClient;
  readonly agentName: Promise<string>;
  private labsCache = new TtlCache<LabRef[]>(60_000);
  private membersCache = new TtlCache<Member[]>(300_000);
  private projectsCache = new TtlCache<ProjectRef[]>(60_000);

  constructor(cfg: SeineConfig) {
    requireProject(cfg);
    this.cfg = cfg;
    this.session = new SessionManager({
      supabaseUrl: cfg.supabaseUrl,
      anonKey: cfg.anonKey,
      sessionPath: cfg.sessionPath,
    });
    // Fail fast (and quietly) before supabase-js asks for a token it can't get.
    this.session.current();
    this.agentName = resolveAgentName(cfg);
    const agentName = this.agentName;
    this.sb = createClient(cfg.supabaseUrl, cfg.anonKey, {
      // We own the token lifecycle (see session.ts); supabase-js just asks.
      accessToken: () => this.session.accessToken(),
      global: {
        fetch: async (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("x-seine-client", `seine-mcp/${VERSION}`);
          headers.set("x-seine-agent", await agentName);
          return fetch(input, { ...init, headers });
        },
      },
    });
  }

  get userId(): string {
    return this.session.user().id;
  }

  async labs(): Promise<LabRef[]> {
    return this.labsCache.get(this.userId, async () => {
      const { data, error } = await this.sb
        .from("lab_memberships")
        .select("role, labs(id, name, slug)")
        .eq("user_id", this.userId);
      if (error) throw error;
      return (data ?? [])
        .map((row: any) => {
          const lab = Array.isArray(row.labs) ? row.labs[0] : row.labs;
          return lab ? { id: lab.id, name: lab.name, slug: lab.slug ?? null, role: row.role } : null;
        })
        .filter((x: LabRef | null): x is LabRef => x !== null)
        .sort((a: LabRef, b: LabRef) => a.name.localeCompare(b.name));
    });
  }

  // Resolve a lab by id, slug or name; fall back to the configured default, or
  // to the only lab when the user belongs to exactly one.
  async lab(ref?: string | null): Promise<LabRef> {
    const labs = await this.labs();
    if (labs.length === 0) throw new Error("This Seine account is not a member of any lab.");
    const want = (ref ?? this.cfg.defaultLab ?? "").trim().toLowerCase();
    if (want) {
      const hit = labs.find(
        (l) => l.id === want || (l.slug ?? "").toLowerCase() === want || l.name.toLowerCase() === want
      );
      if (hit) return hit;
      throw new Error(
        `No lab matches "${ref ?? this.cfg.defaultLab}". You belong to: ${labs
          .map((l) => `${l.name} (slug ${l.slug ?? "-"}, ${l.role})`)
          .join("; ")}.`
      );
    }
    if (labs.length === 1) return labs[0];
    throw new Error(
      `You belong to ${labs.length} labs; pass "lab" (id, slug or name) or set a default with ` +
        `\`seine config --default-lab <slug>\`. Labs: ${labs.map((l) => l.slug ?? l.name).join(", ")}.`
    );
  }

  async members(labId: string): Promise<Member[]> {
    return this.membersCache.get(labId, async () => {
      const { data, error } = await this.sb.rpc("list_lab_members", { p_lab_id: labId });
      if (error) throw error;
      return (data ?? []) as Member[];
    });
  }

  async memberName(labId: string, userId: string | null | undefined): Promise<string | null> {
    if (!userId) return null;
    const m = (await this.members(labId)).find((x) => x.user_id === userId);
    return m ? m.display_name || m.email || userId : userId;
  }

  async projects(labId: string): Promise<ProjectRef[]> {
    return this.projectsCache.get(labId, async () => {
      const { data, error } = await this.sb
        .from("projects")
        .select("id, name, status, state")
        .eq("lab_id", labId)
        .is("deleted_at", null)
        .order("name");
      if (error) throw error;
      return (data ?? []) as ProjectRef[];
    });
  }

  async project(labId: string, ref: string): Promise<ProjectRef> {
    const want = ref.trim().toLowerCase();
    const projects = await this.projects(labId);
    const hit =
      projects.find((p) => p.id === want) ??
      projects.find((p) => p.name.toLowerCase() === want) ??
      (() => {
        const partial = projects.filter((p) => p.name.toLowerCase().includes(want));
        return partial.length === 1 ? partial[0] : undefined;
      })();
    if (!hit) {
      throw new Error(
        `No unique project matches "${ref}". Projects: ${projects.map((p) => p.name).join(", ") || "(none)"}.`
      );
    }
    return hit;
  }

  async projectName(labId: string, projectId: string | null | undefined): Promise<string | null> {
    if (!projectId) return null;
    return (await this.projects(labId)).find((p) => p.id === projectId)?.name ?? projectId;
  }

  invalidate(): void {
    this.labsCache.clear();
    this.projectsCache.clear();
  }

  // Every write an agent makes goes to an append-only JSONL log, so the lab can
  // tell agent edits from the human's even though Seine records both as the
  // same user.
  async logWrite(entry: { tool: string; lab_id?: string | null; summary: string; ids?: Record<string, unknown> }) {
    const line = {
      ts: new Date().toISOString(),
      agent: await this.agentName,
      user: this.session.user().email,
      ...entry,
    };
    try {
      fs.mkdirSync(path.dirname(this.cfg.writeLogPath), { recursive: true });
      fs.appendFileSync(this.cfg.writeLogPath, JSON.stringify(line) + "\n");
    } catch (err) {
      process.stderr.write(`seine: could not append to ${this.cfg.writeLogPath}: ${(err as Error).message}\n`);
    }
  }

  // Free-text fields written by an agent carry a visible marker in the Seine UI.
  async tag(text: string | null | undefined): Promise<string> {
    const marker = `[via agent: ${await this.agentName}]`;
    const body = (text ?? "").trim();
    return body ? `${body} ${marker}` : marker;
  }
}
