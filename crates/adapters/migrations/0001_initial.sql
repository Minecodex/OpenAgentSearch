CREATE TABLE IF NOT EXISTS administrators (
  username text PRIMARY KEY, password_hash text NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY, username text NOT NULL REFERENCES administrators,
  csrf text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS resources (
  id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('projects','endpoints','proxies','proxy-pools')),
  version bigint NOT NULL DEFAULT 1, body jsonb NOT NULL,
  secret bytea, archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS resource_kind ON resources(kind,archived,created_at,id);
CREATE TABLE IF NOT EXISTS resource_links (
  owner_id uuid NOT NULL REFERENCES resources(id), target_id uuid NOT NULL REFERENCES resources(id),
  role text NOT NULL, PRIMARY KEY(owner_id,target_id,role)
);
CREATE INDEX IF NOT EXISTS resource_link_target ON resource_links(target_id);
CREATE TABLE IF NOT EXISTS project_keys (
  project_id uuid PRIMARY KEY REFERENCES resources(id), key_hash text UNIQUE NOT NULL, prefix text NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  name text PRIMARY KEY, version bigint NOT NULL, body jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS endpoint_risk_cooldowns (
  endpoint_id uuid PRIMARY KEY REFERENCES resources(id), blocked_until timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS probes (
  egress_id text PRIMARY KEY, version bigint NOT NULL, body jsonb NOT NULL, generation bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS browser_jobs (
  id uuid PRIMARY KEY, pod_uid text NOT NULL, owner text NOT NULL,
  body jsonb NOT NULL, state text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS requests (
  id uuid PRIMARY KEY, project_id uuid, operation text NOT NULL, origin text NOT NULL,
  started_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  record jsonb NOT NULL, payload jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'running'
);
CREATE INDEX IF NOT EXISTS request_expiration ON requests(expires_at);
CREATE INDEX IF NOT EXISTS request_window ON requests(started_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS request_project ON requests(project_id,started_at DESC);
CREATE TABLE IF NOT EXISTS endpoint_calls (
  id uuid PRIMARY KEY, request_id uuid NOT NULL REFERENCES requests ON DELETE CASCADE,
  finished_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, body jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS call_window ON endpoint_calls(finished_at,id);
CREATE INDEX IF NOT EXISTS call_request ON endpoint_calls(request_id);
CREATE TABLE IF NOT EXISTS materials (
  request_id uuid NOT NULL REFERENCES requests ON DELETE CASCADE,
  material_id uuid NOT NULL, call_id uuid NOT NULL, body jsonb NOT NULL, layout jsonb,
  PRIMARY KEY(request_id,material_id)
);
CREATE TABLE IF NOT EXISTS endpoint_stats_hour (
  bucket_at timestamptz NOT NULL, dimension_hash text NOT NULL, retention_version bigint NOT NULL,
  first_expiry timestamptz NOT NULL, last_expiry timestamptz NOT NULL, metrics jsonb NOT NULL,
  PRIMARY KEY(bucket_at,dimension_hash,retention_version)
);
CREATE TABLE IF NOT EXISTS endpoint_stats_day (LIKE endpoint_stats_hour INCLUDING ALL);
