ALTER TABLE cache_page_states ADD COLUMN retry_at bigint NOT NULL DEFAULT 0;
ALTER TABLE cache_snapshot_pages ADD COLUMN published_at bigint, ADD COLUMN hit_index integer;
ALTER TABLE cache_snapshot_pages DROP CONSTRAINT cache_snapshot_pages_pkey;
CREATE UNIQUE INDEX cache_snapshot_hit_index ON cache_snapshot_pages(snapshot_id,hit_index);
ALTER TABLE cache_snapshots ADD COLUMN answer_keys text[];

CREATE FUNCTION cache_link_blocked(project text, page text, access bigint)
RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT EXISTS (SELECT FROM cache_page_states s WHERE s.scope=project AND s.page_key=page
        AND (s.status=410 OR (s.status IN (-1,401,403) AND s.access_epoch=access)))
$$;

CREATE FUNCTION cache_visible_snapshot_links(s cache_snapshots, as_of bigint)
RETURNS TABLE(page_key text, hit_index integer) LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT p.page_key,p.hit_index FROM cache_snapshot_pages p WHERE p.snapshot_id=s.id
      AND NOT cache_link_blocked(s.scope,p.page_key,s.access_epoch)
      AND (s.body#>>'{query,time_range}' IS NULL OR p.published_at BETWEEN
           as_of - CASE s.body#>>'{query,time_range}' WHEN 'day' THEN 86400000::bigint
                   WHEN 'month' THEN 2592000000 WHEN 'year' THEN 31536000000 END AND as_of)
$$;

CREATE FUNCTION cache_visible_snapshot_answer(s cache_snapshots)
RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT s.answer_keys IS NOT NULL AND s.body#>>'{query,time_range}' IS NULL
        AND NOT EXISTS (SELECT FROM unnest(s.answer_keys) k WHERE cache_link_blocked(s.scope,k,s.access_epoch))
$$;
