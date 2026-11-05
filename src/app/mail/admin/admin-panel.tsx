"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  api,
  accessLost,
  adminError,
  organizationPath,
  stateLabel,
  roleLabel,
  dateLabel,
  type Session,
  type Organization,
  type Page,
  type Domain,
  type Mailbox,
  type Member,
  type Role,
  type Grant,
  type Invitation,
} from "./admin-api";
import ConfirmAction from "./confirm-action";
import GrantEditor from "./grant-editor";
import InvitationForm from "./invitation-form";

type Catalogs = {
  domains: Page<Domain>;
  mailboxes: Page<Mailbox>;
  memberships: Page<Member>;
  roles: Page<Role>;
  grants: Page<Grant>;
  invitations: Page<Invitation>;
};
type Action = {
  title: string;
  description: ReactNode;
  path: string;
  method: string;
  body?: unknown;
  invitationId?: string;
};
export default function AdminPanel() {
  const [gate, setGate] = useState<{
      session: Session;
      organizations: Organization[];
    } | null>(null),
    [error, setError] = useState(""),
    [checking, setChecking] = useState(true),
    [tenant, setTenant] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const session = await api<Session>("session", {
          signal: controller.signal,
        });
        if (!session.administration?.canAdminister) {
          setError("Você não tem acesso administrativo ao Todoku Mail.");
          return;
        }
        const organizations: Organization[] = [];
        let cursor: string | null = null;
        do {
          const page: Page<Organization> = await api<Page<Organization>>(
            "admin/organizations?limit=100" +
              (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
            { signal: controller.signal },
          );
          organizations.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor);
        if (!controller.signal.aborted) {
          setGate({ session, organizations });
          setTenant(organizations[0]?.id ?? "");
          if (!organizations.length)
            setError("Nenhuma organização administrável está disponível.");
        }
      } catch (e) {
        if (!controller.signal.aborted) setError(adminError(e));
      } finally {
        if (!controller.signal.aborted) setChecking(false);
      }
    })();
    return () => controller.abort();
  }, []);
  const denied = useCallback((message: string) => {
    setGate(null);
    setError(message);
  }, []);
  return (
    <main className="admin-shell">
      <header className="admin-header">
        <a className="mail-brand" href="/">
          <span className="brand-mark">t</span>todoku
          <span className="brand-sub">Communication Hub</span>
        </a>
        <a className="secondary-button" href="/mail">
          Voltar ao Mail
        </a>
      </header>
      <div className="admin-heading">
        <span className="eyebrow">TODOKU MAIL</span>
        <h1>Administração do Mail</h1>
        <p>Organizações, pessoas e acessos às caixas do módulo Mail.</p>
      </div>
      {checking ? (
        <p role="status">Verificando acesso administrativo…</p>
      ) : error ? (
        <p className="mail-error" role="alert">
          {error}
        </p>
      ) : gate ? (
        <>
          <div className="admin-context">
            <label htmlFor="admin-organization">
              Organização atual
              <select
                id="admin-organization"
                value={tenant}
                onChange={(e) => setTenant(e.target.value)}
              >
                {gate.organizations.map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.id} · {stateLabel(org.status)}
                  </option>
                ))}
              </select>
            </label>
            <p>
              Usuário autenticado: <strong>{gate.session.user.username}</strong>
              <br />
              <small>
                Administrar não concede leitura ou envio de mensagens.
              </small>
            </p>
          </div>
          {tenant ? (
            <OrganizationPanel key={tenant} tenant={tenant} onDenied={denied} />
          ) : null}
        </>
      ) : null}
    </main>
  );
}

function OrganizationPanel({
  tenant,
  onDenied,
}: {
  tenant: string;
  onDenied: (message: string) => void;
}) {
  const [catalogs, setCatalogs] = useState<Catalogs | null>(null),
    [organizationAdmin, setOrganizationAdmin] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0),
    [paging, setPaging] = useState(""),
    [action, setAction] = useState<Action | null>(null),
    [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState(""),
    [selectedMailbox, setSelectedMailbox] = useState(""),
    [link, setLink] = useState<{
      id: string;
      url: string;
      expiresAt: string;
    } | null>(null);
  const base = organizationPath(tenant);
  const denyGrant = useCallback(
    (error: unknown) => onDenied(adminError(error)),
    [onDenied],
  );
  const writing = useRef(false);
  function refresh() {
    setLoading(true);
    setCatalogs(null);
    setRevision((value) => value + 1);
  }
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setCatalogs(null);
    setError("");
    (async () => {
      try {
        const session = await api<Session>("session", {
          signal: controller.signal,
        });
        const orgAdmin = session.administration.scopes.some(
          (scope) =>
            scope.tenantId === tenant && scope.scope === "organization",
        );
        const paths = [
          "domains",
          "mailboxes",
          "memberships",
          "roles",
          "grants",
        ] as const;
        const pages = await Promise.all(
          paths.map((name) =>
            api(base + "/" + name + "?limit=25", { signal: controller.signal }),
          ),
        );
        const invitations = orgAdmin
          ? await api<Page<Invitation>>(base + "/invitations?limit=25", {
              signal: controller.signal,
            })
          : { items: [], nextCursor: null };
        if (!controller.signal.aborted) {
          setOrganizationAdmin(orgAdmin);
          setCatalogs({
            ...Object.fromEntries(
              paths.map((name, index) => [name, pages[index]]),
            ),
            invitations,
          } as Catalogs);
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(adminError(e));
          if (accessLost(e)) onDenied(adminError(e));
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
    // tenant is also the component key: changing organization discards pending edits and links.
  }, [base, revision, onDenied]);
  function review(value: Action) {
    setActionError("");
    setNotice("");
    setAction(value);
  }
  async function confirm() {
    if (!action || writing.current) return;
    writing.current = true;
    setBusy(true);
    setActionError("");
    try {
      const result = await api<{
        changed?: boolean;
        id?: string;
        invitationUrl?: string;
        expiresAt?: string;
      }>(action.path, {
        method: action.method,
        ...(action.body === undefined
          ? {}
          : { body: JSON.stringify(action.body) }),
      });
      if (result.invitationUrl && result.id && result.expiresAt)
        setLink({
          id: result.id,
          url: result.invitationUrl,
          expiresAt: result.expiresAt,
        });
      if (action.invitationId && link?.id === action.invitationId)
        setLink(null);
      setAction(null);
      setNotice(
        result.changed === false
          ? "O estado já estava atualizado."
          : "Alteração confirmada pelo servidor.",
      );
      refresh();
    } catch (e) {
      setActionError(adminError(e));
      if (accessLost(e)) onDenied(adminError(e));
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  async function more(name: keyof Catalogs) {
    if (!catalogs || paging || !catalogs[name].nextCursor) return;
    const cursor = catalogs[name].nextCursor;
    setPaging(name);
    setError("");
    try {
      const page = await api<Page<never>>(
        base + "/" + name + "?limit=25&cursor=" + encodeURIComponent(cursor),
      );
      setCatalogs((current) =>
        current
          ? {
              ...current,
              [name]: {
                items: [...current[name].items, ...page.items],
                nextCursor: page.nextCursor,
              },
            }
          : null,
      );
    } catch (e) {
      setError(adminError(e));
      if (accessLost(e)) onDenied(adminError(e));
    } finally {
      setPaging("");
    }
  }
  const memberName = (id: string) =>
    catalogs?.memberships.items.find((member) => member.user_id === id)
      ?.username ?? id;
  const boxName = (id: string) =>
    catalogs?.mailboxes.items.find((box) => box.id === id)?.address ?? id;
  const roleResource = (role: Role) =>
    role.identity_id
      ? boxName(role.identity_id)
      : role.domain_id
        ? (catalogs?.domains.items.find(
            (domain) => domain.id === role.domain_id,
          )?.name ?? role.domain_id)
        : tenant;
  const pager = (name: keyof Catalogs) =>
    catalogs?.[name].nextCursor ? (
      <button
        className="secondary-button"
        disabled={Boolean(paging) || loading}
        onClick={() => more(name)}
      >
        Carregar mais{" "}
        {
          {
            domains: "domínios",
            mailboxes: "caixas",
            memberships: "usuários",
            roles: "papéis",
            grants: "grants",
            invitations: "convites",
          }[name]
        }
      </button>
    ) : null;
  return (
    <>
      <nav className="admin-nav" aria-label="Seções administrativas">
        <a href="#admin-domains">Domínios e caixas</a>
        <a href="#admin-users">Usuários e papéis</a>
        <a href="#admin-grants">Permissões</a>
        {organizationAdmin ? <a href="#admin-invitations">Convites</a> : null}
        <button
          className="secondary-button"
          disabled={loading || Boolean(paging)}
          onClick={refresh}
        >
          Atualizar painel
        </button>
      </nav>
      {notice ? (
        <p role="status" className="admin-notice">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mail-error">
          {error}
        </p>
      ) : null}
      {link ? (
        <section
          className="admin-card admin-invite-link"
          aria-label="Convite criado"
        >
          <h2>Link de convite criado</h2>
          <p>
            Copie agora e compartilhe por um canal privado autorizado. Nenhum
            e-mail foi enviado. O link não será exibido novamente.
          </p>
          <label htmlFor="new-invitation-link">
            Link pessoal de uso único
            <input
              id="new-invitation-link"
              readOnly
              value={link.url}
              onFocus={(event) => event.target.select()}
            />
          </label>
          <p>Válido até {dateLabel(link.expiresAt)}.</p>
          <button className="secondary-button" onClick={() => setLink(null)}>
            Ocultar link
          </button>
        </section>
      ) : null}
      {loading ? (
        <p role="status">Carregando recursos autorizados…</p>
      ) : catalogs ? (
        <div className="admin-grid">
          <section className="admin-card" id="admin-domains">
            <h2>Domínios administráveis</h2>
            <ResourceTable
              label="Domínios"
              headers={["Domínio", "Estado"]}
              empty={!catalogs.domains.items.length}
            >
              {catalogs.domains.items.map((domain) => (
                <tr key={domain.id}>
                  <th scope="row">{domain.name}</th>
                  <td>
                    <State value={domain.status} />
                  </td>
                </tr>
              ))}
            </ResourceTable>
            {pager("domains")}
            <p className="admin-help">
              Cadastro e ativação de domínios não fazem parte desta entrega.
            </p>
          </section>
          <section className="admin-card">
            <h2>Caixas postais</h2>
            <ResourceTable
              label="Caixas postais"
              headers={["Caixa", "Estado", "Acessos"]}
              empty={!catalogs.mailboxes.items.length}
            >
              {catalogs.mailboxes.items.map((box) => (
                <tr key={box.id}>
                  <th scope="row">
                    {box.label}
                    <small>{box.address}</small>
                  </th>
                  <td>
                    <State value={box.status} />
                  </td>
                  <td>
                    <a
                      href="#admin-grants"
                      onClick={() => setSelectedMailbox(box.id)}
                    >
                      Gerenciar acessos de {box.address}
                    </a>
                  </td>
                </tr>
              ))}
            </ResourceTable>
            {pager("mailboxes")}
            <p className="admin-help">
              Nenhuma caixa será criada ou ativada por este painel.
            </p>
          </section>
          <section className="admin-card" id="admin-users">
            <h2>Usuários e memberships</h2>
            <ResourceTable
              label="Usuários"
              headers={["Usuário interno", "Conta", "Membership", "Ação"]}
              empty={!catalogs.memberships.items.length}
            >
              {catalogs.memberships.items.map((member) => (
                <tr key={member.user_id}>
                  <th scope="row">
                    {member.username}
                    <small className="admin-id">{member.user_id}</small>
                  </th>
                  <td>
                    <State value={member.account_status} />
                  </td>
                  <td>
                    <State value={member.status} />
                  </td>
                  <td>
                    {organizationAdmin ? (
                      <button
                        className="secondary-button"
                        disabled={
                          member.account_status !== "active" &&
                          member.status === "suspended"
                        }
                        onClick={() =>
                          review({
                            title:
                              member.status === "active"
                                ? "Suspender membership"
                                : "Reativar membership",
                            description: (
                              <>
                                <p>
                                  <strong>{member.username}</strong> ·
                                  organização <strong>{tenant}</strong>
                                </p>
                                <p>
                                  {member.status === "active"
                                    ? "O usuário perderá acesso somente a esta organização. As sessões globais e o acesso a outras organizações serão preservados."
                                    : "Os grants e papéis anteriores poderão voltar a produzir efeito. O servidor verificará seus limites de delegação."}
                                </p>
                              </>
                            ),
                            path:
                              base +
                              "/memberships/" +
                              encodeURIComponent(member.user_id),
                            method: "PUT",
                            body: {
                              status:
                                member.status === "active"
                                  ? "suspended"
                                  : "active",
                            },
                          })
                        }
                      >
                        {member.status === "active" ? "Suspender" : "Reativar"}{" "}
                        {member.username}
                      </button>
                    ) : (
                      <span className="admin-help">Somente organização</span>
                    )}
                  </td>
                </tr>
              ))}
            </ResourceTable>
            {pager("memberships")}
          </section>
          <section className="admin-card">
            <h2>Papéis administrativos</h2>
            <ResourceTable
              label="Papéis administrativos"
              headers={["Usuário", "Escopo", "Recurso", "Estado"]}
              empty={!catalogs.roles.items.length}
            >
              {catalogs.roles.items.map((role) => (
                <tr key={role.id}>
                  <th scope="row">{memberName(role.user_id)}</th>
                  <td>{roleLabel(role.scope)}</td>
                  <td>{roleResource(role)}</td>
                  <td>
                    <State value={role.status} />
                  </td>
                </tr>
              ))}
            </ResourceTable>
            {pager("roles")}
            <p className="admin-help">
              Papéis administrativos não concedem acesso ao conteúdo das caixas.
              A atribuição de papéis não é editada nesta entrega.
            </p>
          </section>
          <section className="admin-card admin-wide" id="admin-grants">
            <h2>Permissões sobre mensagens</h2>
            <p>
              Leitura, envio e gerenciamento são concessões explícitas por
              usuário e caixa. O servidor valida cada alteração e o limite de
              delegação.
            </p>
            <GrantEditor
              key={revision}
              tenant={tenant}
              mailboxes={catalogs.mailboxes.items}
              members={catalogs.memberships.items}
              selectedMailbox={selectedMailbox}
              onReview={review}
              onDenied={denyGrant}
            />
            <ResourceTable
              label="Grants de conteúdo"
              headers={[
                "Usuário",
                "Caixa",
                "Leitura",
                "Envio",
                "Gerenciamento",
                "Ação",
              ]}
              empty={!catalogs.grants.items.length}
            >
              {catalogs.grants.items.map((grant) => (
                <tr key={grant.identity_id + ":" + grant.user_id}>
                  <th scope="row">{memberName(grant.user_id)}</th>
                  <td>{boxName(grant.identity_id)}</td>
                  <td>{grant.can_read ? "Sim" : "Não"}</td>
                  <td>{grant.can_send ? "Sim" : "Não"}</td>
                  <td>{grant.can_manage ? "Sim" : "Não"}</td>
                  <td>
                    <button
                      className="secondary-button"
                      onClick={() =>
                        review({
                          title: "Revogar acesso à caixa",
                          description: (
                            <>
                              <p>
                                Usuário{" "}
                                <strong>{memberName(grant.user_id)}</strong>,
                                caixa{" "}
                                <strong>{boxName(grant.identity_id)}</strong>,
                                organização <strong>{tenant}</strong>.
                              </p>
                              <p>
                                O grant inteiro de leitura, envio e
                                gerenciamento será removido. Mensagens, anexos e
                                papéis administrativos serão preservados.
                              </p>
                            </>
                          ),
                          path:
                            base +
                            "/mailboxes/" +
                            encodeURIComponent(grant.identity_id) +
                            "/grants/" +
                            encodeURIComponent(grant.user_id),
                          method: "DELETE",
                        })
                      }
                    >
                      Revogar acesso de {memberName(grant.user_id)} a{" "}
                      {boxName(grant.identity_id)}
                    </button>
                  </td>
                </tr>
              ))}
            </ResourceTable>
            {pager("grants")}
          </section>
          {organizationAdmin ? (
            <section className="admin-card admin-wide" id="admin-invitations">
              <h2>Convites</h2>
              <p>
                Um convite permite entrar na organização. Não concede leitura,
                envio ou administração. Nenhum e-mail é enviado automaticamente.
              </p>
              <InvitationForm base={base} tenant={tenant} onReview={review} />
              <ResourceTable
                label="Convites"
                headers={["Endereço convidado", "Estado", "Validade", "Ação"]}
                empty={!catalogs.invitations.items.length}
              >
                {catalogs.invitations.items.map((invitation) => (
                  <tr key={invitation.id}>
                    <th scope="row">
                      {invitation.email_normalized}
                      {invitation.target_user_id ? (
                        <small>
                          Usuário interno: {invitation.target_user_id}
                        </small>
                      ) : null}
                    </th>
                    <td>
                      <State value={invitation.state} />
                    </td>
                    <td>{dateLabel(invitation.expires_at)}</td>
                    <td>
                      {invitation.state === "pending" ? (
                        <button
                          className="secondary-button"
                          onClick={() =>
                            review({
                              title: "Revogar convite",
                              description: (
                                <>
                                  <p>
                                    Convite para{" "}
                                    <strong>
                                      {invitation.email_normalized}
                                    </strong>
                                    , organização <strong>{tenant}</strong>.
                                  </p>
                                  <p>
                                    O link deixará de permitir a aceitação.
                                    Usuários e acessos existentes não serão
                                    alterados.
                                  </p>
                                </>
                              ),
                              path:
                                base +
                                "/invitations/" +
                                encodeURIComponent(invitation.id) +
                                "/revoke",
                              method: "POST",
                              body: {},
                              invitationId: invitation.id,
                            })
                          }
                        >
                          Revogar convite de {invitation.email_normalized}
                        </button>
                      ) : (
                        <span className="admin-help">Sem ação pendente</span>
                      )}
                    </td>
                  </tr>
                ))}
              </ResourceTable>
              {pager("invitations")}
            </section>
          ) : (
            <p className="admin-help admin-wide">
              Convites e alterações de membership exigem administração da
              organização. Seu escopo permite somente os recursos listados
              acima.
            </p>
          )}
        </div>
      ) : null}
      {action ? (
        <ConfirmAction
          title={action.title}
          busy={busy}
          error={actionError}
          onCancel={() => setAction(null)}
          onConfirm={confirm}
        >
          {action.description}
        </ConfirmAction>
      ) : null}
    </>
  );
}
export function ResourceTable({
  label,
  headers,
  empty,
  children,
}: {
  label: string;
  headers: string[];
  empty: boolean;
  children: ReactNode;
}) {
  return empty ? (
    <p className="admin-help">Nenhum registro disponível neste escopo.</p>
  ) : (
    <div
      className={
        headers.length > 2 ? "admin-table admin-table-wide" : "admin-table"
      }
      role="region"
      aria-label={label}
      tabIndex={0}
    >
      {headers.length > 2 ? (
        <p className="admin-table-hint">
          Role a tabela para ver todas as colunas.
        </p>
      ) : null}
      <table>
        <thead>
          <tr>
            {headers.map((header) => (
              <th scope="col" key={header}>
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
function State({ value }: { value: string }) {
  return (
    <span className={"admin-state admin-state-" + value}>
      {stateLabel(value)}
    </span>
  );
}
export type { Action };
