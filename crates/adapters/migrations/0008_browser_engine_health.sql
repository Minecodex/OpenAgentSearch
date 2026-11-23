CREATE TABLE browser_engine_health (
    egress_id text NOT NULL,
    version bigint NOT NULL,
    failure_code text NOT NULL,
    retry_at timestamptz NOT NULL,
    PRIMARY KEY (egress_id, version)
);
