export type Page<T> = { items: T[]; nextCursor: string | null };
export type Organization = { id: string; status: string };
export type Domain = { id: string; name: string; status: string };
export type Mailbox = {
  id: string;
  domain_id: string;
  address: string;
  label: string;
  status: string;
};
export type Member = {
  user_id: string;
  username: string;
  status: string;
  account_status: string;
};
export type Role = {
  id: string;
  user_id: string;
  scope: string;
  domain_id: string | null;
  identity_id: string | null;
  status: string;
};
export type Grant = {
  identity_id: string;
  user_id: string;
  can_read: number;
  can_send: number;
  can_manage: number;
};
export type Invitation = {
  id: string;
  email_normalized: string;
  target_user_id: string | null;
  state: string;
  expires_at: string;
};
export type Session = {
  user: { id: string; username: string };
  administration: {
    canAdminister: boolean;
    scopes: { tenantId: string; scope: string }[];
  };
};
export class AdminError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
const errors: Record<string, string> = {
  last_organization_administrator:
    "A organização precisa manter pelo menos um administrador ativo.",
  content_delegation_exceeds_permissions:
    "Você não pode conceder permissões de conteúdo que não pode delegar nesta caixa.",
  administration_not_permitted:
    "Seu acesso administrativo a este recurso não está disponível. Volte ao Mail para atualizar a sessão.",
  member_inactive:
    "O usuário ou sua membership está inativo. Novas permissões exigem acesso ativo.",
  membership_suspended:
    "Esta membership está suspensa. Reative-a pela administração de usuários, se autorizado.",
  member_already_active:
    "Este usuário já pertence à organização. Gerencie sua membership e seus acessos na lista de usuários.",
  invitation_already_pending:
    "Já existe um convite válido para esse endereço. O link original não pode ser recuperado; revogue o convite antes de emitir outro.",
  invitation_already_used:
    "O convite já foi aceito. Para retirar acesso, gerencie a membership e os grants.",
  invitation_limit: "A organização atingiu o limite de convites pendentes.",
  invalid_origin:
    "A origem da operação não foi aceita. Reabra o painel pelo endereço do Todoku.",
};
export function adminError(error: unknown) {
  if (error instanceof AdminError)
    return (
      errors[error.code] ??
      (
        {
          401: "Sua sessão expirou ou foi revogada. Entre novamente no Mail.",
          403: "Você não tem permissão para esta operação neste escopo.",
          404: "O recurso não está mais disponível neste escopo.",
          409: "O estado mudou ou a operação conflita com os acessos atuais. Atualize a lista.",
          400: "Confira os campos informados.",
          413: "Os dados informados excedem o tamanho permitido.",
          429: "Limite de operações atingido. Aguarde antes de tentar novamente.",
        } as Record<number, string>
      )[error.status] ??
      "Não foi possível confirmar a operação. Atualize a lista antes de tentar novamente."
    );
  return "Não foi possível confirmar a operação. Verifique sua conexão e atualize a lista antes de tentar novamente.";
}
export const accessLost = (error: unknown) =>
  error instanceof AdminError &&
  [401, 403].includes(error.status) &&
  error.code !== "content_delegation_exceeds_permissions" &&
  error.code !== "invalid_origin";
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch("/api/mail/" + path, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    let code = "unavailable";
    try {
      code = (await response.json()).error ?? code;
    } catch {}
    throw new AdminError(response.status, code);
  }
  return response.json();
}
export const organizationPath = (tenant: string) =>
  "admin/organizations/" + encodeURIComponent(tenant);
export const stateLabel = (value: string) =>
  (
    ({
      active: "Ativo",
      disabled: "Desativado",
      suspended: "Suspensa",
      revoked: "Revogado",
      pending: "Pendente",
      accepted: "Aceito",
      expired: "Expirado",
    }) as Record<string, string>
  )[value] ?? value;
export const roleLabel = (value: string) =>
  (
    ({
      organization: "Organização",
      domain: "Domínio",
      mailbox: "Caixa",
    }) as Record<string, string>
  )[value] ?? value;
export const dateLabel = (value: string) =>
  new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
