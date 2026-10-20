-- Retro Arcade family save store. Run once on a dedicated Supabase project.
-- Access control: every request carries the family code in an "x-family" header. Rows are keyed by
-- the SHA-256 of that code, and row level security only exposes rows whose key matches the header,
-- so the public anon key alone sees nothing.
create extension if not exists pgcrypto;

create or replace function arcade_family() returns text
language sql stable as $$
  select encode(digest(coalesce(current_setting('request.headers', true)::json->>'x-family', ''), 'sha256'), 'hex')
$$;

create table if not exists arcade_saves (
  family     text not null,
  player     text not null,
  game       text not null,
  kind       text not null check (kind in ('sram', 'state')),
  data       text not null,              -- gzip, base64
  size       integer not null,           -- bytes before compression
  device     text,
  updated_at timestamptz not null default now(),
  primary key (family, player, game, kind)
);

create table if not exists arcade_save_history (
  id         bigserial primary key,
  family     text not null,
  player     text not null,
  game       text not null,
  kind       text not null,
  data       text not null,
  size       integer not null,
  device     text,
  updated_at timestamptz not null
);
create index if not exists arcade_save_history_key on arcade_save_history (family, player, game, kind, updated_at desc);

create table if not exists arcade_profiles (
  family     text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

-- Keep the last 3 versions of every save so a bad save can be rolled back.
create or replace function arcade_keep_history() returns trigger language plpgsql as $$
begin
  insert into arcade_save_history (family, player, game, kind, data, size, device, updated_at)
    values (old.family, old.player, old.game, old.kind, old.data, old.size, old.device, old.updated_at);
  delete from arcade_save_history h
   where h.family = old.family and h.player = old.player and h.game = old.game and h.kind = old.kind
     and h.id not in (select id from arcade_save_history
                       where family = old.family and player = old.player and game = old.game and kind = old.kind
                       order by updated_at desc limit 3);
  return new;
end $$;
drop trigger if exists arcade_saves_history on arcade_saves;
create trigger arcade_saves_history before update on arcade_saves
  for each row when (old.data is distinct from new.data) execute function arcade_keep_history();

alter table arcade_saves enable row level security;
alter table arcade_save_history enable row level security;
alter table arcade_profiles enable row level security;

drop policy if exists family_saves on arcade_saves;
create policy family_saves on arcade_saves for all to anon, authenticated
  using (family = arcade_family() and length(coalesce(current_setting('request.headers', true)::json->>'x-family', '')) >= 8)
  with check (family = arcade_family() and length(coalesce(current_setting('request.headers', true)::json->>'x-family', '')) >= 8);
drop policy if exists family_history on arcade_save_history;
create policy family_history on arcade_save_history for select to anon, authenticated
  using (family = arcade_family() and length(coalesce(current_setting('request.headers', true)::json->>'x-family', '')) >= 8);
drop policy if exists family_profiles on arcade_profiles;
create policy family_profiles on arcade_profiles for all to anon, authenticated
  using (family = arcade_family() and length(coalesce(current_setting('request.headers', true)::json->>'x-family', '')) >= 8)
  with check (family = arcade_family() and length(coalesce(current_setting('request.headers', true)::json->>'x-family', '')) >= 8);

-- Lightweight listing for "Continue playing" (no save data in the payload).
create or replace view arcade_recent as
  select family, player, game, max(updated_at) as updated_at from arcade_saves group by family, player, game;
grant select on arcade_recent to anon, authenticated;

-- 2026-10-18: manual save slots.
alter table arcade_saves drop constraint if exists arcade_saves_kind_check;
alter table arcade_saves add constraint arcade_saves_kind_check check (kind in ('sram', 'state', 'slot1', 'slot2', 'slot3'));

-- 2026-10-19: the history trigger runs as the caller (anon), and arcade_save_history only allows select,
-- so every update of an existing save failed with 42501 (HTTP 401). Run the trigger as its owner instead.
alter function arcade_keep_history() security definer set search_path = public;
revoke execute on function arcade_keep_history() from public, anon, authenticated;

-- 2026-10-19: the "Continue playing" view ran with its owner's rights, so it ignored row level security: any code
-- looked valid and every family's player and game names were visible. Make it run as the caller.
alter view arcade_recent set (security_invoker = true);

-- 2026-10-20: desktop emulator saves (GameCube, PS2, 3DS) are stored as kind 'native' (a zip of the game's save files).
alter table arcade_saves drop constraint if exists arcade_saves_kind_check;
alter table arcade_saves add constraint arcade_saves_kind_check check (kind in ('sram', 'state', 'slot1', 'slot2', 'slot3', 'native'));

-- 2026-10-20: deeper history for in-game saves (small): every version from the last 2 days plus the newest version of
-- each day for 60 days, so a save that went bad days ago can still be brought back. Snapshots (large) keep the last 3.
create or replace function arcade_keep_history() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into arcade_save_history (family, player, game, kind, data, size, device, updated_at)
    values (old.family, old.player, old.game, old.kind, old.data, old.size, old.device, old.updated_at);
  if old.kind in ('sram', 'native') then
    delete from arcade_save_history h
     where h.family = old.family and h.player = old.player and h.game = old.game and h.kind = old.kind
       and h.updated_at < now() - interval '2 days'
       and (h.updated_at < now() - interval '60 days'
            or h.id not in (select distinct on (date_trunc('day', updated_at)) id from arcade_save_history
                             where family = old.family and player = old.player and game = old.game and kind = old.kind
                             order by date_trunc('day', updated_at), updated_at desc));
  else
    delete from arcade_save_history h
     where h.family = old.family and h.player = old.player and h.game = old.game and h.kind = old.kind
       and h.id not in (select id from arcade_save_history
                         where family = old.family and player = old.player and game = old.game and kind = old.kind
                         order by updated_at desc limit 3);
  end if;
  return new;
end $$;
revoke execute on function arcade_keep_history() from public, anon, authenticated;
