-- Caivan Deficiency Log: complete database setup. Paste ALL of this into Supabase → SQL Editor → New query → Run.
-- Safe to run more than once.

-- Caivan Deficiency Log — database setup



-- ---------- Team members (who may use the app) ----------
create table if not exists public.members (
  email      text primary key check (email = lower(email)),
  name       text not null default '',
  role       text not null default 'editor' check (role in ('admin','editor','viewer')),
  added_at   timestamptz not null default now()
);

-- Role of the signed-in person, or null if they are not a member.
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.members where email = lower(coalesce(auth.jwt() ->> 'email', ''));
$$;
grant execute on function public.my_role() to authenticated;

-- ---------- Deficiencies ----------
create sequence if not exists public.deficiency_ref_seq;

create table if not exists public.deficiencies (
  id          uuid primary key default gen_random_uuid(),
  ref         text not null default ('D-' || lpad(nextval('public.deficiency_ref_seq')::text, 4, '0')),
  ext_ref     text,
  project     text not null default '',
  location    text not null default '',
  category    text not null default 'Other',
  description text not null default '',
  contractor  text not null default 'Unassigned',
  priority    text not null default 'Medium' check (priority in ('High','Medium','Low')),
  raised      date not null default ((now() at time zone 'America/Toronto')::date),
  due         date,
  status      text not null default 'Open' check (status in ('Open','In progress','Ready for re-inspection','Closed')),
  closed      date,
  notes       text not null default '',
  first_seen  date not null default ((now() at time zone 'America/Toronto')::date),
  key         text,
  lat         double precision,
  lng         double precision,
  example     boolean not null default false,
  created_by  text,
  updated_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists deficiencies_key_idx on public.deficiencies (key);
create index if not exists deficiencies_project_idx on public.deficiencies (project);

create or replace function public.touch_updated() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists deficiencies_touch on public.deficiencies;
create trigger deficiencies_touch before update on public.deficiencies
  for each row execute function public.touch_updated();

-- ---------- Photos ----------
create table if not exists public.photos (
  id             uuid primary key default gen_random_uuid(),
  deficiency_id  uuid not null references public.deficiencies(id) on delete cascade,
  path           text not null,
  thumb_path     text not null,
  taken_at       timestamptz,
  lat            double precision,
  lng            double precision,
  uploaded_by    text,
  created_at     timestamptz not null default now()
);
create index if not exists photos_def_idx on public.photos (deficiency_id);

-- ---------- Activity history ----------
create table if not exists public.activity (
  id             bigint generated always as identity primary key,
  deficiency_id  uuid references public.deficiencies(id) on delete cascade,
  who            text not null default '',
  what           text not null,
  at             timestamptz not null default now()
);
create index if not exists activity_def_idx on public.activity (deficiency_id, at desc);

-- ---------- Weekly reports (filled every Monday by the scheduled job) ----------
create table if not exists public.weekly_reports (
  week_start  date primary key,
  stats       jsonb not null,
  created_at  timestamptz not null default now()
);

-- ---------- Security: row-level access by role ----------
alter table public.members        enable row level security;
alter table public.deficiencies   enable row level security;
alter table public.photos         enable row level security;
alter table public.activity       enable row level security;
alter table public.weekly_reports enable row level security;

drop policy if exists members_read  on public.members;
drop policy if exists members_admin on public.members;
create policy members_read  on public.members for select to authenticated using (public.my_role() is not null);
create policy members_admin on public.members for all    to authenticated using (public.my_role() = 'admin') with check (public.my_role() = 'admin');

drop policy if exists def_read   on public.deficiencies;
drop policy if exists def_insert on public.deficiencies;
drop policy if exists def_update on public.deficiencies;
drop policy if exists def_delete on public.deficiencies;
create policy def_read   on public.deficiencies for select to authenticated using (public.my_role() is not null);
create policy def_insert on public.deficiencies for insert to authenticated with check (public.my_role() in ('admin','editor'));
create policy def_update on public.deficiencies for update to authenticated using (public.my_role() in ('admin','editor')) with check (public.my_role() in ('admin','editor'));
create policy def_delete on public.deficiencies for delete to authenticated using (public.my_role() = 'admin');

drop policy if exists ph_read   on public.photos;
drop policy if exists ph_insert on public.photos;
drop policy if exists ph_delete on public.photos;
create policy ph_read   on public.photos for select to authenticated using (public.my_role() is not null);
create policy ph_insert on public.photos for insert to authenticated with check (public.my_role() in ('admin','editor'));
create policy ph_delete on public.photos for delete to authenticated using (public.my_role() in ('admin','editor'));

drop policy if exists act_read   on public.activity;
drop policy if exists act_insert on public.activity;
create policy act_read   on public.activity for select to authenticated using (public.my_role() is not null);
create policy act_insert on public.activity for insert to authenticated with check (public.my_role() in ('admin','editor'));

drop policy if exists wr_read on public.weekly_reports;
create policy wr_read on public.weekly_reports for select to authenticated using (public.my_role() is not null);

-- ---------- Photo storage (private bucket) ----------
insert into storage.buckets (id, name, public) values ('photos', 'photos', false)
on conflict (id) do nothing;

drop policy if exists photos_obj_read   on storage.objects;
drop policy if exists photos_obj_insert on storage.objects;
drop policy if exists photos_obj_delete on storage.objects;
create policy photos_obj_read   on storage.objects for select to authenticated using (bucket_id = 'photos' and public.my_role() is not null);
create policy photos_obj_insert on storage.objects for insert to authenticated with check (bucket_id = 'photos' and public.my_role() in ('admin','editor'));
create policy photos_obj_delete on storage.objects for delete to authenticated using (bucket_id = 'photos' and public.my_role() in ('admin','editor'));

-- ---------- Weekly report snapshot ----------
create or replace function public.snapshot_weekly_report() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t  date := (now() at time zone 'America/Toronto')::date;
  ws date := t - (extract(isodow from t)::int - 1);
  s  jsonb;
begin
  with d as (
    select *, coalesce(due, raised + 14) as due_eff
    from deficiencies where deleted_at is null and example = false
  ), o as (select * from d where status <> 'Closed')
  select jsonb_build_object(
    'generated', t,
    'open',      (select count(*) from o),
    'overdue',   (select count(*) from o where due_eff < t),
    'new',       (select count(*) from o where first_seen >= t - 7),
    'closed7',   (select count(*) from d where status = 'Closed' and closed >= t - 7),
    'ready',     (select count(*) from o where status = 'Ready for re-inspection'),
    'by_type',   coalesce((select jsonb_agg(x order by x->>'category') from (
                    select jsonb_build_object('category', category, 'open', count(*)) x from o group by category) q), '[]'::jsonb),
    'by_contractor', coalesce((select jsonb_agg(x order by (x->>'open')::int desc) from (
                    select jsonb_build_object(
                      'contractor', contractor,
                      'open', count(*),
                      'overdue', count(*) filter (where due_eff < t),
                      'oldest_days', max(t - raised),
                      'oldest_location', (array_agg(location order by raised))[1]) x
                    from o group by contractor) q), '[]'::jsonb),
    'cmb',       coalesce((select jsonb_agg(jsonb_build_object('project', project, 'location', location, 'status', status,
                    'notes', notes, 'overdue', due_eff < t) order by project, location) from o where category = 'CMB (mailbox)'), '[]'::jsonb),
    'high',      coalesce((select jsonb_agg(x) from (select jsonb_build_object('ref', ref, 'project', project, 'location', location,
                    'description', description, 'contractor', contractor) x from o
                    where priority = 'High' and category <> 'CMB (mailbox)' order by raised limit 5) q), '[]'::jsonb)
  ) into s;
  insert into weekly_reports (week_start, stats) values (ws, s)
  on conflict (week_start) do update set stats = excluded.stats, created_at = now();
  return s;
end $$;
-- Lets an admin rebuild this week's report from the app.
create or replace function public.refresh_weekly_report() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if public.my_role() is distinct from 'admin' then raise exception 'Only admins can rebuild the report'; end if;
  return public.snapshot_weekly_report();
end $$;
revoke execute on function public.snapshot_weekly_report() from public, anon, authenticated;
grant execute on function public.refresh_weekly_report() to authenticated;

-- ---------- Live updates between phones and laptops ----------
do $$ begin
  begin alter publication supabase_realtime add table public.deficiencies; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.photos;       exception when duplicate_object then null; end;
end $$;

-- ---------- First admin (YOU) ----------
insert into public.members (email, name, role)
values (lower('cherifamine085@gmail.com'), 'Amine Cherief', 'admin')
on conflict (email) do update set role = 'admin';

-- Photo replace permission (needed when a photo upload is retried)
drop policy if exists photos_obj_update on storage.objects;
create policy photos_obj_update on storage.objects for update to authenticated using (bucket_id = 'photos' and public.my_role() in ('admin','editor')) with check (bucket_id = 'photos' and public.my_role() in ('admin','editor'));


create extension if not exists pg_cron;

-- 11:00 UTC = 7:00 a.m. EDT (6:00 a.m. in winter, EST).
select cron.unschedule(jobid) from cron.job where jobname = 'weekly-deficiency-report';
select cron.schedule('weekly-deficiency-report', '0 11 * * 1', $$select public.snapshot_weekly_report()$$);

-- Build this week's report right now so the app has one to show.
select public.snapshot_weekly_report();

select 'Setup complete' as result;
