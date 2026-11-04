CREATE TABLE mail_users (
 id TEXT PRIMARY KEY NOT NULL, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- statement-breakpoint
CREATE TABLE mail_sessions (
 token_hash TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES mail_users(id),
 expires_at TEXT NOT NULL, revoked_at TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- statement-breakpoint
CREATE TABLE mail_login_limits (bucket TEXT PRIMARY KEY NOT NULL, attempts INTEGER NOT NULL CHECK(attempts>=0), resets_at TEXT NOT NULL);
-- statement-breakpoint
CREATE TABLE mail_sources (
 tenant_id TEXT NOT NULL REFERENCES tenants(id), id TEXT NOT NULL UNIQUE,
 provider TEXT NOT NULL DEFAULT 'resend' CHECK(provider IN ('resend','fixture')),
 status TEXT NOT NULL DEFAULT 'disabled' CHECK(status IN ('active','disabled')),
 encrypted_api_key TEXT, encrypted_webhook_secret TEXT,
 retention_days INTEGER NOT NULL DEFAULT 30 CHECK(retention_days BETWEEN 1 AND 90),
 daily_limit INTEGER NOT NULL DEFAULT 100 CHECK(daily_limit BETWEEN 1 AND 1000),
 PRIMARY KEY(tenant_id,id)
);
-- statement-breakpoint
CREATE TABLE mail_domains (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT NOT NULL,
 name TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'disabled' CHECK(status IN ('active','disabled')),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,source_id) REFERENCES mail_sources(tenant_id,id),
 UNIQUE(tenant_id,id,source_id)
);
-- statement-breakpoint
CREATE TABLE mail_identities (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, domain_id TEXT NOT NULL, address TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'disabled' CHECK(status IN ('active','disabled')),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,domain_id) REFERENCES mail_domains(tenant_id,id)
);
-- statement-breakpoint
CREATE TABLE mail_identity_grants (
 tenant_id TEXT NOT NULL, identity_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES mail_users(id),
 PRIMARY KEY(tenant_id,identity_id,user_id), FOREIGN KEY(tenant_id,identity_id) REFERENCES mail_identities(tenant_id,id)
);
-- statement-breakpoint
CREATE TABLE mail_ingestion_events (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT NOT NULL, provider_event_id TEXT NOT NULL, provider_email_id TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','retry_wait','completed','rejected','failed')),
 targets_json TEXT NOT NULL CHECK(json_valid(targets_json)), attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 available_at TEXT NOT NULL, lease_token TEXT, locked_until TEXT, last_error_code TEXT,
 received_at TEXT NOT NULL, PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,source_id,provider_event_id), UNIQUE(tenant_id,source_id,provider_email_id),
 FOREIGN KEY(tenant_id,source_id) REFERENCES mail_sources(tenant_id,id)
);
-- statement-breakpoint
CREATE INDEX mail_jobs_ready ON mail_ingestion_events(state,available_at);
-- statement-breakpoint
CREATE INDEX mail_jobs_quota ON mail_ingestion_events(tenant_id,source_id,received_at);
-- statement-breakpoint
CREATE TABLE mail_objects (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL DEFAULT 'staged' CHECK(state IN ('staged','ready','deleted')),
 expires_at TEXT NOT NULL, PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,source_id) REFERENCES mail_sources(tenant_id,id)
);
-- statement-breakpoint
CREATE INDEX mail_objects_expiry ON mail_objects(state,expires_at);
-- statement-breakpoint
CREATE TABLE mail_messages (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT NOT NULL, provider_email_id TEXT NOT NULL,
 message_id TEXT, sender TEXT NOT NULL, subject TEXT NOT NULL, preview TEXT NOT NULL, authentication TEXT NOT NULL,
 content_object_id TEXT NOT NULL, raw_object_id TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','expired')), received_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,source_id,provider_email_id),
 FOREIGN KEY(tenant_id,source_id) REFERENCES mail_sources(tenant_id,id),
 FOREIGN KEY(tenant_id,content_object_id) REFERENCES mail_objects(tenant_id,id),
 FOREIGN KEY(tenant_id,raw_object_id) REFERENCES mail_objects(tenant_id,id)
);
-- statement-breakpoint
CREATE INDEX mail_messages_list ON mail_messages(tenant_id,received_at DESC,id);
-- statement-breakpoint
CREATE INDEX mail_messages_reference ON mail_messages(tenant_id,message_id);
-- statement-breakpoint
CREATE TABLE mail_threads (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, identity_id TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,id,identity_id),
 FOREIGN KEY(tenant_id,identity_id) REFERENCES mail_identities(tenant_id,id)
);
-- statement-breakpoint
CREATE TABLE mail_message_recipients (
 tenant_id TEXT NOT NULL, message_id TEXT NOT NULL, identity_id TEXT NOT NULL, thread_id TEXT NOT NULL,
 is_read INTEGER NOT NULL DEFAULT 0 CHECK(is_read IN (0,1)),
 PRIMARY KEY(tenant_id,message_id,identity_id),
 FOREIGN KEY(tenant_id,message_id) REFERENCES mail_messages(tenant_id,id),
 FOREIGN KEY(tenant_id,identity_id) REFERENCES mail_identities(tenant_id,id),
 FOREIGN KEY(tenant_id,thread_id,identity_id) REFERENCES mail_threads(tenant_id,id,identity_id)
);
-- statement-breakpoint
CREATE INDEX mail_recipient_list ON mail_message_recipients(tenant_id,identity_id,message_id);
-- statement-breakpoint
CREATE TABLE mail_attachments (
 tenant_id TEXT NOT NULL, id TEXT NOT NULL, message_id TEXT NOT NULL, object_id TEXT NOT NULL,
 filename TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL CHECK(size BETWEEN 0 AND 3145728),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,message_id) REFERENCES mail_messages(tenant_id,id),
 FOREIGN KEY(tenant_id,object_id) REFERENCES mail_objects(tenant_id,id)
);
-- statement-breakpoint
CREATE TABLE mail_audit_log (
 tenant_id TEXT NOT NULL REFERENCES tenants(id), id TEXT NOT NULL, source_id TEXT, event_id TEXT,
 action TEXT NOT NULL, code TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,source_id) REFERENCES mail_sources(tenant_id,id)
);
-- statement-breakpoint
CREATE TRIGGER mail_audit_no_update BEFORE UPDATE ON mail_audit_log BEGIN SELECT RAISE(ABORT,'append-only audit'); END;
-- statement-breakpoint
CREATE TRIGGER mail_audit_no_delete BEFORE DELETE ON mail_audit_log BEGIN SELECT RAISE(ABORT,'append-only audit'); END;
