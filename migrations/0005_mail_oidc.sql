-- Authentication is global to an immutable internal user, independent of mailbox grants.
CREATE TABLE mail_auth_identities (
 id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES mail_users(id),
 provider TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL,
 verified_email TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(provider,issuer,subject), UNIQUE(user_id,provider,issuer)
);
-- statement-breakpoint
CREATE TABLE mail_oidc_attempts (
 token_hash TEXT PRIMARY KEY NOT NULL, state_hash TEXT NOT NULL,
 encrypted_context TEXT NOT NULL,
 link_user_id TEXT REFERENCES mail_users(id), link_session_hash TEXT,
 expires_at TEXT NOT NULL,
 CHECK((link_user_id IS NULL) = (link_session_hash IS NULL))
);
-- statement-breakpoint
CREATE INDEX mail_oidc_attempt_expiry ON mail_oidc_attempts(expires_at);
-- statement-breakpoint
CREATE TABLE mail_auth_audit_log (
 id TEXT PRIMARY KEY NOT NULL, user_id TEXT REFERENCES mail_users(id),
 provider TEXT NOT NULL, action TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- statement-breakpoint
CREATE TRIGGER mail_auth_audit_no_update BEFORE UPDATE ON mail_auth_audit_log BEGIN SELECT RAISE(ABORT,'append-only audit'); END;
-- statement-breakpoint
CREATE TRIGGER mail_auth_audit_no_delete BEFORE DELETE ON mail_auth_audit_log BEGIN SELECT RAISE(ABORT,'append-only audit'); END;
