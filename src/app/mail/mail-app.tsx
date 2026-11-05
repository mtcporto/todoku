"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import MailComposer, { mailError, type ComposerPreset } from "./mail-composer";

const folders = {
  inbox: "Recebidos",
  sent: "Enviados",
  drafts: "Rascunhos",
  trash: "Lixeira",
} as const;
type Folder = keyof typeof folders;
const statuses: Record<string, string> = {
  draft: "Rascunho",
  queued: "Na fila",
  accepted: "Aceito pelo provedor",
  delivered: "Entregue",
  bounced: "Devolvido",
  complained: "Marcado como spam",
  failed: "Falha no envio",
  manual_review: "Verificação necessária",
};

type Identity = {
  id: string;
  address: string;
  label: string;
  domain_id: string;
  domain: string;
  receiving_status: string;
  status: string;
  can_send: number;
  can_manage: number;
  sending_configured: number;
};
type Message = {
  id: string;
  sender: string;
  subject: string;
  preview: string;
  received_at: string;
  is_read: number;
  attachment_count: number;
  identities: string;
  identity_id: string;
  direction: string;
  delivery_status: string;
};
type Inbox = {
  identities: Identity[];
  messages: Message[];
  nextCursor: string | null;
  receivingEnabled: boolean;
  storageReady: boolean;
  fixture: boolean;
  sendingEnabled: boolean;
};
type Detail = {
  id: string;
  subject: string;
  sender: string;
  receivedAt: string;
  authentication: string;
  identityId: string;
  text: string;
  document: string | null;
  folder: Folder;
  direction: string;
  deliveryStatus: string;
  version: number;
  canSend: boolean;
  canManage: boolean;
  to: string[];
  cc: string[];
  bcc: string[];
  html: string;
  reply?: ComposerPreset["reply"];
  attachments: { id: string; filename: string; size: number }[];
  thread: {
    id: string;
    sender: string;
    subject: string;
    received_at: string;
  }[];
};
const date = (value: string) =>
  new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
const emptyInbox: Inbox = {
  identities: [],
  messages: [],
  nextCursor: null,
  receivingEnabled: false,
  storageReady: false,
  fixture: false,
  sendingEnabled: false,
};

export default function MailApp() {
  const [user, setUser] = useState<{ username: string } | null>(null),
    [checking, setChecking] = useState(true);
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [signing, setSigning] = useState(false),
    [loginError, setLoginError] = useState("");
  const [inbox, setInbox] = useState<Inbox>(emptyInbox),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [domain, setDomain] = useState(""),
    [identity, setIdentity] = useState(""),
    [cursor, setCursor] = useState<string | null>(null),
    [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<string | null>(null),
    [detail, setDetail] = useState<Detail | null>(null),
    [detailError, setDetailError] = useState(""),
    [textOnly, setTextOnly] = useState(false);
  const [folder, setFolder] = useState<Folder>("inbox");
  const [composer, setComposer] = useState<ComposerPreset | null>(null);
  const [acting, setActing] = useState(false);
  const [readerIdentity, setReaderIdentity] = useState("");
  const selectedIdentity = readerIdentity || identity;
  function selectMessage(id: string, scope: string) {
    setReaderIdentity(scope);
    setSelected(id);
  }
  const heading = useRef<HTMLHeadingElement>(null),
    reader = useRef<HTMLElement>(null);
  function signedOut() {
    setUser(null);
    setInbox(emptyInbox);
    setSelected(null);
    setDetail(null);
    setComposer(null);
    setPassword("");
  }
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/mail/session", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (response.ok) setUser((await response.json()).user);
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const query = new URLSearchParams();
    query.set("folder", folder);
    if (domain) query.set("domain", domain);
    if (identity) query.set("identity", identity);
    if (cursor) query.set("cursor", cursor);
    fetch(`/api/mail/inbox?${query}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (response.status === 401) {
          signedOut();
          return;
        }
        if (!response.ok) throw new Error();
        const data: Inbox = await response.json();
        if (!controller.signal.aborted)
          setInbox((previous) => ({
            ...data,
            messages: cursor
              ? [...previous.messages, ...data.messages]
              : data.messages,
          }));
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Não foi possível carregar a caixa. Tente atualizar.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [user, domain, identity, cursor, refresh, folder]);
  useEffect(() => {
    if (!selected || !user) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    setDetail(null);
    setDetailError("");
    setTextOnly(false);
    const query = selectedIdentity
      ? `?identity=${encodeURIComponent(selectedIdentity)}`
      : "";
    fetch(`/api/mail/messages/${selected}${query}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (response.status === 401) {
          signedOut();
          return;
        }
        if (!response.ok) throw new Error();
        const data: Detail = await response.json();
        if (controller.signal.aborted) return;
        setDetail(data);
        const marked = await fetch(
          `/api/mail/messages/${selected}/read?identity=${encodeURIComponent(data.identityId)}`,
          {
            method: "POST",
            signal: controller.signal,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ read: true }),
          },
        );
        if (marked.ok && !controller.signal.aborted)
          setInbox((previous) => ({
            ...previous,
            messages: previous.messages.map((message) =>
              message.id === selected ? { ...message, is_read: 1 } : message,
            ),
          }));
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setDetailError(
            "A mensagem está indisponível ou seu acesso foi alterado.",
          );
      });
    return () => controller.abort();
  }, [selected, selectedIdentity, user]);
  const queued =
    inbox.sendingEnabled &&
    inbox.messages.some((item) => item.delivery_status === "queued");
  useEffect(() => {
    if (!queued || cursor) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible")
        setRefresh((value) => value + 1);
    }, 10000);
    return () => window.clearInterval(timer);
  }, [queued, cursor]);
  useEffect(() => {
    if (detail) {
      heading.current?.focus({ preventScroll: true });
      reader.current?.scrollTo({ top: 0 });
    }
  }, [detail]);
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSigning(true);
    setLoginError("");
    try {
      const response = await fetch("/api/mail/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) {
        setLoginError(
          response.status === 429
            ? "Aguarde alguns minutos antes de tentar novamente."
            : "Confira seu usuário e sua senha.",
        );
        return;
      }
      const session = await fetch("/api/mail/session", { cache: "no-store" });
      if (!session.ok) throw new Error();
      setPassword("");
      setDomain("");
      setIdentity("");
      setCursor(null);
      setUser((await session.json()).user);
    } catch {
      setLoginError("Não foi possível entrar. Tente novamente.");
    } finally {
      setSigning(false);
    }
  }
  async function logout() {
    const response = await fetch("/api/mail/logout", { method: "POST" });
    if (response.ok) signedOut();
    else setError("Não foi possível encerrar a sessão. Tente novamente.");
  }
  function filter(nextDomain: string, nextIdentity: string) {
    setDomain(nextDomain);
    setIdentity(nextIdentity);
    setCursor(null);
    setSelected(null);
    setInbox((previous) => ({ ...previous, messages: [] }));
    setRefresh((value) => value + 1);
  }
  function reload() {
    setCursor(null);
    setRefresh((previous) => previous + 1);
  }
  function openFolder(next: Folder) {
    setFolder(next);
    setSelected(null);
    setInbox((previous) => ({ ...previous, messages: [] }));
    reload();
  }
  function composeNew() {
    const sender =
      inbox.identities.find(
        (item) =>
          item.id === identity && item.can_send && item.status === "active",
      ) ??
      inbox.identities.find(
        (item) => item.can_send && item.status === "active",
      );
    setComposer({
      identityId: sender?.id ?? "",
      to: [],
      cc: [],
      bcc: [],
      subject: "",
      text: "",
      html: "",
      attachments: [],
    });
  }
  async function composeReply(mode: "reply" | "reply-all" | "forward") {
    if (!detail) return;
    setActing(true);
    setDetailError("");
    try {
      const response = await fetch(
        `/api/mail/messages/${detail.id}/compose?identity=${encodeURIComponent(detail.identityId)}&mode=${mode}`,
        { cache: "no-store" },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(mailError(data.error));
      setComposer(data);
    } catch (error) {
      setDetailError(
        error instanceof Error ? error.message : "Falha ao preparar mensagem.",
      );
    } finally {
      setActing(false);
    }
  }
  async function folderAction(action: "trash" | "restore" | "purge") {
    if (
      !detail ||
      (action === "purge" &&
        !window.confirm(
          "Excluir definitivamente desta identidade? Esta ação não pode ser desfeita.",
        ))
    )
      return;
    setActing(true);
    setDetailError("");
    try {
      const response = await fetch(
        `/api/mail/messages/${detail.id}/${action}?identity=${encodeURIComponent(detail.identityId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm: action === "purge" }),
        },
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          data.error === "send_in_progress"
            ? "Aguarde a conclusão ou a verificação do envio antes de excluir."
            : mailError(data.error),
        );
      setSelected(null);
      reload();
    } catch (error) {
      setDetailError(
        error instanceof Error ? error.message : "Falha ao mover mensagem.",
      );
    } finally {
      setActing(false);
    }
  }
  if (checking)
    return (
      <div className="mail-loading" role="status">
        Abrindo Todoku Mail…
      </div>
    );
  if (!user)
    return (
      <main className="mail-login">
        <div className="login-story">
          <a className="mail-brand" href="/">
            <span className="brand-mark">t</span>todoku
            <span className="brand-sub">mail</span>
          </a>
          <span className="eyebrow">UM LUGAR PARA SUAS CONVERSAS</span>
          <h1>
            Seu e-mail.
            <br />
            Mais perto.
          </h1>
          <p>
            Todos os seus domínios, uma caixa só.
            <br />
            Clareza para acompanhar o que importa.
          </p>
          <div className="login-orbit" aria-hidden="true">
            ✉<span>Conexões que ficam.</span>
          </div>
        </div>
        <div className="login-form-wrap">
          <form onSubmit={login} className="login-form">
            <span className="eyebrow">BEM-VINDO DE VOLTA</span>
            <h2>Entre na sua caixa</h2>
            <p>Use seu acesso ao Todoku Mail.</p>
            <label htmlFor="mail-user">Usuário</label>
            <input
              id="mail-user"
              name="username"
              autoComplete="username"
              required
              maxLength={80}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
            <label htmlFor="mail-password">Senha</label>
            <input
              id="mail-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={256}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {loginError ? (
              <div className="mail-error" role="alert">
                {loginError}
              </div>
            ) : null}
            <button className="primary-button" type="submit" disabled={signing}>
              {signing ? "Entrando…" : "Entrar no Todoku Mail"}
              <span aria-hidden="true">↗</span>
            </button>
            <small>
              Seu acesso é pessoal. Para recuperar ou alterar a senha, fale com
              o administrador.
            </small>
          </form>
          <span className="login-footnote">Todoku · Communication Hub</span>
        </div>
      </main>
    );
  const domains = [
    ...new Map(
      inbox.identities.map((item) => [item.domain_id, item.domain]),
    ).entries(),
  ];
  return (
    <main className="mail-shell">
      <aside className="mail-sidebar">
        <a className="mail-brand" href="/">
          <span className="brand-mark">t</span>todoku
          <span className="brand-sub">mail</span>
        </a>
        <div className="sidebar-section">
          <span className="eyebrow">SEU ESPAÇO</span>
          <button
            className="nav-inbox"
            onClick={() => filter("", "")}
            aria-current={!domain && !identity ? "page" : undefined}
          >
            <span aria-hidden="true">▤</span> Caixa unificada{" "}
            <span className="nav-count">
              {inbox.messages.filter((message) => !message.is_read).length}
            </span>
          </button>
        </div>
        <nav className="sidebar-identities" aria-label="Identidades">
          <span className="eyebrow">IDENTIDADES</span>
          {inbox.identities.map((item) => (
            <button
              key={item.id}
              className={
                identity === item.id ? "identity-link active" : "identity-link"
              }
              onClick={() => filter(item.domain_id, item.id)}
              title={item.address}
            >
              <span className="identity-dot" aria-hidden="true" />
              <span>
                {item.label}
                <small>{item.address}</small>
              </span>
            </button>
          ))}
          {inbox.identities.length === 0 ? (
            <p className="muted-note">
              Nenhuma identidade vinculada a este acesso.
            </p>
          ) : null}
        </nav>
        <div className="sidebar-footer">
          <span className="account-avatar" aria-hidden="true">
            {user.username.slice(0, 1).toUpperCase()}
          </span>
          <span>
            {user.username}
            <small>Sessão pessoal</small>
          </span>
          <button
            onClick={logout}
            className="icon-button"
            aria-label="Sair"
            title="Sair"
          >
            ↗
          </button>
        </div>
      </aside>
      <section className="mail-workspace" aria-label="Caixa de e-mail">
        <header className="mail-toolbar">
          <div>
            <span className="eyebrow">TODOKU MAIL</span>
            <h1>
              {identity
                ? (inbox.identities.find((item) => item.id === identity)
                    ?.label ?? "Sua caixa")
                : "Caixa unificada"}
            </h1>
            <p>Suas conversas, no mesmo lugar.</p>
          </div>
          <div className="toolbar-actions">
            <button className="compose-button" onClick={composeNew}>
              Escrever
            </button>
            <span className="pilot-badge">
              {inbox.fixture
                ? "Demonstração local"
                : inbox.receivingEnabled
                  ? "Recebimento ativo"
                  : "Piloto · recebimento pausado"}
            </span>
            <button
              className="secondary-button"
              onClick={reload}
              disabled={loading}
              aria-label="Atualizar caixa"
            >
              ↻ <span>Atualizar</span>
            </button>
            <button
              className="mobile-signout icon-button"
              onClick={logout}
              aria-label="Sair"
            >
              ↗
            </button>
          </div>
        </header>
        <nav className="mail-folders" aria-label="Pastas">
          {(Object.entries(folders) as [Folder, string][]).map(
            ([key, label]) => (
              <button
                key={key}
                aria-current={folder === key ? "page" : undefined}
                onClick={() => openFolder(key)}
              >
                {label}
              </button>
            ),
          )}
        </nav>
        <div className="mail-filters">
          <div>
            <label htmlFor="domain-filter">Domínio</label>
            <select
              id="domain-filter"
              value={domain}
              onChange={(event) => filter(event.target.value, "")}
            >
              <option value="">Todos os domínios</option>
              {domains.map(([id, name]) => (
                <option value={id} key={id}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="identity-filter">Identidade</label>
            <select
              id="identity-filter"
              value={identity}
              onChange={(event) => {
                const item = inbox.identities.find(
                  (item) => item.id === event.target.value,
                );
                filter(item?.domain_id ?? domain, event.target.value);
              }}
            >
              <option value="">Todas as identidades</option>
              {inbox.identities
                .filter((item) => !domain || item.domain_id === domain)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.address}
                  </option>
                ))}
            </select>
          </div>
          <span className="filter-count" aria-live="polite">
            {inbox.messages.length}{" "}
            {inbox.messages.length === 1 ? "mensagem" : "mensagens"}
          </span>
        </div>
        {error ? (
          <div className="mail-error" role="alert">
            {error}
          </div>
        ) : null}
        <div className={`mail-grid ${selected ? "has-reader" : ""}`}>
          <section
            className="message-list"
            aria-label="Lista de mensagens"
            aria-busy={loading}
          >
            <div className="list-caption">
              <span>{folders[folder].toUpperCase()}</span>
              <span>Mais recentes primeiro</span>
            </div>
            {loading && inbox.messages.length === 0 ? (
              <div className="panel-empty" role="status">
                Carregando mensagens…
              </div>
            ) : inbox.messages.length === 0 ? (
              <div className="panel-empty">
                <span className="empty-symbol" aria-hidden="true">
                  ✉
                </span>
                <h2>Tudo em dia por aqui</h2>
                <p>
                  {folder !== "inbox"
                    ? `Nenhuma mensagem em ${folders[folder].toLowerCase()}.`
                    : inbox.receivingEnabled
                      ? "As mensagens recebidas aparecerão nesta caixa."
                      : "As mensagens aparecerão aqui quando o recebimento do domínio for ativado."}
                </p>
              </div>
            ) : (
              inbox.messages.map((message) => (
                <button
                  key={message.id}
                  className={`message-row ${selected === message.id ? "selected" : ""} ${!message.is_read ? "unread" : ""}`}
                  onClick={() => selectMessage(message.id, message.identity_id)}
                  aria-pressed={selected === message.id}
                >
                  <span className="sender-line">
                    <span className="sender-name">{message.sender}</span>
                    <time dateTime={message.received_at}>
                      {date(message.received_at)}
                    </time>
                  </span>
                  <span className="message-subject">
                    {!message.is_read ? (
                      <span className="unread-dot" aria-label="Não lida" />
                    ) : null}
                    {message.subject || "(sem assunto)"}
                  </span>
                  <span className="message-preview">
                    {message.preview || "Abra para ler a mensagem."}
                  </span>
                  <span className="message-meta">
                    {message.direction === "outbound" ? (
                      <span className="delivery-badge">
                        {statuses[message.delivery_status] ??
                          message.delivery_status}
                      </span>
                    ) : (
                      message.identities
                    )}
                    <span>
                      {message.attachment_count > 0
                        ? `⌕ ${message.attachment_count} ${message.attachment_count === 1 ? "anexo" : "anexos"}`
                        : ""}
                    </span>
                  </span>
                </button>
              ))
            )}
            {inbox.nextCursor ? (
              <button
                className="load-more secondary-button"
                disabled={loading}
                onClick={() => setCursor(inbox.nextCursor)}
              >
                {loading ? "Carregando…" : "Carregar mais"}
              </button>
            ) : null}
          </section>
          <section
            ref={reader}
            className="message-reader"
            aria-label="Leitura da mensagem"
          >
            {!selected ? (
              <div className="reader-empty">
                <div className="reader-illustration" aria-hidden="true">
                  ↗
                </div>
                <span className="eyebrow">ESPAÇO PARA O QUE IMPORTA</span>
                <h2>Uma conversa por vez.</h2>
                <p>Selecione uma mensagem para começar a leitura.</p>
                <small>Imagens externas ficam bloqueadas.</small>
              </div>
            ) : (
              <>
                <div className="reader-tools">
                  <button
                    className="secondary-button"
                    onClick={() => setSelected(null)}
                  >
                    ← Voltar
                  </button>
                  {detail ? (
                    <button
                      className="text-button"
                      onClick={() => setTextOnly((value) => !value)}
                    >
                      {textOnly ? "Visualizar formatado" : "Somente texto"}
                    </button>
                  ) : null}
                  {detail?.direction === "outbound" ? (
                    <span className="delivery-badge">
                      {statuses[detail.deliveryStatus] ?? detail.deliveryStatus}
                    </span>
                  ) : null}
                </div>
                {detailError ? (
                  <div className="mail-error" role="alert">
                    {detailError}
                  </div>
                ) : null}
                {!detail ? (
                  <div className="panel-empty" role="status">
                    Abrindo mensagem…
                  </div>
                ) : (
                  <article className="reader-content">
                    <header>
                      <span className="message-identity">
                        {
                          inbox.identities.find(
                            (item) => item.id === detail.identityId,
                          )?.address
                        }
                      </span>
                      <h2 ref={heading} tabIndex={-1}>
                        {detail.subject || "(sem assunto)"}
                      </h2>
                      <div className="reader-sender">
                        <span className="account-avatar" aria-hidden="true">
                          {detail.sender.slice(0, 1).toUpperCase()}
                        </span>
                        <div>
                          <strong>{detail.sender}</strong>
                          <time dateTime={detail.receivedAt}>
                            {date(detail.receivedAt)}
                          </time>
                        </div>
                      </div>
                      <p className="reader-security">
                        Conteúdo protegido · imagens externas bloqueadas
                        {detail.direction === "inbound" &&
                        detail.authentication !== "pass"
                          ? " · remetente não autenticado"
                          : ""}
                      </p>
                      <div className="reader-envelope">
                        {detail.to.length ? (
                          <p>Para: {detail.to.join(", ")}</p>
                        ) : null}
                        {detail.cc.length ? (
                          <p>Cc: {detail.cc.join(", ")}</p>
                        ) : null}
                        {detail.bcc.length ? (
                          <p>Cco: {detail.bcc.join(", ")}</p>
                        ) : null}
                      </div>
                      <div className="message-actions">
                        {detail.folder === "drafts" && detail.canSend ? (
                          <button
                            className="secondary-button"
                            onClick={() =>
                              setComposer({
                                id: detail.id,
                                version: detail.version,
                                identityId: detail.identityId,
                                to: detail.to,
                                cc: detail.cc,
                                bcc: detail.bcc,
                                subject: detail.subject,
                                text: detail.text,
                                html: detail.html,
                                attachments: detail.attachments.map((item) => ({
                                  ...item,
                                  existingId: item.id,
                                })),
                                ...(detail.reply
                                  ? { reply: detail.reply }
                                  : {}),
                              })
                            }
                          >
                            Editar rascunho
                          </button>
                        ) : detail.folder !== "trash" && detail.canSend ? (
                          <>
                            <button
                              className="secondary-button"
                              disabled={acting}
                              onClick={() => composeReply("reply")}
                            >
                              Responder
                            </button>
                            <button
                              className="secondary-button"
                              disabled={acting}
                              onClick={() => composeReply("reply-all")}
                            >
                              Responder a todos
                            </button>
                            <button
                              className="secondary-button"
                              disabled={acting}
                              onClick={() => composeReply("forward")}
                            >
                              Encaminhar
                            </button>
                          </>
                        ) : null}
                        {detail.canManage ? (
                          detail.folder === "trash" ? (
                            <>
                              <button
                                className="secondary-button"
                                disabled={acting}
                                onClick={() => folderAction("restore")}
                              >
                                Restaurar
                              </button>
                              <button
                                className="text-button"
                                disabled={acting}
                                onClick={() => folderAction("purge")}
                              >
                                Excluir definitivamente
                              </button>
                            </>
                          ) : (
                            <button
                              className="text-button"
                              disabled={acting}
                              onClick={() => folderAction("trash")}
                            >
                              Excluir
                            </button>
                          )
                        ) : null}
                      </div>
                    </header>
                    {textOnly || !detail.document ? (
                      <pre className="plain-email">{detail.text}</pre>
                    ) : (
                      <iframe
                        className="email-frame"
                        title="Conteúdo seguro da mensagem"
                        sandbox=""
                        referrerPolicy="no-referrer"
                        srcDoc={detail.document}
                      />
                    )}
                    {detail.attachments.length > 0 ? (
                      <section className="attachments" aria-label="Anexos">
                        <h3>
                          Anexos <span>{detail.attachments.length}</span>
                        </h3>
                        <p>
                          Arquivos não verificados. Baixe apenas se confiar no
                          remetente.
                        </p>
                        <div>
                          {detail.attachments.map((attachment) => (
                            <a
                              key={attachment.id}
                              href={`/api/mail/attachments/${attachment.id}`}
                              className="attachment-card"
                            >
                              <span aria-hidden="true">↓</span>
                              <span>
                                {attachment.filename}
                                <small>
                                  {Math.ceil(attachment.size / 1024)} KB ·
                                  Baixar
                                </small>
                              </span>
                            </a>
                          ))}
                        </div>
                      </section>
                    ) : null}
                    {detail.thread.length > 1 ? (
                      <nav
                        className="thread-list"
                        aria-label="Mensagens da conversa"
                      >
                        <h3>Nesta conversa · {detail.thread.length}</h3>
                        {detail.thread.map((item) => (
                          <button
                            key={item.id}
                            onClick={() =>
                              selectMessage(item.id, detail.identityId)
                            }
                            disabled={item.id === selected}
                          >
                            <span>{item.subject || "(sem assunto)"}</span>
                            <time dateTime={item.received_at}>
                              {date(item.received_at)}
                            </time>
                          </button>
                        ))}
                      </nav>
                    ) : null}
                  </article>
                )}
              </>
            )}
          </section>
        </div>
      </section>
      {composer ? (
        <MailComposer
          initial={composer}
          identities={inbox.identities}
          sendingEnabled={inbox.sendingEnabled}
          onClose={() => setComposer(null)}
          onSaved={(sent) => {
            if (sent) openFolder("sent");
            else {
              setSelected(null);
              reload();
            }
          }}
        />
      ) : null}
    </main>
  );
}
