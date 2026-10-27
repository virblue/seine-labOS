import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Runtime configuration for the Seine MCP server / CLI.
//
// Precedence: environment variables > ${configDir}/config.json > defaults.
// Only PUBLIC values live here (project URL + anon key). The user's session
// (refresh token) is stored separately in session.json with 0600 perms, and
// no password is ever written to disk. The service-role key is never used.

export interface FileConfig {
  supabaseUrl?: string;
  anonKey?: string;
  defaultLab?: string;
  writeLog?: string;
  agentNameCommand?: string;
  labRegistryDb?: string;
}

export interface SeineConfig {
  supabaseUrl: string;
  anonKey: string;
  defaultLab: string | null;
  configDir: string;
  configPath: string;
  sessionPath: string;
  writeLogPath: string;
  agentName: string | null;
  agentNameCommand: string | null;
  labRegistryDb: string | null;
  enableAdminTools: boolean;
}

const truthy = (value: string | undefined): boolean =>
  value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());

const expandHome = (p: string): string =>
  p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;

export const defaultConfigDir = (): string =>
  expandHome(
    process.env.SEINE_CONFIG_DIR ||
      path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "seine")
  );

export const readFileConfig = (configPath: string): FileConfig => {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as FileConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Could not parse ${configPath}: ${(err as Error).message}`);
  }
};

export const writeFileConfig = (configPath: string, patch: FileConfig): FileConfig => {
  const merged: FileConfig = { ...readFileConfig(configPath) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === "") delete (merged as Record<string, unknown>)[key];
    else (merged as Record<string, unknown>)[key] = value;
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  return merged;
};

export const loadConfig = (): SeineConfig => {
  const configDir = defaultConfigDir();
  const configPath = path.join(configDir, "config.json");
  const file = readFileConfig(configPath);
  const env = process.env;

  const registryDefault = path.join(expandHome(env.LAB_HOME || "~/lab"), "datasets.db");
  const registry = env.SEINE_LAB_REGISTRY_DB || file.labRegistryDb || null;

  return {
    supabaseUrl: (env.SEINE_SUPABASE_URL || file.supabaseUrl || "").replace(/\/+$/, ""),
    anonKey: env.SEINE_SUPABASE_ANON_KEY || file.anonKey || "",
    defaultLab: env.SEINE_DEFAULT_LAB || file.defaultLab || null,
    configDir,
    configPath,
    sessionPath: path.join(configDir, "session.json"),
    writeLogPath: expandHome(
      env.SEINE_WRITE_LOG || file.writeLog || path.join(os.homedir(), ".local", "state", "seine", "writes.jsonl")
    ),
    agentName: env.SEINE_AGENT_NAME || null,
    agentNameCommand: env.SEINE_AGENT_NAME_CMD || file.agentNameCommand || null,
    labRegistryDb: registry
      ? expandHome(registry)
      : fs.existsSync(registryDefault)
        ? registryDefault
        : null,
    enableAdminTools: truthy(env.SEINE_MCP_ENABLE_ADMIN_TOOLS),
  };
};

export const requireProject = (cfg: SeineConfig): void => {
  if (!cfg.supabaseUrl || !cfg.anonKey) {
    throw new Error(
      "Seine is not configured. Run `seine config --url <SUPABASE_URL> --anon-key <ANON_KEY>` " +
        "(or set SEINE_SUPABASE_URL / SEINE_SUPABASE_ANON_KEY)."
    );
  }
};
