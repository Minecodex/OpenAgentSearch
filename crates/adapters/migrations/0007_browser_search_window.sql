UPDATE resources SET body = jsonb_set(body, '{timeout_ms}', '14000') WHERE kind='endpoints' AND body->>'adapter'='browser_search' AND body->>'managed_by'='system' AND body->>'timeout_ms'='8000';
