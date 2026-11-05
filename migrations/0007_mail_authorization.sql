-- Membership is independent from authentication and from access to mailbox content.
CREATE TABLE mail_memberships (
 tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES mail_users(id),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(tenant_id,user_id)
);
-- statement-breakpoint
INSERT INTO mail_memberships(tenant_id,user_id) SELECT DISTINCT tenant_id,user_id FROM mail_identity_grants;
-- statement-breakpoint
ALTER TABLE mail_identity_grants ADD COLUMN can_read INTEGER NOT NULL DEFAULT 0 CHECK(can_read IN (0,1));
-- statement-breakpoint
-- Preserve the explicit equivalent of the historical grant-presence read permission.
UPDATE mail_identity_grants SET can_read=1;
-- statement-breakpoint
CREATE TABLE mail_admin_grants (
 id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
 scope TEXT NOT NULL CHECK(scope IN ('organization','domain','mailbox')),
 domain_id TEXT, identity_id TEXT,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 FOREIGN KEY(tenant_id,user_id) REFERENCES mail_memberships(tenant_id,user_id),
 FOREIGN KEY(tenant_id,domain_id) REFERENCES mail_domains(tenant_id,id),
 FOREIGN KEY(tenant_id,identity_id) REFERENCES mail_identities(tenant_id,id),
 CHECK((scope='organization' AND domain_id IS NULL AND identity_id IS NULL)
 OR (scope='domain' AND domain_id IS NOT NULL AND identity_id IS NULL)
 OR (scope='mailbox' AND domain_id IS NULL AND identity_id IS NOT NULL))
);
-- statement-breakpoint
CREATE UNIQUE INDEX mail_admin_organization ON mail_admin_grants(tenant_id,user_id) WHERE scope='organization';
-- statement-breakpoint
CREATE UNIQUE INDEX mail_admin_domain ON mail_admin_grants(tenant_id,user_id,domain_id) WHERE scope='domain';
-- statement-breakpoint
CREATE UNIQUE INDEX mail_admin_mailbox ON mail_admin_grants(tenant_id,user_id,identity_id) WHERE scope='mailbox';
-- statement-breakpoint
CREATE TABLE mail_administration_audit (
 tenant_id TEXT NOT NULL REFERENCES tenants(id), id TEXT PRIMARY KEY NOT NULL,
 actor_user_id TEXT NOT NULL REFERENCES mail_users(id), target_user_id TEXT REFERENCES mail_users(id),
 action TEXT NOT NULL, details_json TEXT NOT NULL CHECK(json_valid(details_json)),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- statement-breakpoint
CREATE TRIGGER mail_administration_audit_no_update BEFORE UPDATE ON mail_administration_audit BEGIN SELECT RAISE(ABORT,'append-only audit'); END;
-- statement-breakpoint
CREATE TRIGGER mail_administration_audit_no_delete BEFORE DELETE ON mail_administration_audit BEGIN SELECT RAISE(ABORT,'append-only audit'); END;
-- statement-breakpoint
ALTER TABLE mail_messages ADD COLUMN author_user_id TEXT REFERENCES mail_users(id);
-- statement-breakpoint
UPDATE mail_messages SET author_user_id=(SELECT j.user_id FROM mail_send_jobs j WHERE j.tenant_id=mail_messages.tenant_id AND j.message_id=mail_messages.id LIMIT 1) WHERE direction='outbound';
-- statement-breakpoint
-- Infer legacy draft authors only when there is exactly one possible sender.
-- Ambiguous legacy drafts retain their previous read+send access, without inventing an owner.
UPDATE mail_messages SET author_user_id=(SELECT MIN(g.user_id) FROM mail_message_recipients r JOIN mail_identity_grants g ON g.tenant_id=r.tenant_id AND g.identity_id=r.identity_id WHERE r.tenant_id=mail_messages.tenant_id AND r.message_id=mail_messages.id AND g.can_send=1)
WHERE direction='outbound' AND delivery_status='draft' AND author_user_id IS NULL AND
 (SELECT COUNT(DISTINCT g.user_id) FROM mail_message_recipients r JOIN mail_identity_grants g ON g.tenant_id=r.tenant_id AND g.identity_id=r.identity_id WHERE r.tenant_id=mail_messages.tenant_id AND r.message_id=mail_messages.id AND g.can_send=1)=1;
