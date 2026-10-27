# @ilm/mcp-server — Seine Lab OS for AI agents

An [MCP](https://modelcontextprotocol.io) server (plus a small CLI, `seine`) that lets AI agents — Claude Code,
Claude Desktop, any MCP client — read and edit a lab's Seine data: the supply catalog, stock checks and order
requests, the Data Hub dataset registry, projects and funding aliases.

## How it acts: as you, under the same RLS

The server signs in **as the human user** and talks to Supabase with the public anon key plus that user's
access token — exactly like the web apps. Every read and write therefore goes through the same row-level
security and RPCs as the browser; an agent can never do more than its user can. The `service_role` key is
never used.

- **No password on disk.** `seine login` exchanges your password once for a Supabase session and stores only
  the refreshable session (`~/.config/seine/session.json`, mode 600). `seine logout` revokes just that session;
  your browser stays signed in.
- **Many agents, one session.** Supabase rotates refresh tokens and revokes a session when a spent one is
  replayed, so concurrent agent processes refresh under a shared lock (a lock directory — atomic on NFS) and
  reuse whichever pair the winner wrote.
- **Attribution.** Seine records the human as the author, so the server marks agent writes: free-text fields
  it writes (stock-check notes, order-request reasons, dataset notes) end with `[via agent: <name>]`; every
  write is appended to a JSONL log (default `~/.local/state/seine/writes.jsonl`); and requests carry
  `x-seine-client` / `x-seine-agent` headers for future server-side capture.
- **Conservative surface.** No delete tools. Approving, placing and receiving orders are exposed only when
  `SEINE_MCP_ENABLE_ADMIN_TOOLS=1` (and still require an owner/admin role).

## Setup

```bash
npm install                                   # at the repo root (workspaces)
npm run build -w @ilm/mcp-server              # -> packages/mcp-server/dist/seine.mjs (self-contained)

seine() { node /path/to/packages/mcp-server/dist/seine.mjs "$@"; }
seine config --url https://<project>.supabase.co --anon-key <anon key> --default-lab <lab slug>
seine login --email you@example.org           # prompts for the password (hidden)
seine whoami
```

Register it with Claude Code (user scope = every project):

```bash
claude mcp add seine --scope user -- node /path/to/packages/mcp-server/dist/seine.mjs mcp
```

Optional config (`seine config …` or env):

| setting | env | meaning |
|---|---|---|
| `--default-lab` | `SEINE_DEFAULT_LAB` | lab id/slug/name used when a tool call omits `lab` |
| `--agent-name-cmd` | `SEINE_AGENT_NAME` (literal) | shell command printing the agent's name for attribution |
| `--write-log` | `SEINE_WRITE_LOG` | JSONL audit log of agent writes |
| `--lab-registry-db` | `SEINE_LAB_REGISTRY_DB` | SQLite dataset registry to mirror into Data Hub |
| — | `SEINE_MCP_ENABLE_ADMIN_TOOLS=1` | expose approve / place / receive tools |
| — | `SEINE_CONFIG_DIR` | config + session directory (default `~/.config/seine`) |

## Tools

| tool | kind | what it does |
|---|---|---|
| `seine_whoami` | read | user, agent name, labs + roles, default lab |
| `seine_list_projects` / `seine_list_members` / `seine_list_funding_aliases` | read | lookups |
| `supply_search_items` | read | catalog search, each item with its latest stock check |
| `supply_get_item` | read | one item: stock history, lots, projects, every order request + shipping |
| `supply_low_stock` | read | out/low items, annotated with open requests already covering them |
| `supply_list_requests` | read | order-request pipeline with lines, review and order status |
| `supply_create_item` | write | add a catalog item (refuses duplicates), optional initial stock check |
| `supply_update_item` | write | patch catalog fields |
| `supply_record_stock_check` | write | append a stock check |
| `supply_request_order` | write | draft → submit an order request (refuses if an open request covers the item) |
| `supply_withdraw_request` | write | withdraw your undecided request |
| `supply_review_request` / `supply_place_order` / `supply_receive_order` | admin | owner/admin actions, opt-in |
| `datahub_search_datasets` / `datahub_get_dataset` | read | Data Hub search and full record |
| `datahub_create_dataset` / `datahub_update_dataset` / `datahub_add_version` | write | register / patch / version datasets |
| `datahub_sync_lab_registry` | write | mirror an external lab registry into Data Hub (dry run by default) |

`update_dataset` in the database replaces tags, project links and the primary storage link wholesale; the
`datahub_update_dataset` tool loads the current record and merges your patch so nothing is dropped.

The same tools run from the shell: `seine tools`, `seine call supply_low_stock '{}'`.

## Syncing a lab's own dataset registry

Some labs already keep a dataset registry outside Seine (the Wang lab's `lab data` SQLite registry is the
reference adapter, `src/sync/labRegistry.ts`). `seine sync-lab-datasets` mirrors it into Data Hub:

- one registry row → one dataset, keyed in the `integration_links` table
  (`supabase/migrations/20261027000000_integration_links.sql`), so re-syncs update instead of duplicating;
- unchanged rows are skipped (payload hash); datasets edited in Seine since the last sync are reported as
  conflicts and left alone unless `--force`; Seine-side project links and extra tags are preserved;
- rows that vanished from the registry are reported as `orphaned`, never deleted;
- dry run unless `--apply`.

## Development

```bash
npm run typecheck -w @ilm/mcp-server
npm test -w @ilm/mcp-server          # node --test on the TS sources (Node >= 22.18 strips types)
npm run build -w @ilm/mcp-server
```

Sources use `.ts` import specifiers and erasable-only TypeScript so Node can run tests without a build step.
