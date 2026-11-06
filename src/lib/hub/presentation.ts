import { z } from "zod";
import { escapeHtml } from "../templates.ts";

export const httpsUrl = z.string().max(2000).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !/[\x00-\x20\x7f]/.test(value);
  } catch { return false; }
}, "Use uma URL HTTPS sem credenciais.");
const optionalUrl = z.union([z.literal(""), httpsUrl]).default("");
export const brandingSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).regex(/^[^\r\n]+$/),
  logoUrl: optionalUrl, primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#163b73"),
  backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#f4f6f9"),
  websiteUrl: optionalUrl, supportUrl: optionalUrl, signature: z.string().trim().max(500).default(""),
});
export type Branding = z.infer<typeof brandingSchema>;
export const presentationSchema = z.strictObject({
  heading: z.string().trim().min(1).max(300),
  buttonLabel: z.string().trim().min(1).max(100).optional(),
  buttonUrl: z.string().trim().min(1).max(2000).optional(),
  footer: z.string().trim().max(1000).default(""),
}).refine(value => Boolean(value.buttonLabel) === Boolean(value.buttonUrl), "Informe o texto e o link do botão juntos.");
export type Presentation = z.infer<typeof presentationSchema>;

export function renderPresentation(subject: string, bodyHtml: string, bodyText: string, presentation: Presentation, branding: Branding) {
  const p = presentationSchema.parse(presentation), b = brandingSchema.parse(branding);
  if (p.buttonUrl) httpsUrl.parse(p.buttonUrl);
  const logo = b.logoUrl ? `<img src="${escapeHtml(b.logoUrl)}" alt="${escapeHtml(b.name)}" width="160" style="max-width:160px;height:auto;border:0">` : escapeHtml(b.name);
  const button = p.buttonUrl ? `<p style="margin:28px 0"><a href="${escapeHtml(p.buttonUrl)}" style="display:inline-block;padding:12px 18px;background:${b.primaryColor};color:#fff;text-decoration:none;border-radius:8px;font-weight:bold">${escapeHtml(p.buttonLabel!)}</a></p>` : "";
  const footer = [p.footer, b.signature].filter(Boolean).map(line => `<p>${escapeHtml(line).replaceAll("\n", "<br>")}</p>`).join("");
  const links = [[b.websiteUrl, "Site"], [b.supportUrl, "Suporte"]].filter(([url]) => url).map(([url, label]) => `<a href="${escapeHtml(url)}" style="color:${b.primaryColor}">${label}</a>`).join(" · ");
  const text = [p.heading, bodyText, p.buttonUrl ? `${p.buttonLabel}: ${p.buttonUrl}` : "", p.footer, b.signature, b.websiteUrl, b.supportUrl].filter(Boolean).join("\n\n");
  return {
    text,
    html: `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head><body style="margin:0;padding:16px;background:${b.backgroundColor};font-family:Arial,sans-serif;color:#172033;line-height:1.6"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border-radius:12px"><tr><td style="padding:24px;overflow-wrap:anywhere"><div style="font-size:18px;font-weight:bold;color:${b.primaryColor};margin-bottom:24px">${logo}</div><h1 style="font-size:26px;line-height:1.3;color:${b.primaryColor}">${escapeHtml(p.heading)}</h1><p>${bodyHtml}</p>${button}<div style="margin-top:32px;border-top:1px solid #e4e7ec;padding-top:16px;color:#667085;font-size:13px">${footer}${links ? `<p>${links}</p>` : ""}</div></td></tr></table></td></tr></table></body></html>`,
  };
}
