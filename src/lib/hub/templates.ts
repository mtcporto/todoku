import { z } from "zod";
import type { Client, Transaction } from "@libsql/client";
import type { CommunicationEvent } from "../events.ts";
import { escapeHtml, renderTemplate, TemplateError } from "../templates.ts";
import { brandingSchema, httpsUrl, presentationSchema, renderPresentation, type Branding } from "./presentation.ts";

export const templateId = z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/);
export const eventType = z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/).max(120);
export const variableSchema = z.strictObject({ name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,39}$/), type: z.enum(["text", "https_url"]) });
export const templateInput = z.strictObject({
  id: templateId, subject: z.string().trim().min(1).max(200).regex(/^[^\r\n]+$/),
  body: z.string().trim().min(1).max(8000), variables: z.array(variableSchema).max(15),
  presentation: presentationSchema.optional(),
});
export type TemplateInput = z.infer<typeof templateInput>;
const placeholders = (text: string) => [...text.matchAll(/\{\{([a-zA-Z][a-zA-Z0-9]{0,39})\}\}/g)].map(m => m[1]);
export function validateTemplate(input: unknown): TemplateInput {
  const data = templateInput.parse(input);
  const names = data.variables.map(v => v.name);
  const sources = [data.subject, data.body, data.presentation?.heading, data.presentation?.buttonLabel, data.presentation?.buttonUrl, data.presentation?.footer].filter(Boolean).join("\n");
  const fields = placeholders(sources);
  if (new Set(names).size !== names.length || fields.some(name => !names.includes(name)) || names.some(name => !fields.includes(name)) ||
      /\{\{|\}\}/.test(sources.replace(/\{\{[a-zA-Z][a-zA-Z0-9]{0,39}\}\}/g, ""))) throw new TemplateError("invalid_template");
  const buttonUrl = data.presentation?.buttonUrl;
  if (buttonUrl) {
    const variable = data.variables.find(v => buttonUrl === `{{${v.name}}}`);
    if (variable ? variable.type !== "https_url" : placeholders(buttonUrl).length > 0 || !httpsUrl.safeParse(buttonUrl).success) throw new TemplateError("invalid_template");
  }
  return data;
}
const person = { name: "firstName", type: "text" as const };
const action = [{ name: "actionUrl", type: "https_url" as const }, { name: "expiresInMinutes", type: "text" as const }];
export const commonTemplates: (TemplateInput & { eventType: string })[] = [
  { id: "welcome", eventType: "user.welcome", subject: "Boas-vindas", body: "Olá, {{firstName}}! Sua conta está pronta.", variables: [person] },
  { id: "email-verification", eventType: "user.email_verification", subject: "Verifique seu e-mail", body: "Olá, {{firstName}}. Confirme seu e-mail: {{actionUrl}}\nEste link expira em {{expiresInMinutes}} minutos. Se você não solicitou, ignore esta mensagem.", variables: [person, ...action] },
  { id: "password-reset", eventType: "user.password_reset", subject: "Recuperação de senha", body: "Olá, {{firstName}}. Redefina sua senha: {{actionUrl}}\nEste link expira em {{expiresInMinutes}} minutos. Se você não solicitou, ignore esta mensagem.", variables: [person, ...action] },
  { id: "security-alert", eventType: "user.security_alert", subject: "Alerta de segurança", body: "Olá, {{firstName}}. {{message}}", variables: [person, { name: "message", type: "text" }] },
];

export const minhaNotaWelcome = validateTemplate({
  id: "minhanota.welcome", subject: "Boas-vindas ao MinhaNota",
  body: "Olá, {{firstName}}.\n\nSua conta está pronta para começar. Acesse o painel para conectar sua empresa e acompanhar suas notas fiscais de serviço.",
  variables: [person],
  presentation: {
    heading: "Bem-vindo ao MinhaNota!", buttonLabel: "Acessar MinhaNota", buttonUrl: "https://minhanota.app",
    footer: "Se você não reconhece este acesso, ignore esta mensagem.",
  },
});

export function renderManagedTemplate(input: TemplateInput, data: Record<string, unknown>, version: number, branding?: Branding) {
  const template = validateTemplate(input);
  const values: Record<string, string> = Object.create(null);
  if (Object.keys(data).length !== template.variables.length) throw new TemplateError("invalid_template_variables");
  for (const variable of template.variables) {
    const value = data[variable.name];
    if (typeof value !== "string" || !value.trim() || value.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new TemplateError("invalid_template_variables");
    if (variable.type === "https_url" && !httpsUrl.safeParse(value).success) throw new TemplateError("invalid_template_variables");
    values[variable.name] = value;
  }
  const substitute = (text: string) => text.replace(/\{\{([a-zA-Z][a-zA-Z0-9]{0,39})\}\}/g, (_, name: string) => values[name]);
  const subject = substitute(template.subject);
  if (/[\r\n]/.test(subject) || subject.length > 500) throw new TemplateError("invalid_template_variables");
  const text = substitute(template.body);
  // No user-supplied HTML, scripts, helpers, remote includes or expression evaluation.
  const htmlBody = escapeHtml(template.body).replace(/\{\{([a-zA-Z][a-zA-Z0-9]{0,39})\}\}/g, (_, name: string) => {
    const safe = escapeHtml(values[name]);
    return template.variables.find(v => v.name === name)?.type === "https_url" ? `<a href="${safe}">${safe}</a>` : safe;
  }).replaceAll("\n", "<br>");
  if (template.presentation) {
    const p = template.presentation;
    const presentation = {
      heading: substitute(p.heading), footer: substitute(p.footer),
      ...(p.buttonLabel ? { buttonLabel: substitute(p.buttonLabel), buttonUrl: substitute(p.buttonUrl!) } : {}),
    };
    if (!presentationSchema.safeParse(presentation).success || (presentation.buttonUrl && !httpsUrl.safeParse(presentation.buttonUrl).success)) throw new TemplateError("invalid_template_variables");
    return { templateVersion: `${template.id}@${version}`, subject, ...renderPresentation(subject, htmlBody, text, presentation, branding ?? brandingSchema.parse({ name: "Todoku" })) };
  }
  return { templateVersion: `${template.id}@${version}`, subject, text,
    html: `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(subject)}</title></head><body style="font-family:Arial,sans-serif;font-size:16px;line-height:1.5;color:#172033"><main style="max-width:560px;margin:auto;padding:24px"><h1>${escapeHtml(subject)}</h1><p>${htmlBody}</p></main></body></html>` };
}

export async function resolveTemplate(db: Pick<Client, "execute"> | Transaction, event: CommunicationEvent) {
  const ready = (await db.execute("SELECT 1 FROM schema_migrations WHERE version='0009_hub_operations'")).rows.length;
  if (!ready) return renderTemplate(event);
  // Existing applications keep their exact legacy contract until explicitly adopting the catalog.
  const managed = (await db.execute({ sql: "SELECT 1 FROM hub_applications WHERE tenant_id=? AND application_id=?", args: [event.tenantId, event.applicationId] })).rows.length;
  if (!managed) return renderTemplate(event);
  const visual = (await db.execute("SELECT 1 FROM schema_migrations WHERE version='0010_hub_template_catalog'")).rows.length > 0;
  const row = (await db.execute({ sql: `SELECT b.enabled,t.id,t.version,t.subject,t.body,t.variables_json${visual ? ",t.presentation_json,h.branding_json,h.name AS application_name" : ""} FROM hub_event_bindings b
    JOIN hub_templates t ON t.tenant_id=b.tenant_id AND t.application_id=b.application_id AND t.id=b.template_id AND t.version=b.template_version
    ${visual ? "JOIN hub_applications h ON h.tenant_id=b.tenant_id AND h.application_id=b.application_id" : ""}
    WHERE b.tenant_id=? AND b.application_id=? AND b.event_type=?`, args: [event.tenantId, event.applicationId, event.type] })).rows[0];
  if (!row) throw new TemplateError("template_not_found");
  if (!Number(row.enabled)) throw new TemplateError("communication_disabled");
  return renderManagedTemplate({
    id: String(row.id), subject: String(row.subject), body: String(row.body), variables: JSON.parse(String(row.variables_json)),
    ...(visual && row.presentation_json ? { presentation: JSON.parse(String(row.presentation_json)) } : {}),
  }, event.data, Number(row.version), visual ? brandingSchema.parse(row.branding_json ? JSON.parse(String(row.branding_json)) : { name: String(row.application_name) }) : undefined);
}
