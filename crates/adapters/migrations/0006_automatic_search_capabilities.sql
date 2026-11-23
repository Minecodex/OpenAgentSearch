-- Only active configuration changes. Recorded request snapshots remain historical evidence.
UPDATE resources SET body = body - 'default_language' - 'languages'
WHERE kind = 'projects' AND (body ? 'default_language' OR body ? 'languages');

UPDATE resources SET body = jsonb_set(body, '{options}', (body->'options') - 'languages' - 'time_ranges')
WHERE kind = 'endpoints' AND body->>'kind' = 'search'
  AND ((body->'options') ? 'languages' OR (body->'options') ? 'time_ranges');
