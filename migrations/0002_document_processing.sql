-- Discover durable parsing jobs as well as generation runs. Work still executes as the owning user.
alter policy worker_scan on ontolab.records using (
  (kind = 'run' and data->>'status' in ('queued','running'))
  or (kind = 'document' and data->>'parseState' = 'pending')
);
create index records_documents_pending on ontolab.records ((data->>'createdAt'))
  where kind = 'document' and data->>'parseState' = 'pending';
