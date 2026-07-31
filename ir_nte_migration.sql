-- ============================================================
-- DEPOT/OS — Incident Reports (IR) & Notices to Explain (NTE)
-- ------------------------------------------------------------
-- Workflow:
--   Admin files an IR against anyone -> counts immediately (approved).
--   Stock Clerk files an IR against any coworker -> pending until an
--     Admin approves it; only then does it count.
--   Once an employee accumulates 3 APPROVED violations within a
--     rolling 90-day window, the system automatically bundles the
--     oldest 3 into a new NTE and generates the letter.
--   An NTE stays open until the employee uploads a written
--     explanation (PDF/JPG/JPEG/PNG), and even then stays open until
--     an Admin reviews it and records a resolution.
--
-- NOTE ON SCOPE: this is a record-keeping and workflow tool, not a
-- source of legal advice. The NTE letter text this generates is a
-- reasonable template based on common PH labor-law practice (the
-- "twin notice" pattern), but should be reviewed by whoever handles
-- your actual HR/legal compliance before relying on it for real
-- disciplinary action.
-- ============================================================

create table if not exists nte_reports (
  id                     text primary key,
  subject_user_id        uuid references profiles(id),
  subject_name           text not null,
  generated_at           text not null,
  status                 text not null default 'awaiting_explanation', -- awaiting_explanation | explanation_submitted | resolved
  explanation_file_path  text,
  explanation_file_name  text,
  explanation_uploaded_at text,
  resolution_notes       text,
  resolved_by            uuid references profiles(id),
  resolved_by_name       text,
  resolved_at            text,
  created_at             timestamptz not null default now()
);

create table if not exists ir_reports (
  id              text primary key,
  subject_user_id uuid references profiles(id),
  subject_name    text not null,
  filed_by_user_id uuid references profiles(id),
  filed_by_name   text not null,
  filer_role      text not null,
  category        text not null,   -- 'Violation' | 'Attendance' | 'Work Performance'
  violation_code  text not null,
  incident_date   text not null,
  description     text not null,
  status          text not null default 'pending', -- pending | approved | rejected
  reviewed_by     uuid references profiles(id),
  reviewed_by_name text,
  reviewed_at     text,
  rejection_reason text,
  nte_id          text references nte_reports(id),
  timestamp       text not null,
  created_at      timestamptz not null default now()
);

create index if not exists ir_reports_subject_idx on ir_reports (subject_user_id);
create index if not exists ir_reports_status_idx on ir_reports (status);
create index if not exists nte_reports_subject_idx on nte_reports (subject_user_id);

alter table ir_reports enable row level security;
alter table nte_reports enable row level security;

-- Visibility: Admin sees everything. Everyone else only sees IRs where
-- they're the subject OR the one who filed it — NOT other people's
-- disciplinary records. This is deliberate: conduct records are
-- sensitive, and a Stock Clerk shouldn't be able to browse a
-- coworker's history just because they can file reports.
drop policy if exists "ir_reports_select" on ir_reports;
create policy "ir_reports_select" on ir_reports
  for select using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'Admin')
    or subject_user_id = auth.uid()
    or filed_by_user_id = auth.uid()
  );

drop policy if exists "ir_reports_insert" on ir_reports;
create policy "ir_reports_insert" on ir_reports
  for insert with check (
    exists (select 1 from profiles p where p.id = auth.uid() and p.role in ('Admin','Stock Clerk'))
  );

-- Only Admin can update (approve/reject) an IR.
drop policy if exists "ir_reports_update" on ir_reports;
create policy "ir_reports_update" on ir_reports
  for update using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'Admin')
  ) with check (
    exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'Admin')
  );

drop policy if exists "nte_reports_select" on nte_reports;
create policy "nte_reports_select" on nte_reports
  for select using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'Admin')
    or subject_user_id = auth.uid()
  );

-- NTEs are only ever created by the app's own approval logic, which
-- always runs in an Admin session (Admin either files directly or
-- approves a Stock Clerk's IR — either way, an Admin is at the keyboard).
drop policy if exists "nte_reports_insert" on nte_reports;
create policy "nte_reports_insert" on nte_reports
  for insert with check (
    exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'Admin')
  );

-- Update is shared: the subject employee needs to attach their
-- explanation, and Admin needs to record the resolution. RLS can't
-- practically restrict this to "only the explanation columns" vs
-- "only the resolution columns" without a trigger — noting that as a
-- known boundary, same as the adjustments-approval tradeoff earlier.
drop policy if exists "nte_reports_update" on nte_reports;
create policy "nte_reports_update" on nte_reports
  for update using (
    subject_user_id = auth.uid()
    or exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'Admin')
  ) with check (
    subject_user_id = auth.uid()
    or exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'Admin')
  );

-- ============================================================
-- Storage bucket for explanation uploads (PDF/JPG/JPEG/PNG)
-- ------------------------------------------------------------
-- Private bucket. Files are stored under a path beginning with the
-- uploader's own user id (e.g. "{user_id}/{nte_id}/{filename}"), which
-- the policies below use to make sure only the employee who uploaded
-- their own explanation, or an Admin, can read or write it.
-- ============================================================
insert into storage.buckets (id, name, public)
values ('ir-explanations', 'ir-explanations', false)
on conflict (id) do nothing;

drop policy if exists "ir_explanations_upload" on storage.objects;
create policy "ir_explanations_upload" on storage.objects
  for insert with check (
    bucket_id = 'ir-explanations'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "ir_explanations_read" on storage.objects;
create policy "ir_explanations_read" on storage.objects
  for select using (
    bucket_id = 'ir-explanations'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'Admin')
    )
  );

-- Realtime, so an Admin approving an IR or a case being resolved shows
-- up live for anyone else who has the page open (same fix as the
-- earlier inventory realtime work).
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'ir_reports') then
    alter publication supabase_realtime add table ir_reports;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'nte_reports') then
    alter publication supabase_realtime add table nte_reports;
  end if;
end $$;
