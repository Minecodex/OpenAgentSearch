WITH allowed_sources AS MATERIALIZED (
  SELECT source FROM unnest($5::text[]) allowed(source)
  WHERE source IN ($6, $7) OR (
    EXISTS (SELECT FROM resources e WHERE e.id::text = source AND NOT e.archived)
    AND ($2 LIKE 'admin:%' OR EXISTS (
      SELECT FROM resource_links l WHERE l.owner_id::text = $2 AND l.target_id::text = source
    ))
  )
)
SELECT candidate.body, candidate.indices, candidate.legacy_keys, candidate.answer_visible
FROM unnest($3::text[]) requested(question)
CROSS JOIN LATERAL (
  SELECT s.body, visible.indices, visible.legacy_keys, answer.visible AS answer_visible FROM cache_snapshots s
  CROSS JOIN LATERAL (
    SELECT COALESCE(array_agg(l.hit_index) FILTER (WHERE l.hit_index IS NOT NULL),'{}') AS indices,
           COALESCE(array_agg(l.page_key) FILTER (WHERE l.hit_index IS NULL),'{}') AS legacy_keys
    FROM cache_visible_snapshot_links(s,$4) l
  ) visible
  CROSS JOIN LATERAL (SELECT s.question=$9 AND cache_visible_snapshot_answer(s) AS visible) answer
  WHERE s.namespace=$1 AND s.scope=$2 AND s.question=requested.question
    AND s.expires_at>$4 AND s.access_epoch=$8 AND s.source IN (SELECT source FROM allowed_sources)
    AND (cardinality(visible.indices)>0 OR cardinality(visible.legacy_keys)>0 OR answer.visible)
  ORDER BY s.collected_at DESC, s.acquisition_order DESC, s.id
  LIMIT $10
) candidate
