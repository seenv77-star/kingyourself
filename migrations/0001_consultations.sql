CREATE TABLE consultations (
  id TEXT PRIMARY KEY NOT NULL,
  fingerprint TEXT NOT NULL,
  received_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  mime TEXT,
  capture BLOB
) STRICT;

CREATE INDEX consultations_expiry ON consultations(expires_at);
CREATE INDEX consultations_received ON consultations(received_at DESC);
