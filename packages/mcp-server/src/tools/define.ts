import { z } from "zod";
import type { SeineContext } from "../context.ts";

// One definition drives both the MCP server and the `seine call` CLI.
//   read  — never changes Seine data
//   write — member-level, additive edits (attributed to the agent)
//   admin — needs an owner/admin role AND SEINE_MCP_ENABLE_ADMIN_TOOLS=1
export type ToolKind = "read" | "write" | "admin";

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
  input: S;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: SeineContext) => Promise<unknown>;
}

export const defineTool = <S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> => def;

export const labArg = z
  .string()
  .optional()
  .describe("Lab id, slug or name. Omit to use your default lab.");

// Turn PostgREST / Postgres errors into messages an agent can act on.
export const describeError = (err: unknown): string => {
  if (err && typeof err === "object" && "message" in err) {
    const e = err as { code?: string; message: string; details?: string | null; hint?: string | null };
    const parts = [e.message];
    if (e.details) parts.push(`details: ${e.details}`);
    if (e.hint) parts.push(`hint: ${e.hint}`);
    if (e.code === "42501") {
      parts.push(
        "→ Seine's row-level security refused this for your account. Your lab role may not allow it " +
          "(approvals, ordering and receiving are owner/admin actions); ask a lab admin."
      );
    } else if (e.code === "PGRST116") {
      parts.push("→ No matching row is visible to your account (it may not exist, or you lack access).");
    } else if (e.code === "23514") {
      parts.push("→ A value is outside the allowed set for that column.");
    }
    return parts.join(" | ");
  }
  return String(err);
};

// Free-text search over several columns: every word must match at least one
// column (AND of ORs), case-insensitive substring. Values are double-quoted so
// commas/parentheses in user input can't break PostgREST's filter grammar.
export const searchWords = (text: string): string[] =>
  text
    .split(/\s+/)
    .map((w) => w.replace(/["\\,()%*]/g, "").trim())
    .filter((w) => w.length > 0)
    .slice(0, 8);

export const orIlikeClause = (columns: string[], word: string): string =>
  columns.map((c) => `${c}.ilike."%${word}%"`).join(",");

// Applies searchWords/orIlikeClause to a PostgREST filter builder.
export const applyTextSearch = <Q extends { or: (filters: string) => Q }>(
  query: Q,
  columns: string[],
  text: string | undefined
): Q => {
  let q = query;
  for (const word of searchWords(text ?? "")) q = q.or(orIlikeClause(columns, word));
  return q;
};

// "" clears a field, undefined leaves it alone, anything else is trimmed.
export const patchText = (value: string | undefined): string | null | undefined =>
  value === undefined ? undefined : value.trim() === "" ? null : value.trim();

export const cleanText = (value: string | null | undefined): string | null =>
  value === undefined || value === null || value.trim() === "" ? null : value.trim();

export const first = <T>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
