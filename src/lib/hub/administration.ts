import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Client, Transaction } from "@libsql/client";
import { requireUser } from "../mail/auth.ts";
import { MailError, transaction } from "../mail/common.ts";
import { commonTemplates, eventType, renderManagedTemplate, templateId, validateTemplate } from "./templates.ts";
import { TemplateError } from "../templates.ts";
import { hashCredential } from "../ingestion.ts";

type Sql = Pick<Client, "execute"> | Transaction;
export const scopeId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export async function requireHubAdministrator(db: Sql, request: Request, tenantId: string) {
  const user = await requireUser(db, request);
  const allowed = (await db.execute({ sql: `SELECT 1 FROM hub_administrators h JOIN tenants t ON t.id=h.tenant_id
    WHERE h.tenant_id=? AND h.user_id=? AND h.status='active' AND t.status='active'`, args: [tenantId, user.id] })).rows.length;
  if (!allowed) throw new MailError("hub_forbidden", 403);
  return user;
}
export async function hubAudit(db: Sql, tenant: string, actor: string, application: string | null, action: string, details: Record<string, unknown> = {}) {
  await db.execute({ sql: "INSERT INTO hub_administration_audit(id,tenant_id,actor_user_id,application_id,action,details_json) VALUES (?,?,?,?,?,?)",
    args: [randomUUID(), tenant, actor, application, action, JSON.stringify(details)] });
}
export async function bootstrapHubAdministrator(db: Client, tenant: string, user: string, actor: string, confirmed: boolean) {
  if (!confirmed || !z.uuid().safeParse(user).success || !z.uuid().safeParse(actor).success || !scopeId.safeParse(tenant).success) throw new MailError("bootstrap_not_authorized", 403);
  return transaction(db, async tx => {
    const valid = (await tx.execute({ sql: `SELECT 1 FROM tenants t,mail_users u,mail_users actor
      WHERE t.id=? AND t.status='active' AND u.id=? AND u.status='active' AND actor.id=? AND actor.status='active'`, args: [tenant, user, actor] })).rows.length;
    if (!valid) throw new MailError("bootstrap_not_authorized", 403);
    await tx.execute({ sql: "INSERT INTO hub_administrators(tenant_id,user_id) VALUES (?,?) ON CONFLICT(tenant_id,user_id) DO UPDATE SET status='active'", args: [tenant, user] });
    await hubAudit(tx, tenant, actor, null, "administrator.bootstrapped", { userId: user });
    return { configured: true };
  });
}
async function requireApplication(db: Sql, tenant: string, application: string) {
  if (!(await db.execute({ sql: "SELECT 1 FROM applications WHERE tenant_id=? AND id=? AND status='active'", args: [tenant, application] })).rows.length) throw new MailError("application_unavailable", 404);
}
async function adoptCatalog(tx: Sql, tenant: string, application: string, name: string) {
  await tx.execute({ sql: "INSERT INTO hub_applications(tenant_id,application_id,name) VALUES (?,?,?)", args: [tenant, application, name] });
  for (const item of commonTemplates) {
    await tx.execute({ sql: "INSERT INTO hub_templates(tenant_id,application_id,id,version,subject,body,variables_json) VALUES (?,?,?,1,?,?,?)",
      args: [tenant, application, item.id, item.subject, item.body, JSON.stringify(item.variables)] });
    await tx.execute({ sql: "INSERT INTO hub_event_bindings(tenant_id,application_id,event_type,template_id,template_version) VALUES (?,?,?,?,1)", args: [tenant, application, item.eventType, item.id] });
  }
}
export async function mutateHub(db: Client, request: Request, tenant: string, application: string | undefined, operation: string, input: unknown) {
  return transaction(db, async tx => {
    // Check the live session and Hub scope again in the transaction that commits the mutation.
    const actor = await requireHubAdministrator(tx, request, tenant);
    if (operation === "create-application") {
      const value = z.strictObject({ id: scopeId, name: z.string().trim().min(1).max(100), senderConfigurationId: z.uuid() }).parse(input);
      const sender = (await tx.execute({ sql: `SELECT c.sender_email,c.sender_name FROM provider_configurations c JOIN applications a ON a.tenant_id=c.tenant_id AND a.id=c.application_id
        WHERE c.tenant_id=? AND c.id=? AND c.status='active' AND a.status='active'`, args: [tenant, value.senderConfigurationId] })).rows[0];
      if (!sender) throw new MailError("sender_configuration_unavailable", 422);
      if ((await tx.execute({ sql: "SELECT 1 FROM applications WHERE tenant_id=? AND id=?", args: [tenant, value.id] })).rows.length) throw new MailError("application_exists", 409);
      await tx.execute({ sql: "INSERT INTO applications(tenant_id,id) VALUES (?,?)", args: [tenant, value.id] });
      // Reuse ONLY sender metadata; encrypted secrets are bound to their original application.
      // A new application is dry-run. This endpoint cannot enable real sending or move BYOK.
      await tx.execute({ sql: "INSERT INTO provider_configurations(tenant_id,application_id,id,sender_email,sender_name,domain) VALUES (?,?,?,?,?,?)",
        args: [tenant, value.id, randomUUID(), sender.sender_email, sender.sender_name, String(sender.sender_email).split("@")[1]] });
      await adoptCatalog(tx, tenant, value.id, value.name);
      const token = randomBytes(32).toString("base64url");
      const credentialId = randomUUID();
      await tx.execute({ sql: "INSERT INTO application_credentials(tenant_id,application_id,id,token_hash) VALUES (?,?,?,?)", args: [tenant, value.id, credentialId, hashCredential(token)] });
      await hubAudit(tx, tenant, actor.id, value.id, "application.created", { senderConfigurationId: value.senderConfigurationId, mode: "dry_run" });
      await hubAudit(tx, tenant, actor.id, value.id, "credential.created", { credentialId });
      return { created: true, applicationId: value.id, token };
    }
    if (!application) throw new MailError("not_found", 404);
    await requireApplication(tx, tenant, application);
    if (operation === "adopt-catalog") {
      const value = z.strictObject({ name: z.string().trim().min(1).max(100) }).parse(input);
      if ((await tx.execute({ sql: "SELECT 1 FROM hub_applications WHERE tenant_id=? AND application_id=?", args: [tenant, application] })).rows.length) throw new MailError("catalog_exists", 409);
      await adoptCatalog(tx, tenant, application, value.name);
      await hubAudit(tx, tenant, actor.id, application, "catalog.adopted", { communicationsEnabled: false });
      return { adopted: true };
    }
    if (!(await tx.execute({ sql: "SELECT 1 FROM hub_applications WHERE tenant_id=? AND application_id=?", args: [tenant, application] })).rows.length) throw new MailError("catalog_not_adopted", 422);
    if (operation === "template") {
      const value = validateTemplate(input);
      const version = Number((await tx.execute({ sql: "SELECT COALESCE(MAX(version),0)+1 AS next FROM hub_templates WHERE tenant_id=? AND application_id=? AND id=?", args: [tenant, application, value.id] })).rows[0].next);
      await tx.execute({ sql: "INSERT INTO hub_templates(tenant_id,application_id,id,version,subject,body,variables_json) VALUES (?,?,?,?,?,?,?)",
        args: [tenant, application, value.id, version, value.subject, value.body, JSON.stringify(value.variables)] });
      await hubAudit(tx, tenant, actor.id, application, "template.versioned", { templateId: value.id, version });
      return { templateId: value.id, version };
    }
    if (operation === "binding") {
      const value = z.strictObject({ eventType, templateId, templateVersion: z.int().min(1), enabled: z.boolean() }).parse(input);
      const template = (await tx.execute({ sql: "SELECT 1 FROM hub_templates WHERE tenant_id=? AND application_id=? AND id=? AND version=?", args: [tenant, application, value.templateId, value.templateVersion] })).rows.length;
      if (!template) throw new MailError("template_not_found", 422);
      await tx.execute({ sql: `INSERT INTO hub_event_bindings(tenant_id,application_id,event_type,template_id,template_version,enabled) VALUES (?,?,?,?,?,?)
        ON CONFLICT(tenant_id,application_id,event_type) DO UPDATE SET template_id=excluded.template_id,template_version=excluded.template_version,enabled=excluded.enabled`,
        args: [tenant, application, value.eventType, value.templateId, value.templateVersion, Number(value.enabled)] });
      await hubAudit(tx, tenant, actor.id, application, "communication.updated", value);
      return { updated: true };
    }
    if (operation === "preview") {
      const value = z.strictObject({ templateId, templateVersion: z.int().min(1), data: z.record(z.string(), z.unknown()) }).parse(input);
      const row = (await tx.execute({ sql: "SELECT id,subject,body,variables_json FROM hub_templates WHERE tenant_id=? AND application_id=? AND id=? AND version=?", args: [tenant, application, value.templateId, value.templateVersion] })).rows[0];
      if (!row) throw new TemplateError("template_not_found");
      const rendered = renderManagedTemplate({ id: String(row.id), subject: String(row.subject), body: String(row.body), variables: JSON.parse(String(row.variables_json)) }, value.data, value.templateVersion);
      // Preview creates no event, queue entry, credential or delivery.
      return { templateVersion: rendered.templateVersion, subject: rendered.subject, text: rendered.text };
    }
    throw new MailError("not_found", 404);
  });
}

export async function hubCatalog(db: Sql, tenant: string, application?: string) {
  const applications = (await db.execute({ sql: `SELECT a.id,a.status,h.name,CASE WHEN h.application_id IS NULL THEN 0 ELSE 1 END AS managed,
    c.id AS configurationId,c.mode,c.domain,c.sender_email AS senderEmail,c.sender_name AS senderName
    FROM applications a LEFT JOIN hub_applications h ON h.tenant_id=a.tenant_id AND h.application_id=a.id
    LEFT JOIN provider_configurations c ON c.tenant_id=a.tenant_id AND c.application_id=a.id AND c.status='active'
    WHERE a.tenant_id=? ORDER BY a.id LIMIT 201`, args: [tenant] })).rows;
  if (applications.length > 200) throw new MailError("catalog_limit_reached", 422);
  if (!application) return { applications };
  await requireApplication(db, tenant, application);
  const args = [tenant, application];
  const templates = (await db.execute({ sql: "SELECT id,version,subject,body,variables_json AS variables FROM hub_templates WHERE tenant_id=? AND application_id=? ORDER BY id,version DESC LIMIT 201", args })).rows;
  const bindings = (await db.execute({ sql: "SELECT event_type AS eventType,template_id AS templateId,template_version AS templateVersion,enabled FROM hub_event_bindings WHERE tenant_id=? AND application_id=? ORDER BY event_type LIMIT 201", args })).rows;
  if (templates.length > 200 || bindings.length > 200) throw new MailError("catalog_limit_reached", 422);
  return { applications, templates: templates.map(row => ({ ...row, variables: JSON.parse(String(row.variables)) })), bindings };
}
