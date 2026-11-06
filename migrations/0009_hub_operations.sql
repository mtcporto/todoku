-- Hub configuration is independent from mailbox permissions and provider secrets.
CREATE TABLE hub_administrators (
 tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES mail_users(id),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
 PRIMARY KEY(tenant_id,user_id)
);
-- statement-breakpoint
CREATE TABLE hub_applications (
 tenant_id TEXT NOT NULL, application_id TEXT NOT NULL, name TEXT NOT NULL,
 PRIMARY KEY(tenant_id,application_id),
 FOREIGN KEY(tenant_id,application_id) REFERENCES applications(tenant_id,id)
);
-- statement-breakpoint
CREATE TABLE hub_templates (
 tenant_id TEXT NOT NULL, application_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
 subject TEXT NOT NULL, body TEXT NOT NULL, variables_json TEXT NOT NULL CHECK(json_valid(variables_json)),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(tenant_id,application_id,id,version),
 FOREIGN KEY(tenant_id,application_id) REFERENCES hub_applications(tenant_id,application_id)
);
-- statement-breakpoint
CREATE TRIGGER hub_templates_no_update BEFORE UPDATE ON hub_templates BEGIN SELECT RAISE(ABORT,'template versions are immutable'); END;
-- statement-breakpoint
CREATE TRIGGER hub_templates_no_delete BEFORE DELETE ON hub_templates BEGIN SELECT RAISE(ABORT,'template versions are immutable'); END;
-- statement-breakpoint
CREATE TABLE hub_event_bindings (
 tenant_id TEXT NOT NULL, application_id TEXT NOT NULL, event_type TEXT NOT NULL,
 template_id TEXT NOT NULL, template_version INTEGER NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 PRIMARY KEY(tenant_id,application_id,event_type),
 FOREIGN KEY(tenant_id,application_id,template_id,template_version) REFERENCES hub_templates(tenant_id,application_id,id,version)
);
-- statement-breakpoint
CREATE TABLE hub_administration_audit (
 id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id),
 actor_user_id TEXT NOT NULL REFERENCES mail_users(id), application_id TEXT,
 action TEXT NOT NULL, details_json TEXT NOT NULL CHECK(json_valid(details_json)),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 FOREIGN KEY(tenant_id,application_id) REFERENCES applications(tenant_id,id)
);
-- statement-breakpoint
CREATE TRIGGER hub_audit_no_update BEFORE UPDATE ON hub_administration_audit BEGIN SELECT RAISE(ABORT,'hub audit is append-only'); END;
-- statement-breakpoint
CREATE TRIGGER hub_audit_no_delete BEFORE DELETE ON hub_administration_audit BEGIN SELECT RAISE(ABORT,'hub audit is append-only'); END;
