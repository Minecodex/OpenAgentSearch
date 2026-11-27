SELECT j.* FROM cache_jobs j
WHERE j.namespace=$1 AND j.activation=$2 AND j.handler=$3 AND j.payload_version=(SELECT payload_version FROM cache_control WHERE singleton)
  AND j.deadline>$4
  AND (
    (j.state IN ('waiting','retry') AND j.available_at<=$4 AND j.attempts<j.attempt_limit)
    OR (j.state='running' AND j.lease_until<=$4)
  )
  AND ($5 OR j.kind NOT IN ('list','content')) AND ($6 OR j.kind<>'summary')
  AND EXISTS (
    SELECT FROM cache_enabled_scopes a WHERE a.scope=j.scope
      AND (a.scope LIKE 'admin:%' OR EXISTS (
        SELECT FROM resources r WHERE r.id::text=a.scope AND COALESCE((r.body->>'cache_epoch')::bigint,0)=j.cache_epoch
      ))
  )
  -- Browser recovery deletes this receipt only after confirming closure or Pod loss.
  AND NOT EXISTS (SELECT FROM browser_jobs b WHERE b.body->>'request_id'=j.execution_request)
ORDER BY CASE WHEN j.state='running' THEN 0 WHEN j.reason='hot_expiry' THEN 2 ELSE 1 END, j.sequence
LIMIT 1 FOR UPDATE OF j SKIP LOCKED
