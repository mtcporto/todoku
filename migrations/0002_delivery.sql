CREATE TABLE provider_configurations (
  tenant_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'resend' CHECK (provider = 'resend'),
  mode TEXT NOT NULL DEFAULT 'dry_run' CHECK (mode IN ('dry_run', 'test')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  sender_email TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  domain TEXT NOT NULL,
  domain_verified_at TEXT,
  encrypted_api_key TEXT CHECK (encrypted_api_key IS NULL OR json_valid(encrypted_api_key)),
  encrypted_webhook_secret TEXT CHECK (encrypted_webhook_secret IS NULL OR json_valid(encrypted_webhook_secret)),
  webhook_revoked_at TEXT,
  allowed_recipients TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowed_recipients)),
  send_limit INTEGER NOT NULL DEFAULT 1 CHECK (send_limit BETWEEN 0 AND 5),
  send_count INTEGER NOT NULL DEFAULT 0 CHECK (send_count >= 0 AND send_count <= send_limit),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at TEXT,
  PRIMARY KEY (tenant_id, application_id, id),
  FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id),
  CHECK (mode = 'dry_run' OR (encrypted_api_key IS NOT NULL AND encrypted_webhook_secret IS NOT NULL AND domain_verified_at IS NOT NULL AND json_array_length(allowed_recipients) > 0))
);
-- statement-breakpoint
CREATE UNIQUE INDEX provider_active_scope_idx ON provider_configurations(tenant_id, application_id) WHERE status = 'active';
-- statement-breakpoint
ALTER TABLE outbox_messages ADD COLUMN lease_token TEXT;
-- statement-breakpoint
CREATE TABLE message_deliveries (
  tenant_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  configuration_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('dry_run', 'test')),
  template_version TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'dry_run', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'suppressed', 'manual_review')),
  provider_message_id TEXT,
  first_attempt_at TEXT,
  budget_reserved INTEGER NOT NULL DEFAULT 0 CHECK (budget_reserved IN (0, 1)),
  last_error_code TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, application_id, outbox_id),
  UNIQUE (configuration_id, provider_message_id),
  FOREIGN KEY (tenant_id, application_id, outbox_id) REFERENCES outbox_messages(tenant_id, application_id, id),
  FOREIGN KEY (tenant_id, application_id, configuration_id) REFERENCES provider_configurations(tenant_id, application_id, id)
);
-- statement-breakpoint
CREATE TABLE delivery_audit_log (
  tenant_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  id TEXT NOT NULL,
  outbox_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('claimed', 'dry_run', 'sent', 'retry_scheduled', 'failed', 'manual_review', 'lease_expired', 'webhook', 'configuration_created', 'configuration_revoked', 'key_reencrypted')),
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, application_id, id),
  FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id),
  FOREIGN KEY (tenant_id, application_id, outbox_id) REFERENCES outbox_messages(tenant_id, application_id, id)
);
-- statement-breakpoint
CREATE INDEX delivery_audit_scope_idx ON delivery_audit_log(tenant_id, application_id, created_at);
-- statement-breakpoint
CREATE TRIGGER delivery_audit_no_update BEFORE UPDATE ON delivery_audit_log BEGIN SELECT RAISE(ABORT, 'delivery audit is append-only'); END;
-- statement-breakpoint
CREATE TRIGGER delivery_audit_no_delete BEFORE DELETE ON delivery_audit_log BEGIN SELECT RAISE(ABORT, 'delivery audit is append-only'); END;
-- statement-breakpoint
CREATE TABLE recipient_suppressions (
  tenant_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  email TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('bounced', 'complained', 'suppressed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, application_id, email),
  FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id)
);
-- statement-breakpoint
ALTER TABLE provider_webhook_events ADD COLUMN configuration_id TEXT REFERENCES provider_configurations(id);
-- statement-breakpoint
CREATE INDEX webhooks_reconcile_idx ON provider_webhook_events(tenant_id, application_id, configuration_id, status);
-- statement-breakpoint
CREATE INDEX worker_ready_idx ON outbox_messages(traffic_type, status, available_at);
