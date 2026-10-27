import { z } from "zod";
import { defineTool, labArg } from "./define.ts";

export const whoami = defineTool({
  name: "seine_whoami",
  title: "Who am I in Seine",
  kind: "read",
  description:
    "The Seine user these tools act as, the agent name attached to writes, every lab the user belongs to with " +
    "their role (owner/admin/member — this decides what writes Seine allows), and the default lab. Call this " +
    "first if unsure which lab to use.",
  input: {},
  handler: async (_args, ctx) => {
    const labs = await ctx.labs();
    let defaultLab: string | null = null;
    try {
      defaultLab = (await ctx.lab()).name;
    } catch {
      defaultLab = null;
    }
    return {
      user: ctx.session.user(),
      agent: await ctx.agentName,
      seine_project: ctx.cfg.supabaseUrl,
      labs: labs.map((l) => ({ name: l.name, slug: l.slug, id: l.id, role: l.role })),
      default_lab: defaultLab,
      admin_tools_enabled: ctx.cfg.enableAdminTools,
      lab_registry: ctx.cfg.labRegistryDb,
      write_log: ctx.cfg.writeLogPath,
    };
  },
});

export const listProjects = defineTool({
  name: "seine_list_projects",
  title: "List projects",
  kind: "read",
  description: "Projects in the lab that you can see (for attributing order requests or linking datasets).",
  input: { lab: labArg },
  handler: async (args, ctx) => {
    const lab = await ctx.lab(args.lab);
    return { lab: lab.name, projects: await ctx.projects(lab.id) };
  },
});

export const listMembers = defineTool({
  name: "seine_list_members",
  title: "List lab members",
  kind: "read",
  description: "Lab members and their roles (owners/admins are the people who approve order requests).",
  input: { lab: labArg },
  handler: async (args, ctx) => {
    const lab = await ctx.lab(args.lab);
    const members = await ctx.members(lab.id);
    return {
      lab: lab.name,
      members: members.map((m) => ({ name: m.display_name || m.email, role: m.role, user_id: m.user_id })),
    };
  },
});

export const listFunding = defineTool({
  name: "seine_list_funding_aliases",
  title: "List funding aliases",
  kind: "read",
  description:
    "The lab's grant aliases used to route order approvals. Members see only lab-visible aliases; grant numbers " +
    "are shown to owners/admins only. (Seine tracks no budgets or balances.)",
  input: { lab: labArg, include_archived: z.boolean().optional() },
  handler: async (args, ctx) => {
    const lab = await ctx.lab(args.lab);
    const { data, error } = await ctx.sb.rpc("list_funding_sources", { p_lab_id: lab.id });
    if (error) throw error;
    const rows = ((data ?? []) as any[]).filter((r) => args.include_archived || !r.archived_at);
    return {
      lab: lab.name,
      aliases: rows.map((r) => ({
        id: r.id,
        nickname: r.nickname,
        grant_identifier: r.grant_identifier ?? undefined,
        valid: [r.valid_start_date, r.valid_end_date],
        note: r.brief_note,
        visibility: r.visibility,
        ...(r.archived_at ? { archived_at: r.archived_at } : {}),
      })),
    };
  },
});

export const coreTools = [whoami, listProjects, listMembers, listFunding];
