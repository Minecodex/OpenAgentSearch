-- Present archived capability tests using the resource and outcome sampled by that test.
CREATE VIEW request_history AS
SELECT id, project_id, operation, origin, started_at, expires_at, payload,
    CASE WHEN origin IN ('endpoint_test', 'proxy_test') THEN record || jsonb_build_object(
        'query_preview', COALESCE(NULLIF(record->>'query_preview', ''), payload #>> '{request_payload,resource_name}',
            jsonb_path_query_first(payload, '$.execution_summary.endpoints.*[*].endpoint_name') #>> '{}'),
        'response_preview', COALESCE(NULLIF(record->>'response_preview', ''), payload #>> '{response_payload,data,reason}',
            payload #>> '{response_payload,data,status}')
    ) ELSE record END AS record
FROM requests;
