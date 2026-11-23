-- Master key generation 1 is retained across ordinary Helm upgrades.
ALTER TABLE resources ADD COLUMN secret_key_version smallint NOT NULL DEFAULT 1 CHECK (secret_key_version > 0);
