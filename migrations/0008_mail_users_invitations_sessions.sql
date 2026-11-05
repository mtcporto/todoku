ALTER TABLE mail_sessions ADD COLUMN session_id TEXT;
-- statement-breakpoint
ALTER TABLE mail_sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'legacy' CHECK(auth_method IN ('legacy','password','google'));
-- statement-breakpoint
UPDATE mail_sessions SET session_id=lower(hex(randomblob(16)));
-- statement-breakpoint
CREATE UNIQUE INDEX mail_session_public_id ON mail_sessions(session_id);
-- statement-breakpoint
-- Compatibility with the previous server, which does not supply these columns.
CREATE TRIGGER mail_session_assign_id AFTER INSERT ON mail_sessions WHEN NEW.session_id IS NULL BEGIN UPDATE mail_sessions SET session_id=lower(hex(randomblob(16))) WHERE token_hash=NEW.token_hash; END;
-- statement-breakpoint
ALTER TABLE mail_auth_audit_log ADD COLUMN details_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(details_json));
-- statement-breakpoint
CREATE TABLE mail_invitations (
 id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id),
 email_normalized TEXT NOT NULL, target_user_id TEXT REFERENCES mail_users(id),
 token_hash TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','revoked','expired')),
 created_by TEXT NOT NULL REFERENCES mail_users(id),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 expires_at TEXT NOT NULL, accepted_at TEXT, accepted_user_id TEXT REFERENCES mail_users(id),
 CHECK((state='accepted' AND accepted_at IS NOT NULL AND accepted_user_id IS NOT NULL) OR (state!='accepted' AND accepted_at IS NULL AND accepted_user_id IS NULL))
);
-- statement-breakpoint
CREATE UNIQUE INDEX mail_invitation_pending_email ON mail_invitations(tenant_id,email_normalized) WHERE state='pending';
-- statement-breakpoint
CREATE INDEX mail_invitation_list ON mail_invitations(tenant_id,id);
