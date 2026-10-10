-- The built-in CLI client is a real row: oauth_codes / oauth_refresh_tokens reference oauth_clients(id).
INSERT INTO "oauth_clients" ("id", "name", "redirect_uris") VALUES ('matelot-cli', 'matelot CLI', '{loopback}') ON CONFLICT ("id") DO NOTHING;
