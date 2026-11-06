import { commonTemplates, minhaNotaWelcome, validateTemplate, type TemplateInput } from "./templates.ts";

export type CatalogModel = TemplateInput & {
  eventType: string; title: string; purpose: string; exampleData: Record<string, string>; defaultSelected: boolean;
};
const text = (name: string) => ({ name, type: "text" as const });
const url = (name: string) => ({ name, type: "https_url" as const });
function model(id: string, eventType: string, title: string, body: string, variables: TemplateInput["variables"], exampleData: Record<string, string>, action = false): CatalogModel {
  return {
    ...validateTemplate({ id, subject: title, body, variables, presentation: { heading: title, footer: "Esta é uma comunicação transacional. Em caso de dúvida, entre em contato com o suporte.", ...(action ? { buttonLabel: "Acessar", buttonUrl: "{{actionUrl}}" } : {}) } }),
    eventType, title, purpose: title, exampleData, defaultSelected: true,
  };
}
export const globalCatalog: CatalogModel[] = [
  ...commonTemplates.map(template => ({
    ...template, title: template.subject, purpose: template.subject, defaultSelected: true,
    presentation: { heading: template.subject, footer: "Se você não reconhece esta solicitação, entre em contato com o suporte." },
    exampleData: Object.fromEntries(template.variables.map(v => [v.name, v.type === "https_url" ? "https://example.invalid/acao" : v.name === "expiresInMinutes" ? "15" : v.name === "firstName" ? "Pessoa" : "Confira a atividade da sua conta."])),
  })),
  model("email-changed", "user.email_changed", "Alteração de e-mail", "Olá, {{firstName}}. O e-mail da sua conta foi alterado para {{newEmail}}. Se não foi você, contate o suporte.", [text("firstName"), text("newEmail")], { firstName: "Pessoa", newEmail: "pessoa@example.invalid" }),
  model("login-code", "user.login_code", "Código de acesso", "Olá, {{firstName}}. Seu código é {{code}} e expira em {{expiresInMinutes}} minutos. Não compartilhe este código.", [text("firstName"), text("code"), text("expiresInMinutes")], { firstName: "Pessoa", code: "123456", expiresInMinutes: "10" }),
  model("invitation", "account.invitation", "Convite de acesso", "Olá, {{firstName}}. {{inviterName}} convidou você para {{organizationName}}.", [text("firstName"), text("inviterName"), text("organizationName"), url("actionUrl")], { firstName: "Pessoa", inviterName: "Responsável", organizationName: "Organização", actionUrl: "https://example.invalid/convite" }, true),
  model("general-notification", "notification.general", "Notificação", "Olá, {{firstName}}. {{message}}", [text("firstName"), text("message")], { firstName: "Pessoa", message: "Você tem uma nova atualização." }),
  model("action-required", "notification.action_required", "Ação necessária", "Olá, {{firstName}}. {{message}}", [text("firstName"), text("message"), url("actionUrl")], { firstName: "Pessoa", message: "Revise os dados solicitados.", actionUrl: "https://example.invalid/pendencia" }, true),
  model("payment-confirmed", "billing.payment_confirmed", "Pagamento confirmado", "Olá, {{firstName}}. Confirmamos o pagamento {{paymentReference}} no valor de {{amount}}.", [text("firstName"), text("paymentReference"), text("amount")], { firstName: "Pessoa", paymentReference: "PAG-001", amount: "R$ 100,00" }),
  model("payment-failed", "billing.payment_failed", "Falha no pagamento", "Olá, {{firstName}}. Não foi possível confirmar o pagamento {{paymentReference}}. {{message}}", [text("firstName"), text("paymentReference"), text("message"), url("actionUrl")], { firstName: "Pessoa", paymentReference: "PAG-001", message: "Confira os dados do pagamento.", actionUrl: "https://example.invalid/pagamento" }, true),
  model("receipt", "billing.receipt", "Recibo disponível", "Olá, {{firstName}}. Seu recibo {{receiptReference}} no valor de {{amount}} está disponível.", [text("firstName"), text("receiptReference"), text("amount"), url("actionUrl")], { firstName: "Pessoa", receiptReference: "REC-001", amount: "R$ 100,00", actionUrl: "https://example.invalid/recibo" }, true),
  model("ticket-created", "support.ticket_created", "Solicitação recebida", "Olá, {{firstName}}. Recebemos a solicitação {{ticketReference}}: {{ticketSubject}}.", [text("firstName"), text("ticketReference"), text("ticketSubject")], { firstName: "Pessoa", ticketReference: "SUP-001", ticketSubject: "Dúvida sobre acesso" }),
  model("ticket-updated", "support.ticket_updated", "Atualização de atendimento", "Olá, {{firstName}}. A solicitação {{ticketReference}} foi atualizada. {{message}}", [text("firstName"), text("ticketReference"), text("message"), url("actionUrl")], { firstName: "Pessoa", ticketReference: "SUP-001", message: "Uma resposta está disponível.", actionUrl: "https://example.invalid/atendimento" }, true),
  { ...minhaNotaWelcome, eventType: "user.welcome", title: "MinhaNota — boas-vindas", purpose: "Apresentação original do MinhaNota, sem integração Resend legada.", exampleData: { firstName: "Pessoa" }, defaultSelected: false },
];
export const defaultCatalogIds = globalCatalog.filter(item => item.defaultSelected).map(item => item.id);
