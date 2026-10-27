import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { SeineConfig } from "./config.ts";
import { SeineContext } from "./context.ts";
import { coreTools } from "./tools/core.ts";
import { datahubTools } from "./tools/datahub.ts";
import { describeError, type ToolDef } from "./tools/define.ts";
import { supplyTools } from "./tools/supply.ts";
import { VERSION } from "./version.ts";

export const ALL_TOOLS: ToolDef<any>[] = [...coreTools, ...supplyTools, ...datahubTools];

export const enabledTools = (cfg: SeineConfig): ToolDef<any>[] =>
  ALL_TOOLS.filter(
    (t) =>
      (t.kind !== "admin" || cfg.enableAdminTools) &&
      (t.name !== "datahub_sync_lab_registry" || cfg.labRegistryDb !== null)
  );

const DESTRUCTIVE = /update|withdraw|review|sync|receive|place/;

export const INSTRUCTIONS = `Seine Lab OS is the lab's operations database: supply catalog, stock checks and order requests; the Data Hub dataset registry; projects; funding aliases.

These tools act AS the signed-in human user, with exactly their web-app permissions (Seine enforces row-level security). Every write is tagged with your agent name and logged, but Seine itself records the human as the author — so act only on what the user asked for.

- Read before writing: search the catalog before adding items; check supply_low_stock / supply_list_requests before filing an order (supply_request_order refuses duplicates unless told otherwise).
- When recording stock, say in the note who observed it and how.
- Approving, placing and receiving orders are owner/admin decisions for humans; those tools only exist when explicitly enabled.
- Data Hub stores dataset metadata and locations, never files. For datasets already in the lab's own registry (\`lab data\`), use datahub_sync_lab_registry rather than creating them by hand.`;

export const runTool = async (tool: ToolDef<any>, rawArgs: unknown, ctx: SeineContext): Promise<unknown> =>
  tool.handler(z.object(tool.input).parse(rawArgs ?? {}), ctx);

export async function startMcpServer(cfg: SeineConfig): Promise<void> {
  const server = new McpServer({ name: "seine", version: VERSION }, { instructions: INSTRUCTIONS });
  // Created on first use so the server still starts (and explains itself)
  // when Seine isn't configured or the user hasn't logged in yet.
  let ctx: SeineContext | null = null;
  const getCtx = () => (ctx ??= new SeineContext(cfg));

  for (const tool of enabledTools(cfg)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.kind === "read",
          destructiveHint: tool.kind !== "read" && DESTRUCTIVE.test(tool.name),
          idempotentHint: tool.kind === "read",
          openWorldHint: false,
        },
      },
      async (args: unknown) => {
        try {
          const result = await tool.handler(args as never, getCtx());
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text" as const, text: describeError(err) }] };
        }
      }
    );
  }

  await server.connect(new StdioServerTransport());
}
