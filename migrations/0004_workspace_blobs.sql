-- Action retry records may exist before any project is created. Keep these
-- owner-scoped under the reserved agent/ prefix; project blobs retain their FK
-- and cascade deletion. The existing owner RLS policy applies to both scopes.
alter table ontolab.blobs alter column project_id drop not null;
alter table ontolab.blobs add constraint blobs_workspace_path
  check (project_id is not null or path like 'agent/%');
