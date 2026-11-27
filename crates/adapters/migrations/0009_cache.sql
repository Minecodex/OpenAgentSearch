CREATE TABLE cache_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  handler text NOT NULL, namespace text NOT NULL, activation bigint NOT NULL,
  schema_version integer NOT NULL DEFAULT 1
);
CREATE TABLE cache_index_control (namespace text PRIMARY KEY,encoding text NOT NULL,ready boolean NOT NULL);
CREATE TABLE cache_namespaces (namespace text PRIMARY KEY);
CREATE TABLE cache_storage_totals(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),snapshots bigint NOT NULL DEFAULT 0);
INSERT INTO cache_storage_totals(singleton) VALUES(true);
CREATE TABLE cache_registry (
  scope text NOT NULL, kind text NOT NULL, object_id text NOT NULL,
  body jsonb NOT NULL DEFAULT '{}', total bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope,kind,object_id)
);
CREATE INDEX cache_registry_rank ON cache_registry(scope,kind,total DESC,object_id);
CREATE TABLE cache_snapshots (
  id uuid PRIMARY KEY, namespace text NOT NULL, scope text NOT NULL, question text NOT NULL,
  source text NOT NULL, collected_at bigint NOT NULL, expires_at bigint NOT NULL,
  body jsonb NOT NULL, indexed boolean NOT NULL DEFAULT false, index_version text NOT NULL DEFAULT '', access_epoch bigint NOT NULL DEFAULT 0
);
CREATE INDEX cache_snapshot_lookup ON cache_snapshots(namespace,scope,question,collected_at DESC);
CREATE INDEX cache_snapshot_expiration ON cache_snapshots(expires_at);
CREATE TABLE cache_page_states (
  scope text NOT NULL, page_key text NOT NULL, epoch bigint NOT NULL DEFAULT 0,
  status integer NOT NULL DEFAULT 200, observed_at bigint NOT NULL DEFAULT 0,
  not_found_count integer NOT NULL DEFAULT 0, PRIMARY KEY(scope,page_key)
  ,access_epoch bigint NOT NULL DEFAULT 0
);
CREATE TABLE cache_pages (
  namespace text NOT NULL, scope text NOT NULL, page_key text NOT NULL,
  source text NOT NULL, collected_at bigint NOT NULL, expires_at bigint NOT NULL,
  object_epoch bigint NOT NULL, object_key text NOT NULL, body jsonb NOT NULL,
  PRIMARY KEY(namespace,scope,page_key)
  ,access_epoch bigint NOT NULL DEFAULT 0
);
CREATE INDEX cache_page_expiration ON cache_pages(expires_at);
CREATE TABLE cache_jobs (
  id uuid PRIMARY KEY, scope text NOT NULL, cache_epoch bigint NOT NULL,
  handler text NOT NULL, namespace text NOT NULL, activation bigint NOT NULL,
  payload_version integer NOT NULL DEFAULT 1, kind text NOT NULL, target text NOT NULL,
  dedup text NOT NULL, reason text NOT NULL, parent text NOT NULL,
  scope_body jsonb NOT NULL, input jsonb NOT NULL, object_epoch bigint NOT NULL,
  state text NOT NULL DEFAULT 'waiting', sequence bigint GENERATED ALWAYS AS IDENTITY,
  created_at bigint NOT NULL, deadline bigint NOT NULL, available_at bigint NOT NULL,
  attempts integer NOT NULL DEFAULT 0, merged integer NOT NULL DEFAULT 0,
  lease uuid, lease_until bigint, last_error text, finished_at bigint,
  phases jsonb NOT NULL DEFAULT '[]'
  ,origin text NOT NULL DEFAULT 'system', operation text NOT NULL DEFAULT 'list'
);
CREATE UNIQUE INDEX cache_job_singleflight ON cache_jobs(dedup)
  WHERE state IN ('waiting','retry','running');
CREATE INDEX cache_job_waiting ON cache_jobs(available_at,sequence) WHERE state IN ('waiting','retry');
CREATE INDEX cache_job_scope ON cache_jobs(scope,created_at DESC,id DESC);
CREATE INDEX cache_job_lease ON cache_jobs(lease) WHERE lease IS NOT NULL;
CREATE TABLE cache_usage (
  event_id uuid PRIMARY KEY, scope text NOT NULL, request_id text NOT NULL, lookup_id text NOT NULL,
  kind text NOT NULL, object_id text NOT NULL, outcome text NOT NULL, at bigint NOT NULL
  ,origin text NOT NULL DEFAULT 'unknown', operation text NOT NULL DEFAULT 'list'
);
CREATE INDEX cache_usage_window ON cache_usage(scope,at);
CREATE TABLE cache_heat_buckets (
  scope text NOT NULL, kind text NOT NULL, object_id text NOT NULL,
  bucket bigint NOT NULL, count bigint NOT NULL,
  PRIMARY KEY(scope,kind,object_id,bucket)
);
CREATE INDEX cache_heat_window ON cache_heat_buckets(scope,kind,bucket);
CREATE TABLE cache_hot_members (
  scope text NOT NULL, kind text NOT NULL, object_id text NOT NULL,
  total_hot boolean NOT NULL, recent_hot boolean NOT NULL, as_of bigint NOT NULL,
  PRIMARY KEY(scope,kind,object_id)
);
CREATE TABLE cache_gc_objects (
  object_key text PRIMARY KEY, orphaned_at bigint NOT NULL, bytes bigint NOT NULL DEFAULT 0
);
CREATE TABLE cache_read_leases (id uuid PRIMARY KEY,object_key text NOT NULL,expires_at bigint NOT NULL);
CREATE INDEX cache_read_object ON cache_read_leases(object_key,expires_at);
CREATE TABLE cache_foreground_reads(scope text NOT NULL,page_key text NOT NULL,request_id text NOT NULL,cache_epoch bigint NOT NULL,access_epoch bigint NOT NULL,expires_at bigint NOT NULL,PRIMARY KEY(scope,page_key,request_id));
CREATE INDEX cache_foreground_read_key ON cache_foreground_reads(scope,page_key,expires_at);
CREATE TABLE cache_hot_boards (scope text NOT NULL,kind text NOT NULL,as_of bigint NOT NULL,PRIMARY KEY(scope,kind));
CREATE TABLE cache_expiry_marks (
  namespace text NOT NULL, scope text NOT NULL, kind text NOT NULL,
  target text NOT NULL, generation bigint NOT NULL,
  PRIMARY KEY(namespace,scope,kind,target,generation)
);
INSERT INTO settings(name,version,body) VALUES
 ('cache-concurrency',1,'{"configured_limit":1}'),
 ('cache-policy',1,'{"list":{"total_hot_percent":10,"recent_hot_percent":10,"recent_window_hours":24},"content":{"total_hot_percent":10,"recent_hot_percent":10,"recent_window_hours":24}}'),
 ('cache-model-budgets',1,'{"concurrency":1,"rpm":10}')
 ON CONFLICT DO NOTHING;

ALTER TABLE cache_snapshots ADD COLUMN acquisition_order bigint NOT NULL DEFAULT 0;
ALTER TABLE cache_pages ADD COLUMN acquisition_order bigint NOT NULL DEFAULT 0;
ALTER TABLE cache_page_states ADD COLUMN observed_order bigint NOT NULL DEFAULT 0;
CREATE TABLE cache_page_resources(scope text NOT NULL,page_key text NOT NULL,resource_key text NOT NULL,PRIMARY KEY(scope,page_key));
CREATE INDEX cache_resource_pages ON cache_page_resources(scope,resource_key);

CREATE TABLE cache_snapshot_pages(snapshot_id uuid NOT NULL REFERENCES cache_snapshots(id) ON DELETE CASCADE,page_key text NOT NULL,feature_id text NOT NULL,PRIMARY KEY(snapshot_id,page_key));
CREATE INDEX cache_feature_references ON cache_snapshot_pages(feature_id,snapshot_id);
CREATE INDEX cache_rendered_references ON cache_snapshot_pages(page_key,snapshot_id);
CREATE TABLE cache_index_gc(namespace text NOT NULL,kind text NOT NULL,scope text NOT NULL,access_epoch bigint NOT NULL,target text NOT NULL,PRIMARY KEY(namespace,kind,scope,access_epoch,target));
CREATE FUNCTION cache_snapshot_removed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO cache_index_gc VALUES(OLD.namespace,'question',OLD.scope,OLD.access_epoch,OLD.question) ON CONFLICT DO NOTHING;
 INSERT INTO cache_index_gc SELECT OLD.namespace,'feature','',0,feature_id FROM cache_snapshot_pages WHERE snapshot_id=OLD.id ON CONFLICT DO NOTHING;
 RETURN OLD;
END $$;
CREATE TRIGGER cache_snapshot_index_cleanup BEFORE DELETE ON cache_snapshots FOR EACH ROW EXECUTE FUNCTION cache_snapshot_removed();
