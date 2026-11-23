CREATE OR REPLACE FUNCTION oas_call_dimensions(body jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT jsonb_build_object('project_id',body->'project_id','endpoint_id',body->'endpoint_id',
  'endpoint_version',body->'endpoint_version','kind',body->'kind','operation',body->'operation',
  'origin',body->'origin','language',body->'language','reason',body->'reason',
  'status',body->'status','evaluation',body->'evaluation')
$$;
CREATE OR REPLACE FUNCTION oas_dimension_hash(dimensions jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT encode(sha256(convert_to(dimensions::text,'UTF8')),'hex')
$$;
ALTER TABLE endpoint_calls ADD COLUMN dimension_hash text
 GENERATED ALWAYS AS (oas_dimension_hash(oas_call_dimensions(body))) STORED;
ALTER TABLE endpoint_calls ADD COLUMN retention_version bigint NOT NULL DEFAULT 1;
UPDATE endpoint_calls c SET retention_version=(r.record->>'retention_version')::bigint FROM requests r WHERE r.id=c.request_id;
UPDATE endpoint_stats_hour SET dimension_hash=oas_dimension_hash(metrics->'dimensions');
UPDATE endpoint_stats_day SET dimension_hash=oas_dimension_hash(metrics->'dimensions');
CREATE INDEX call_rollup_window ON endpoint_calls(dimension_hash,retention_version,finished_at);
