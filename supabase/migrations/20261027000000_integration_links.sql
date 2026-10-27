-- Integration links
--
-- Stable keys between a Seine record and the same thing in an external system
-- (a lab's own dataset registry, a LIMS, a vendor catalog, ...). Sync jobs and
-- AI agents (packages/mcp-server) use them to UPDATE the record they created
-- last time instead of creating a duplicate, and to skip no-op re-syncs.
--
-- One row = (lab, external system, entity kind, external id) -> Seine record.
-- `source_hash` is the hash of the payload last written, so a sync can tell
-- "unchanged upstream" from "needs update". No existing table or RPC changes.

-- ---------------------------------------------------------------------------
-- 1) Table
-- ---------------------------------------------------------------------------

create table if not exists public.integration_links (
  id uuid primary key default gen_random_uuid(),
  lab_id uuid not null references public.labs(id) on delete cascade,

  system text not null
    check (system ~ '^[a-z0-9][a-z0-9._-]{0,62}$'),
  entity text not null
    check (entity in ('dataset', 'item', 'project', 'protocol')),
  external_id text not null
    check (length(btrim(external_id)) between 1 and 500),
  record_id uuid not null,

  source_hash text,
  last_synced_at timestamptz not null default now(),

  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (lab_id, system, entity, external_id)
);

create index if not exists integration_links_record_idx
  on public.integration_links (lab_id, entity, record_id);

create trigger integration_links_set_updated_at
  before update on public.integration_links
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2) The linked record must exist and belong to the same lab
-- ---------------------------------------------------------------------------

create or replace function public._check_integration_link_target()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lab uuid;
begin
  if new.entity = 'dataset' then
    select lab_id into v_lab from public.datasets where id = new.record_id;
  elsif new.entity = 'item' then
    select lab_id into v_lab from public.items where id = new.record_id;
  elsif new.entity = 'project' then
    select lab_id into v_lab from public.projects where id = new.record_id;
  elsif new.entity = 'protocol' then
    select lab_id into v_lab from public.protocols where id = new.record_id;
  end if;

  if v_lab is null then
    raise exception 'integration link target % % not found', new.entity, new.record_id
      using errcode = '23503';
  end if;
  if v_lab <> new.lab_id then
    raise exception 'integration link target belongs to a different lab'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger integration_links_check_target
  before insert or update of lab_id, entity, record_id on public.integration_links
  for each row execute function public._check_integration_link_target();

-- ---------------------------------------------------------------------------
-- 3) RLS: lab members read; the creator (or an admin) maintains a link
-- ---------------------------------------------------------------------------

alter table public.integration_links enable row level security;

create policy integration_links_select on public.integration_links
  for select to authenticated
  using (public.is_lab_member(lab_id));

create policy integration_links_insert on public.integration_links
  for insert to authenticated
  with check (
    public.is_lab_member(lab_id)
    and created_by = auth.uid()
  );

create policy integration_links_update on public.integration_links
  for update to authenticated
  using (public.is_lab_admin(lab_id) or created_by = auth.uid())
  with check (public.is_lab_member(lab_id));

create policy integration_links_delete on public.integration_links
  for delete to authenticated
  using (public.is_lab_admin(lab_id) or created_by = auth.uid());

grant select, insert, update, delete on public.integration_links to authenticated;
