-- Evaluations have their own lifecycle, independent of extraction runs.
alter table ontolab.records drop constraint records_kind_check;
alter table ontolab.records add constraint records_kind_check check
  (kind in ('document','text','chunk','revision','run','checkpoint','report','conversation','evaluation'));
create index records_evaluations_active on ontolab.records ((data->>'state')) where kind='evaluation';
create policy evaluation_worker_scan on ontolab.records for select to ontolab_worker
  using (kind='evaluation' and data->>'state' in ('queued','running','cancelling'));
