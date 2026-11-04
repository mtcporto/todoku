import { z } from "zod";
import type { CommunicationEvent } from "./events.ts";

export class TemplateError extends Error {}
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
export function renderTemplate(event: CommunicationEvent) {
  let subject: string;
  let text: string;
  try {
    switch (event.type) {
      case "user.welcome": {
        const data = z.strictObject({ firstName: z.string().trim().min(1).max(100) }).parse(event.data);
        subject = "Boas-vindas";
        text = `Olá, ${data.firstName}! Sua conta está pronta.`;
        break;
      }
      case "system.validation": {
        const data = z.strictObject({ synthetic: z.literal(true), purpose: z.string().max(200) }).parse(event.data);
        subject = "Todoku — validação de integração";
        text = `Validação sintética do Todoku: ${data.purpose}.`;
        break;
      }
      case "system.delivery_test": {
        const data = z.strictObject({ message: z.string().min(1).max(500) }).parse(event.data);
        subject = "Todoku — teste de entrega";
        text = data.message;
        break;
      }
      default: throw new TemplateError("template_not_found");
    }
  } catch (error) {
    if (error instanceof TemplateError) throw error;
    throw new TemplateError("invalid_template_variables");
  }
  return { templateVersion: `${event.type}@1`, subject, text,
    html: `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head><body><main><h1>${escapeHtml(subject)}</h1><p>${escapeHtml(text)}</p><p>Todoku · Communication Hub</p></main></body></html>` };
}
