SELECT p.namespace,p.scope,p.page_key,p.object_key,COALESCE((p.body->>'size_bytes')::bigint,0) AS bytes
FROM cache_pages p
WHERE (
  p.namespace <> $1 OR p.expires_at <= $2 AND (
    NOT EXISTS (SELECT FROM cache_enabled_scopes a WHERE a.scope=p.scope AND a.access_epoch=p.access_epoch)
    OR EXISTS (
      SELECT FROM cache_hot_boards b WHERE b.scope=p.scope AND b.kind='content' AND b.as_of>$2-180000
    ) AND (
      NOT EXISTS (SELECT FROM cache_hot_members h WHERE h.scope=p.scope AND h.kind='content' AND h.object_id=p.page_key)
      OR EXISTS (SELECT FROM cache_expiry_marks m WHERE m.namespace=p.namespace AND m.scope=p.scope AND m.kind='content' AND m.target=p.page_key AND m.generation=p.collected_at)
    )
  )
) AND NOT EXISTS (SELECT FROM cache_read_leases l WHERE l.object_key=p.object_key AND l.expires_at>$2)
  AND NOT EXISTS (SELECT FROM cache_jobs j WHERE j.namespace=p.namespace AND j.scope=p.scope AND j.target=p.page_key AND j.state='running')
ORDER BY p.expires_at LIMIT 256
