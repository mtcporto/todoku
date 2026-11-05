ALTER TABLE mail_identity_grants ADD COLUMN can_send INTEGER NOT NULL DEFAULT 0 CHECK(can_send IN (0,1));
-- statement-breakpoint
ALTER TABLE mail_identity_grants ADD COLUMN can_manage INTEGER NOT NULL DEFAULT 0 CHECK(can_manage IN (0,1));
-- statement-breakpoint
ALTER TABLE mail_message_recipients ADD COLUMN folder TEXT NOT NULL DEFAULT 'inbox' CHECK(folder IN ('inbox','sent','drafts','trash'));
-- statement-breakpoint
ALTER TABLE mail_message_recipients ADD COLUMN previous_folder TEXT CHECK(previous_folder IN ('inbox','sent','drafts'));
-- statement-breakpoint
ALTER TABLE mail_message_recipients ADD COLUMN trashed_at TEXT;
-- statement-breakpoint
ALTER TABLE mail_message_recipients ADD COLUMN deleted_at TEXT;
-- statement-breakpoint
ALTER TABLE mail_messages ADD COLUMN direction TEXT NOT NULL DEFAULT 'inbound' CHECK(direction IN ('inbound','outbound'));
-- statement-breakpoint
ALTER TABLE mail_messages ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'received' CHECK(delivery_status IN ('received','draft','queued','accepted','delivered','bounced','complained','failed','manual_review'));
-- statement-breakpoint
ALTER TABLE mail_messages ADD COLUMN draft_version INTEGER NOT NULL DEFAULT 1;
-- statement-breakpoint
ALTER TABLE mail_messages ADD COLUMN draft_fingerprint TEXT;
-- statement-breakpoint
CREATE INDEX mail_folder_list ON mail_message_recipients(tenant_id,identity_id,folder,deleted_at,message_id);
-- statement-breakpoint
CREATE TABLE mail_sending_configurations (
 tenant_id TEXT NOT NULL, identity_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'disabled' CHECK(status IN ('enabled','disabled')),
 encrypted_api_key TEXT, encrypted_webhook_secret TEXT, provider_domain_id TEXT,
 allowed_recipients_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(allowed_recipients_json)),
 daily_limit INTEGER NOT NULL DEFAULT 20 CHECK(daily_limit BETWEEN 1 AND 100),
 PRIMARY KEY(tenant_id,identity_id), FOREIGN KEY(tenant_id,identity_id) REFERENCES mail_identities(tenant_id,id)
);
-- statement-breakpoint
CREATE TABLE mail_send_jobs (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, message_id TEXT NOT NULL, identity_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES mail_users(id),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','retry_wait','accepted','failed','manual_review')),
 idempotency_key TEXT NOT NULL UNIQUE, payload_hash TEXT,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5), uncertain INTEGER NOT NULL DEFAULT 0 CHECK(uncertain IN (0,1)),
 provider_id TEXT, first_attempt_at TEXT, available_at TEXT NOT NULL, lease_token TEXT, locked_until TEXT, last_error_code TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,message_id), UNIQUE(tenant_id,identity_id,provider_id),
 FOREIGN KEY(tenant_id,message_id) REFERENCES mail_messages(tenant_id,id), FOREIGN KEY(tenant_id,identity_id) REFERENCES mail_identities(tenant_id,id)
);
-- statement-breakpoint
CREATE INDEX mail_send_ready ON mail_send_jobs(state,available_at);
-- statement-breakpoint
CREATE TABLE mail_send_events (
 tenant_id TEXT NOT NULL, identity_id TEXT NOT NULL, id TEXT NOT NULL, provider_id TEXT NOT NULL, event_type TEXT NOT NULL, message_id TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(tenant_id,identity_id,id), FOREIGN KEY(tenant_id,identity_id) REFERENCES mail_identities(tenant_id,id)
);
-- statement-breakpoint
CREATE TABLE mail_action_limits (
 tenant_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES mail_users(id), action TEXT NOT NULL, attempts INTEGER NOT NULL, resets_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,user_id,action), FOREIGN KEY(tenant_id) REFERENCES tenants(id)
);
