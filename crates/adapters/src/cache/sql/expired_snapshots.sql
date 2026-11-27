DELETE FROM cache_snapshots WHERE id IN (
  SELECT s.id FROM cache_snapshots s WHERE (
    s.namespace<>$1 OR s.expires_at<=$2 AND (
      NOT EXISTS (SELECT FROM cache_enabled_scopes a WHERE a.scope=s.scope AND a.access_epoch=s.access_epoch)
      OR EXISTS (SELECT FROM cache_hot_boards b WHERE b.scope=s.scope AND b.kind='list' AND b.as_of>$2-180000)
        AND (EXISTS (SELECT FROM cache_snapshots newer WHERE newer.namespace=s.namespace AND newer.scope=s.scope
                      AND newer.question=s.question AND newer.access_epoch=s.access_epoch
                      AND (newer.collected_at,newer.acquisition_order,newer.id)>(s.collected_at,s.acquisition_order,s.id))
             OR NOT EXISTS (SELECT FROM cache_hot_members h WHERE h.scope=s.scope AND h.kind='list' AND h.object_id=s.question)
             OR EXISTS (SELECT FROM cache_expiry_marks m WHERE m.namespace=s.namespace AND m.scope=s.scope AND m.kind='list' AND m.target=s.question AND m.generation=s.collected_at))
    )
  ) AND NOT EXISTS (SELECT FROM cache_jobs j WHERE j.target=s.id::text AND j.kind='index' AND j.state='running')
  ORDER BY s.expires_at LIMIT 10000
)
