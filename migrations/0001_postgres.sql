-- Dedicated namespace: independent of other applications.
create schema if not exists ontolab;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'ontolab_app') then
    create role ontolab_app nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'ontolab_worker') then
    create role ontolab_worker nologin;
  end if;
end $$;
grant ontolab_app, ontolab_worker to current_user;

create table ontolab.projects (
  owner_id text not null,
  id text not null,
  data jsonb not null,
  primary key (owner_id, id)
);

-- Typed project records keep the application's lossless JSON representation.
-- Revision contents and leases live in the same row for atomic updates.
create table ontolab.records (
  owner_id text not null,
  project_id text not null,
  kind text not null check (kind in ('document','text','chunk','revision','run','checkpoint','report','conversation')),
  id text not null,
  data jsonb not null,
  content jsonb,
  lease_holder text,
  lease_expires_at timestamptz,
  primary key (owner_id, project_id, kind, id),
  foreign key (owner_id, project_id) references ontolab.projects(owner_id, id) on delete cascade
);
create index records_project_kind on ontolab.records (owner_id, project_id, kind);
create index records_runs_active on ontolab.records ((data->>'status')) where kind = 'run';
create index records_chunk_search on ontolab.records using gin (to_tsvector('simple', data->>'text')) where kind = 'chunk';
create unique index revision_number on ontolab.records (owner_id, project_id, (data->>'number'))
  where kind = 'revision' and data->>'number' is not null;

-- Postgres-only pilot: uploads/caches are durable bytea, behind the same owner
-- boundary. The BlobStore interface allows moving these to GCS/S3 later.
create table ontolab.blobs (
  owner_id text not null,
  project_id text not null,
  path text not null,
  bytes bytea not null,
  content_type text not null,
  primary key (owner_id, path),
  foreign key (owner_id, project_id) references ontolab.projects(owner_id, id) on delete cascade
);

alter table ontolab.projects enable row level security;
alter table ontolab.records enable row level security;
alter table ontolab.blobs enable row level security;
alter table ontolab.projects force row level security;
alter table ontolab.records force row level security;
alter table ontolab.blobs force row level security;

create policy projects_owner on ontolab.projects to ontolab_app
  using (owner_id = current_setting('ontolab.user_id', true))
  with check (owner_id = current_setting('ontolab.user_id', true));
create policy records_owner on ontolab.records to ontolab_app
  using (owner_id = current_setting('ontolab.user_id', true))
  with check (owner_id = current_setting('ontolab.user_id', true));
create policy blobs_owner on ontolab.blobs to ontolab_app
  using (owner_id = current_setting('ontolab.user_id', true))
  with check (owner_id = current_setting('ontolab.user_id', true));
-- The scanner can discover runnable jobs; actual work binds to their owner.
create policy worker_scan on ontolab.records for select to ontolab_worker
  using (kind = 'run' and data->>'status' in ('queued','running'));
grant usage on schema ontolab to ontolab_app, ontolab_worker;
grant select, insert, update, delete on ontolab.projects, ontolab.records, ontolab.blobs to ontolab_app;
grant select on ontolab.records to ontolab_worker;
