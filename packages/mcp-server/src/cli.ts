import readline from "node:readline";
import { parseArgs } from "node:util";
import { loadConfig, requireProject, writeFileConfig, type FileConfig } from "./config.ts";
import { SeineContext } from "./context.ts";
import { ALL_TOOLS, enabledTools, runTool, startMcpServer } from "./server.ts";
import { logout, passwordLogin, readSession } from "./session.ts";
import { describeError } from "./tools/define.ts";
import { syncLabRegistry } from "./sync/syncDatasets.ts";
import { VERSION } from "./version.ts";

const USAGE = `seine ${VERSION} — Seine Lab OS for agents (MCP server + CLI)

  seine mcp                         Run the MCP server on stdio (what Claude Code launches)
  seine login [--email E]           Sign in as yourself; stores a refreshable session, never the password
  seine logout                      Revoke this machine's session
  seine whoami                      Show the signed-in user and lab roles
  seine config [--url U] [--anon-key K] [--default-lab L] [--write-log P]
               [--agent-name-cmd C] [--lab-registry-db P]
                                    Set config (no flags: print it). "" clears a value
  seine tools                       List the tools this server exposes
  seine call <tool> ['<json args>'] Run one tool and print its JSON result
  seine sync-lab-datasets [--lab L] [--only id,id] [--apply] [--force] [--access-level A]
                                    Mirror the lab dataset registry into Data Hub (dry run unless --apply)

Config: ~/.config/seine/config.json (or $SEINE_CONFIG_DIR). Env overrides: SEINE_SUPABASE_URL,
SEINE_SUPABASE_ANON_KEY, SEINE_DEFAULT_LAB, SEINE_AGENT_NAME, SEINE_WRITE_LOG,
SEINE_MCP_ENABLE_ADMIN_TOOLS=1 (expose approve/place/receive tools).`;

const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(question, (answer) => (rl.close(), resolve(answer.trim()))));
}

async function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // Piped: take the first line of stdin.
    let buf = "";
    for await (const chunk of process.stdin) buf += chunk;
    return buf.split(/\r?\n/)[0] ?? "";
  }
  process.stderr.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (c === "\u0003") {
          stdin.setRawMode(false);
          process.stderr.write("\n");
          process.exit(130);
        }
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on("data", onData);
  });
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "mcp": {
      await startMcpServer(loadConfig());
      return -1; // keep running; stdio transport owns the process
    }

    case "login": {
      const { values } = parseArgs({
        args: rest,
        options: { email: { type: "string" }, url: { type: "string" }, "anon-key": { type: "string" } },
      });
      const cfgPath = loadConfig().configPath;
      if (values.url || values["anon-key"]) writeFileConfig(cfgPath, { supabaseUrl: values.url, anonKey: values["anon-key"] });
      const cfg = loadConfig();
      requireProject(cfg);
      const email = values.email || process.env.SEINE_EMAIL || (await ask("Seine email: "));
      const password = process.env.SEINE_PASSWORD || (await askHidden(`Password for ${email}: `));
      if (!email || !password) throw new Error("Email and password are required.");
      const session = await passwordLogin({
        supabaseUrl: cfg.supabaseUrl,
        anonKey: cfg.anonKey,
        sessionPath: cfg.sessionPath,
        email,
        password,
      });
      const ctx = new SeineContext(cfg);
      const labs = await ctx.labs();
      process.stderr.write(
        `Signed in as ${session.user.email}. Session saved to ${cfg.sessionPath} (mode 600; the password was not stored).\n` +
          `Labs: ${labs.map((l) => `${l.name} [${l.slug ?? "-"}] (${l.role})`).join("; ") || "(none)"}\n`
      );
      return 0;
    }

    case "logout": {
      const cfg = loadConfig();
      requireProject(cfg);
      const had = await logout({ supabaseUrl: cfg.supabaseUrl, anonKey: cfg.anonKey, sessionPath: cfg.sessionPath });
      process.stderr.write(had ? "Signed out; this machine's Seine session was revoked.\n" : "No session was stored.\n");
      return 0;
    }

    case "whoami": {
      const ctx = new SeineContext(loadConfig());
      print(await runTool(ALL_TOOLS.find((t) => t.name === "seine_whoami")!, {}, ctx));
      return 0;
    }

    case "config": {
      const { values } = parseArgs({
        args: rest,
        options: {
          url: { type: "string" },
          "anon-key": { type: "string" },
          "default-lab": { type: "string" },
          "write-log": { type: "string" },
          "agent-name-cmd": { type: "string" },
          "lab-registry-db": { type: "string" },
        },
      });
      const patch: FileConfig = {
        supabaseUrl: values.url,
        anonKey: values["anon-key"],
        defaultLab: values["default-lab"],
        writeLog: values["write-log"],
        agentNameCommand: values["agent-name-cmd"],
        labRegistryDb: values["lab-registry-db"],
      };
      const cfg = loadConfig();
      if (Object.values(patch).some((v) => v !== undefined)) writeFileConfig(cfg.configPath, patch);
      const now = loadConfig();
      const session = readSession(now.sessionPath);
      print({
        config_file: now.configPath,
        supabase_url: now.supabaseUrl || null,
        anon_key: now.anonKey ? `${now.anonKey.slice(0, 12)}…` : null,
        default_lab: now.defaultLab,
        write_log: now.writeLogPath,
        agent_name_command: now.agentNameCommand,
        lab_registry_db: now.labRegistryDb,
        admin_tools_enabled: now.enableAdminTools,
        session: session ? { user: session.user.email, expires_at: new Date(session.expires_at * 1000).toISOString() } : null,
      });
      return 0;
    }

    case "tools": {
      const cfg = loadConfig();
      const on = new Set(enabledTools(cfg).map((t) => t.name));
      for (const t of ALL_TOOLS) {
        process.stdout.write(`${on.has(t.name) ? " " : "-"} ${t.name.padEnd(28)} [${t.kind}] ${t.title}\n`);
      }
      process.stdout.write("\n(- = disabled: admin tools need SEINE_MCP_ENABLE_ADMIN_TOOLS=1; sync needs a lab registry)\n");
      return 0;
    }

    case "call": {
      const [name, json] = rest;
      const cfg = loadConfig();
      const tool = enabledTools(cfg).find((t) => t.name === name);
      if (!tool) throw new Error(`Unknown or disabled tool "${name}". See \`seine tools\`.`);
      print(await runTool(tool, json ? JSON.parse(json) : {}, new SeineContext(cfg)));
      return 0;
    }

    case "sync-lab-datasets": {
      const { values } = parseArgs({
        args: rest,
        options: {
          lab: { type: "string" },
          only: { type: "string" },
          apply: { type: "boolean" },
          force: { type: "boolean" },
          "access-level": { type: "string" },
        },
      });
      const result = await syncLabRegistry(new SeineContext(loadConfig()), {
        lab: values.lab,
        ids: values.only ? values.only.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        apply: values.apply,
        force: values.force,
        accessLevel: values["access-level"] as never,
      });
      print(result);
      if (!values.apply) process.stderr.write("(dry run — pass --apply to write)\n");
      return result.counts.error ? 1 : 0;
    }

    case undefined:
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(USAGE + "\n");
      return 0;

    case "--version":
    case "version":
      process.stdout.write(VERSION + "\n");
      return 0;

    default:
      process.stderr.write(`Unknown command "${cmd}".\n\n${USAGE}\n`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (err) => {
    process.stderr.write(`seine: ${describeError(err)}\n`);
    process.exit(1);
  }
);
