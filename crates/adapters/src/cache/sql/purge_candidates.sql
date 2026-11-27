SELECT g.* FROM cache_index_gc g
WHERE g.namespace=$1 AND (
  $3::jsonb IS NULL OR (g.kind,g.scope,g.access_epoch,g.target) IN (
    SELECT kind,scope,epoch,target FROM jsonb_to_recordset($3) AS b(kind text,scope text,epoch bigint,target text)
  )
) AND (
  (g.kind='question' AND NOT EXISTS (
    SELECT FROM cache_snapshots s WHERE s.namespace=g.namespace AND s.scope=g.scope
      AND s.access_epoch=g.access_epoch AND s.question=g.target AND s.expires_at>$2
  )) OR (g.kind='feature' AND NOT EXISTS (
    SELECT FROM cache_snapshot_pages p JOIN cache_snapshots s ON s.id=p.snapshot_id
    WHERE s.namespace=g.namespace AND p.feature_id=g.target AND s.expires_at>$2
  ))
)
ORDER BY g.kind,g.scope,g.access_epoch,g.target LIMIT 512
