import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The signed-in user's Supabase Auth session, shared by every agent process.
//
// Many agent sessions run this server at once, all as the same user. Supabase
// rotates refresh tokens on every refresh and revokes the whole session if a
// spent refresh token is replayed, so refreshes MUST be serialized: whoever
// holds the lock refreshes and writes the new pair back; everyone else re-reads
// the file and reuses it. The lock is a directory (mkdir is atomic on NFS,
// unlike flock on some mounts), with stale-lock takeover.

export interface StoredSession {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
  token_type?: string;
  user: { id: string; email: string | null };
  supabase_url: string;
  obtained_via?: string;
  updated_at?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class NotLoggedInError extends Error {
  constructor(message = "Not signed in to Seine. Ask the user to run `seine login` in a terminal.") {
    super(message);
    this.name = "NotLoggedInError";
  }
}

const REFRESH_MARGIN_S = 90;
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 20_000;

const nowS = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const readSession = (sessionPath: string): StoredSession | null => {
  try {
    return JSON.parse(fs.readFileSync(sessionPath, "utf8")) as StoredSession;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Could not read ${sessionPath}: ${(err as Error).message}`);
  }
};

export const writeSession = (sessionPath: string, session: StoredSession): void => {
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true, mode: 0o700 });
  const tmp = `${sessionPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...session, updated_at: new Date().toISOString() }, null, 2), {
    mode: 0o600,
  });
  fs.renameSync(tmp, sessionPath);
};

export const removeSession = (sessionPath: string): void => {
  fs.rmSync(sessionPath, { force: true });
};

export async function withSessionLock<T>(sessionPath: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = `${sessionPath}.lock`;
  const started = Date.now();
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const age = Date.now() - fs.statSync(lockDir).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between mkdir and stat; retry immediately
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for the Seine session lock (${lockDir}).`);
      }
      await sleep(50 + Math.random() * 100);
    }
  }
  try {
    fs.writeFileSync(path.join(lockDir, "owner"), `${os.hostname()} ${process.pid}\n`);
    return await fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  expires_at?: number;
  token_type?: string;
  user?: { id: string; email?: string | null };
}

async function tokenRequest(
  fetchImpl: FetchLike,
  supabaseUrl: string,
  anonKey: string,
  grant: "password" | "refresh_token",
  body: Record<string, string>
): Promise<TokenResponse> {
  const res = await fetchImpl(`${supabaseUrl}/auth/v1/token?grant_type=${grant}`, {
    method: "POST",
    headers: { apikey: anonKey, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // non-JSON error body; fall through with the raw text
  }
  if (!res.ok) {
    const msg = (json.error_description || json.msg || json.message || text || res.statusText) as string;
    if (grant === "refresh_token" && (res.status === 400 || res.status === 401)) {
      throw new NotLoggedInError(
        `The stored Seine session is no longer valid (${msg}). Ask the user to run \`seine login\` again.`
      );
    }
    throw new Error(`Seine sign-in failed (${res.status}): ${msg}`);
  }
  return json as unknown as TokenResponse;
}

const toStored = (tok: TokenResponse, supabaseUrl: string, via: string, prevUser?: StoredSession["user"]): StoredSession => ({
  access_token: tok.access_token,
  refresh_token: tok.refresh_token,
  expires_at: tok.expires_at ?? nowS() + (tok.expires_in ?? 3600),
  token_type: tok.token_type,
  user: tok.user ? { id: tok.user.id, email: tok.user.email ?? null } : (prevUser as StoredSession["user"]),
  supabase_url: supabaseUrl,
  obtained_via: via,
});

export async function passwordLogin(opts: {
  supabaseUrl: string;
  anonKey: string;
  sessionPath: string;
  email: string;
  password: string;
  fetchImpl?: FetchLike;
}): Promise<StoredSession> {
  const tok = await tokenRequest(opts.fetchImpl ?? fetch, opts.supabaseUrl, opts.anonKey, "password", {
    email: opts.email,
    password: opts.password,
  });
  const session = toStored(tok, opts.supabaseUrl, "password");
  await withSessionLock(opts.sessionPath, async () => writeSession(opts.sessionPath, session));
  return session;
}

export async function logout(opts: {
  supabaseUrl: string;
  anonKey: string;
  sessionPath: string;
  fetchImpl?: FetchLike;
}): Promise<boolean> {
  const session = readSession(opts.sessionPath);
  if (!session) return false;
  try {
    // scope=local revokes only this session's refresh token, so the user's
    // browser sessions stay signed in.
    await (opts.fetchImpl ?? fetch)(`${opts.supabaseUrl}/auth/v1/logout?scope=local`, {
      method: "POST",
      headers: { apikey: opts.anonKey, authorization: `Bearer ${session.access_token}` },
    });
  } finally {
    removeSession(opts.sessionPath);
  }
  return true;
}

// Hands out a valid access token, refreshing (under the shared lock) when the
// cached one is within REFRESH_MARGIN_S of expiry.
export interface SessionManagerOptions {
  supabaseUrl: string;
  anonKey: string;
  sessionPath: string;
  fetchImpl?: FetchLike;
}

export class SessionManager {
  private cached: StoredSession | null = null;
  private readonly opts: SessionManagerOptions;

  constructor(opts: SessionManagerOptions) {
    this.opts = opts;
  }

  private fresh(s: StoredSession): boolean {
    return s.expires_at - nowS() > REFRESH_MARGIN_S;
  }

  current(): StoredSession {
    const s = this.cached ?? readSession(this.opts.sessionPath);
    if (!s) throw new NotLoggedInError();
    if (s.supabase_url && s.supabase_url !== this.opts.supabaseUrl) {
      throw new NotLoggedInError(
        `The stored session belongs to ${s.supabase_url}, not ${this.opts.supabaseUrl}. Run \`seine login\`.`
      );
    }
    this.cached = s;
    return s;
  }

  user(): StoredSession["user"] {
    return this.current().user;
  }

  async accessToken(): Promise<string> {
    if (this.cached && this.fresh(this.cached)) return this.cached.access_token;
    const onDisk = readSession(this.opts.sessionPath);
    if (!onDisk) throw new NotLoggedInError();
    if (this.fresh(onDisk)) {
      this.cached = onDisk;
      return onDisk.access_token;
    }
    const { sessionPath, supabaseUrl, anonKey } = this.opts;
    const refreshed = await withSessionLock(sessionPath, async () => {
      // Another process may have refreshed while we waited for the lock.
      const latest = readSession(sessionPath);
      if (!latest) throw new NotLoggedInError();
      if (this.fresh(latest)) return latest;
      const tok = await tokenRequest(this.opts.fetchImpl ?? fetch, supabaseUrl, anonKey, "refresh_token", {
        refresh_token: latest.refresh_token,
      });
      const next = toStored(tok, supabaseUrl, latest.obtained_via ?? "refresh", latest.user);
      writeSession(sessionPath, next);
      return next;
    });
    this.cached = refreshed;
    return refreshed.access_token;
  }
}
