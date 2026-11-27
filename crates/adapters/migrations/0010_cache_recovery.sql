-- Account immutable uploads (including staged and orphaned objects) until
-- physical deletion is acknowledged. Existing pointer rows bootstrap the ledger.
INSERT INTO cache_gc_objects(object_key, orphaned_at, bytes)
SELECT object_key, max(collected_at), max(COALESCE((body->>'size_bytes')::bigint, 0))
FROM cache_pages GROUP BY object_key ON CONFLICT DO NOTHING;

ALTER TABLE cache_storage_totals
  ADD COLUMN object_bytes bigint NOT NULL DEFAULT 0 CHECK (object_bytes >= 0);
UPDATE cache_storage_totals SET
  object_bytes = (SELECT COALESCE(sum(bytes),0) FROM cache_gc_objects),
  snapshots = (SELECT count(*) FROM cache_snapshots);

CREATE FUNCTION cache_account_upload() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE cache_storage_totals SET object_bytes = object_bytes + NEW.bytes WHERE singleton;
  RETURN NULL;
END $$;
CREATE TRIGGER cache_account_upload AFTER INSERT ON cache_gc_objects
  FOR EACH ROW EXECUTE FUNCTION cache_account_upload();

CREATE FUNCTION cache_release_uploads() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE cache_storage_totals SET object_bytes = object_bytes -
    (SELECT COALESCE(sum(bytes),0) FROM removed) WHERE singleton;
  RETURN NULL;
END $$;
CREATE TRIGGER cache_release_uploads AFTER DELETE ON cache_gc_objects
  REFERENCING OLD TABLE AS removed FOR EACH STATEMENT EXECUTE FUNCTION cache_release_uploads();

CREATE FUNCTION cache_release_snapshots() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE cache_storage_totals SET snapshots = snapshots -
    (SELECT count(*) FROM removed) WHERE singleton;
  RETURN NULL;
END $$;
CREATE TRIGGER cache_release_snapshots AFTER DELETE ON cache_snapshots
  REFERENCING OLD TABLE AS removed FOR EACH STATEMENT EXECUTE FUNCTION cache_release_snapshots();

CREATE INDEX cache_page_object ON cache_pages(object_key);
CREATE INDEX cache_snapshot_versions ON cache_snapshots(namespace,scope,access_epoch,question,collected_at DESC,acquisition_order DESC,id);
CREATE INDEX cache_orphan_age ON cache_gc_objects(orphaned_at);
CREATE VIEW cache_enabled_scopes AS
  SELECT id::text AS scope, COALESCE((body->>'cache_access_epoch')::bigint,0) AS access_epoch
  FROM resources WHERE kind='projects' AND NOT archived AND body->>'cache_enabled'='true'
  UNION ALL
  SELECT 'admin:' || id::text, version FROM resources WHERE kind='endpoints' AND NOT archived;

ALTER TABLE cache_jobs ADD COLUMN attempt_limit integer NOT NULL DEFAULT 3 CHECK (attempt_limit > 0),
  ADD COLUMN execution_request text;
UPDATE cache_jobs j SET execution_request = (
  SELECT phase->>'request_id' FROM jsonb_array_elements(j.phases) WITH ORDINALITY x(phase,n)
  WHERE phase->>'request_id' IS NOT NULL ORDER BY n DESC LIMIT 1
) WHERE state IN ('waiting','retry','running');
CREATE INDEX cache_stale_leases ON cache_jobs(lease_until) WHERE state='running';
CREATE INDEX cache_browser_cleanup_request ON browser_jobs((body->>'request_id'));

ALTER TABLE cache_control ADD COLUMN payload_version integer NOT NULL DEFAULT 1;
