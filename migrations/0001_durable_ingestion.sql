CREATE TABLE tenants (
  id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- statement-breakpoint
CREATE TABLE applications (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, id)
);
-- statement-breakpoint
CREATE TABLE application_credentials (
  tenant_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  scope TEXT NOT NULL DEFAULT 'events:write' CHECK (scope IN ('events:write', 'disabled')),
  revoked_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, application_id, id),
  FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id)
);
-- statement-breakpoint
CREATE TABLE events (
  tenant_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  id TEXT NOT NULL,
  producer_event_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  event_type TEXT NOT NULL,
  traffic_type TEXT NOT NULL CHECK (traffic_type IN ('transactional', 'marketing')),
  status TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted', 'cancelled')),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, application_id, id),
  UNIQUE (tenant_id, application_id, idempotency_key),
  UNIQUE (tenant_id, application_id, producer_event_id),
  UNIQUE (tenant_id, application_id, id, traffic_type),
  FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id)
);
-- statement-breakpoint
CREATE TABLE outbox_messages (
  tenant_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email' CHECK (channel = 'email'),
  traffic_type TEXT NOT NULL CHECK (traffic_type IN ('transactional', 'marketing')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'retry_wait', 'sent', 'dead', 'cancelled', 'manual_review')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= max_attempts),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  available_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, application_id, id),
  UNIQUE (tenant_id, application_id, event_id, channel),
  FOREIGN KEY (tenant_id, application_id, event_id, traffic_type) REFERENCES events(tenant_id, application_id, id, traffic_type)
);
-- statement-breakpoint
CREATE INDEX outbox_ready_idx ON outbox_messages(tenant_id, application_id, traffic_type, status, available_at);
-- statement-breakpoint
CREATE TABLE delivery_attempts (
  tenant_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  id TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'transient_failure', 'permanent_failure', 'ambiguous')),
  provider_message_id TEXT,
  error_code TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  PRIMARY KEY (tenant_id, application_id, id),
  UNIQUE (tenant_id, application_id, outbox_id, attempt_number),
  FOREIGN KEY (tenant_id, application_id, outbox_id) REFERENCES outbox_messages(tenant_id, application_id, id)
);
-- statement-breakpoint
CREATE TABLE provider_webhook_events (
  tenant_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  outbox_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'rejected')),
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  processed_at TEXT,
  PRIMARY KEY (tenant_id, application_id, id),
  UNIQUE (tenant_id, application_id, provider, provider_event_id),
  FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id),
  FOREIGN KEY (tenant_id, application_id, outbox_id) REFERENCES outbox_messages(tenant_id, application_id, id)
);
-- statement-breakpoint
CREATE TABLE audit_log (
  tenant_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  id TEXT NOT NULL,
  event_id TEXT,
  credential_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('event.accepted')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, application_id, id),
  FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id),
  FOREIGN KEY (tenant_id, application_id, event_id) REFERENCES events(tenant_id, application_id, id),
  FOREIGN KEY (tenant_id, application_id, credential_id) REFERENCES application_credentials(tenant_id, application_id, id)
);
-- statement-breakpoint
CREATE INDEX events_created_idx ON events(tenant_id, application_id, created_at);
-- statement-breakpoint
CREATE INDEX attempts_created_idx ON delivery_attempts(tenant_id, application_id, started_at);
-- statement-breakpoint
CREATE INDEX webhooks_received_idx ON provider_webhook_events(tenant_id, application_id, status, received_at);
-- statement-breakpoint
CREATE INDEX audit_created_idx ON audit_log(tenant_id, application_id, created_at);
-- statement-breakpoint
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
-- statement-breakpoint
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
