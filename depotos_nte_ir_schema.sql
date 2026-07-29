-- DEPOT/OS — NTE / IR Violation Management Schema
-- Run this in the Supabase SQL editor for your project.
-- Also create a Storage bucket named "violation-files" (public or signed URLs).

CREATE TABLE IF NOT EXISTS violation_cases (
  id              TEXT PRIMARY KEY,
  case_type       TEXT NOT NULL CHECK (case_type IN ('IR', 'NTE')),
  employee_id     TEXT NOT NULL,
  employee_name   TEXT NOT NULL,
  position        TEXT DEFAULT '',
  department      TEXT DEFAULT '',
  reporter_id     UUID REFERENCES profiles(id) ON DELETE SET NULL,
  reporter_name   TEXT NOT NULL,
  reporter_role   TEXT NOT NULL,
  category        TEXT NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('Minor', 'Major', 'Critical')),
  violation_date  DATE NOT NULL,
  violation_time  TEXT DEFAULT '',
  location        TEXT DEFAULT '',
  description     TEXT NOT NULL,
  additional_info TEXT DEFAULT '',
  remarks         TEXT DEFAULT '',
  attachments     JSONB DEFAULT '[]'::jsonb,
  status          TEXT NOT NULL DEFAULT 'pending_approval',
  approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  violation_count INTEGER DEFAULT 0,
  explanation_pdf TEXT DEFAULT '',
  sanction_pdf    TEXT DEFAULT '',
  policy_violated TEXT DEFAULT '',
  explanation_deadline DATE,
  related_ir_ids  JSONB DEFAULT '[]'::jsonb,
  parent_case_id  TEXT,
  workflow_history JSONB DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_violation_cases_employee ON violation_cases(employee_id);
CREATE INDEX IF NOT EXISTS idx_violation_cases_status ON violation_cases(status);
CREATE INDEX IF NOT EXISTS idx_violation_cases_type ON violation_cases(case_type);
CREATE INDEX IF NOT EXISTS idx_violation_cases_reporter ON violation_cases(reporter_id);
CREATE INDEX IF NOT EXISTS idx_violation_cases_created ON violation_cases(created_at DESC);

-- RLS: enable and allow authenticated users (tighten per your org policy)
ALTER TABLE violation_cases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read violation_cases" ON violation_cases
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated insert violation_cases" ON violation_cases
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated update violation_cases" ON violation_cases
  FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Authenticated delete violation_cases" ON violation_cases
  FOR DELETE TO authenticated USING (true);

-- Storage bucket policy (run after creating bucket "violation-files" in dashboard):
-- Allow authenticated uploads and reads on violation-files/*
