create table ontolab.graph_connections (
  owner_id text not null,
  id text not null,
  data jsonb not null,
  primary key (owner_id, id)
);
alter table ontolab.graph_connections enable row level security;
alter table ontolab.graph_connections force row level security;
create policy owner_connections on ontolab.graph_connections
  using (owner_id = current_setting('ontolab.user_id', true))
  with check (owner_id = current_setting('ontolab.user_id', true));
grant select, insert, update, delete on ontolab.graph_connections to ontolab_app;
