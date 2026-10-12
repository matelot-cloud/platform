-- Runs once on first Postgres initialisation (docker-entrypoint-initdb.d).
-- Keycloak gets its own database inside the tenant cell's Postgres.
CREATE DATABASE keycloak;
