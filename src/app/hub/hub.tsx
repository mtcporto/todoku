"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import styles from "./hub.module.css";

type Session = { user: { id: string; username: string }; tenants: { id: string }[] };
type Application = { id: string; name: string | null; managed: number; status: string; configurationId: string | null; mode: string | null; domain: string | null; senderEmail: string | null; senderName: string | null };
type Variable = { name: string; type: "text" | "https_url" };
type Template = { id: string; version: number; subject: string; body: string; variables: Variable[] };
type Binding = { eventType: string; templateId: string; templateVersion: number; enabled: number };
type Catalog = { applications: Application[]; templates?: Template[]; bindings?: Binding[] };
type Pending = { title: string; path: string; payload: Record<string, unknown> };
type EventState = { id: string; eventType: string; createdAt: string; queueStatus: string; deliveryState: string; mode: string; attempts: number; error: string | null };
type Trail = { action: string; createdAt: string; details: string };
type Events = { events: EventState[]; hasMore: boolean; page: number; audit: Trail[]; deliveryAudit: Trail[] };
const messages: Record<string, string> = {
  unauthorized: "Sua sessão expirou. Entre novamente.", hub_forbidden: "Você não tem permissão para administrar esta organização no Hub.",
  hub_setup_required: "O Hub aguarda a preparação autorizada do banco. O Mail continua independente.",
  hub_unavailable: "O Hub está indisponível. Tente novamente mais tarde.", invalid_input: "Confira os campos e as variáveis informadas.",
  invalid_template: "Declare todas as variáveis usadas entre {{chaves}}, sem duplicações.", application_exists: "Essa aplicação já existe. Selecione-a na lista.",
  invalid_template_variables: "Preencha exatamente as variáveis declaradas; links devem usar HTTPS.",
  application_unavailable: "A aplicação está desativada ou indisponível.", invalid_credentials: "Usuário ou senha inválidos.",
  catalog_limit_reached: "O catálogo excedeu o limite desta interface. Consulte a operação antes de continuar.",
};
async function api<T>(path: string, payload?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/hub/${path}`, { method: payload ? "POST" : "GET", cache: "no-store", signal,
    ...(payload ? { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(messages[result.error] ?? "Não foi possível concluir. Atualize os dados e tente novamente.");
  return result as T;
}
const errorText = (error: unknown) => error instanceof Error ? error.message : "Não foi possível concluir a operação.";
const pathFor = (tenant: string, application?: string) => `tenants/${encodeURIComponent(tenant)}/applications${application ? `/${encodeURIComponent(application)}` : ""}`;

function Confirmation({ pending, busy, confirm, cancel }: { pending: Pending; busy: boolean; confirm: () => void; cancel: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="hub-confirm-title" onCancel={event => { event.preventDefault(); if (!busy) cancel(); }}>
    <h2 id="hub-confirm-title">{pending.title}</h2><p>Confira a organização, a aplicação e os dados que serão gravados.</p>
    <p className={styles.break}>Destino: <strong>{pending.path}</strong></p><pre>{JSON.stringify(pending.payload, null, 2)}</pre>
    <p>Esta operação não autoriza envio real.</p><div className={styles.actions}><button type="button" onClick={cancel} disabled={busy}>Cancelar</button><button type="button" onClick={confirm} disabled={busy}>{busy ? "Salvando…" : "Confirmar alteração"}</button></div>
  </dialog>;
}

export default function Hub() {
  const [session, setSession] = useState<Session | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [tenant, setTenant] = useState("");
  async function load() {
    setLoading(true); setError("");
    try { const result = await api<Session>("session"); setSession(result); setTenant(result.tenants[0]?.id ?? ""); }
    catch (failure) { setError(errorText(failure)); setSession(null); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setLoading(true); setError("");
    try { await api("login", { username: form.get("username"), password: form.get("password") }); await load(); }
    catch (failure) { setError(errorText(failure)); setLoading(false); }
  }
  async function logout() {
    setLoading(true);
    try { await api("logout", {}); setSession(null); setTenant(""); setError(""); }
    catch (failure) { setError(errorText(failure)); }
    finally { setLoading(false); }
  }
  return <main className={styles.hub}><header className={styles.header}><div><a href="/">Todoku</a><h1>Communication Hub</h1><p>Aplicações, templates e comunicações transacionais</p></div>{session && <div><p>{session.user.username}</p><button type="button" onClick={() => void logout()} disabled={loading}>Sair</button></div>}</header>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {loading ? <p role="status">Carregando…</p> : !session ? <section className={styles.card}><h2>Entrar no Hub</h2><p>Use seu acesso existente. A administração do Hub exige autorização própria por organização.</p><form onSubmit={login}><label>Usuário<input name="username" autoComplete="username" required /></label><label>Senha<input name="password" type="password" autoComplete="current-password" required /></label><button>Entrar</button></form><p>Já entrou pelo Google no <a href="/mail">Todoku Mail</a>? Volte a esta página para usar a mesma sessão.</p></section>
      : !tenant ? <section className={styles.card}><h2>Acesso não autorizado</h2><p>Sua autenticação está válida, mas não há organizações autorizadas para você no Hub. Isso não altera suas permissões no Mail.</p></section>
        : <><label>Organização<select value={tenant} onChange={event => setTenant(event.target.value)}>{session.tenants.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label><Organization key={tenant} tenant={tenant} /></>}
  </main>;
}

function Organization({ tenant }: { tenant: string }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null), [application, setApplication] = useState("");
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [pending, setPending] = useState<Pending | null>(null), [busy, setBusy] = useState(false), [token, setToken] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = new AbortController(); controller.current = abort;
    void api<Catalog>(pathFor(tenant), undefined, abort.signal).then(result => { setCatalog(result); setApplication(result.applications[0]?.id ?? ""); }).catch(failure => { if (!abort.signal.aborted) setError(errorText(failure)); });
    return () => abort.abort();
  }, [tenant]);
  async function confirm() {
    if (!pending) return; const snapshot = pending; setBusy(true); setError("");
    try {
      const result = await api<{ token?: string }>(snapshot.path, snapshot.payload, controller.current?.signal);
      if (result.token) setToken(result.token);
      const next = await api<Catalog>(pathFor(tenant), undefined, controller.current?.signal); setCatalog(next); setPending(null); setNotice("Aplicação criada em dry-run, com comunicações desabilitadas.");
    } catch (failure) { if (!controller.current?.signal.aborted) { setError(errorText(failure)); setPending(null); } }
    finally { setBusy(false); }
  }
  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    setPending({ title: "Cadastrar aplicação em dry-run", path: pathFor(tenant), payload: { id: data.get("id"), name: data.get("name"), senderConfigurationId: data.get("sender") } });
  }
  return <>
    {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status">{notice}</p>}
    {token && <section className={styles.card}><h2>Credencial da nova aplicação</h2><p>Exibida somente agora. Salve no ambiente privado do servidor consumidor. Ela não é uma chave Resend.</p><label>Token de ingestão<input readOnly value={token} autoComplete="off" /></label><button type="button" onClick={() => setToken("")}>Ocultar credencial</button></section>}
    {!catalog ? <p role="status">Carregando aplicações…</p> : <>
      <fieldset disabled={!!pending || busy}><label>Aplicação<select value={application} onChange={event => { setApplication(event.target.value); setToken(""); }}><option value="">Selecione</option>{catalog.applications.map(item => <option key={item.id} value={item.id}>{item.name ?? item.id} · {item.status}</option>)}</select></label>
        <details className={styles.card}><summary>Cadastrar aplicação</summary><p>Reutiliza somente o remetente de uma configuração existente na organização. Não copia chaves nem habilita envio.</p><form onSubmit={create}>
          <label>Identificador<input name="id" pattern="[a-zA-Z0-9_-]{1,100}" maxLength={100} required /></label><label>Nome da aplicação<input name="name" maxLength={100} required /></label>
          <label>Configuração de remetente<select name="sender" required defaultValue=""><option value="">Selecione um remetente existente</option>{catalog.applications.filter(item => item.configurationId && item.status === "active").map(item => <option key={item.configurationId} value={item.configurationId!}>{item.id} · {item.senderEmail} · {item.mode}</option>)}</select></label><button>Cadastrar aplicação</button></form></details>
      </fieldset>
      {application && <ApplicationPanel key={`${application}:${catalog.applications.length}`} tenant={tenant} application={application} />}
    </>}
    {pending && <Confirmation pending={pending} busy={busy} confirm={() => void confirm()} cancel={() => setPending(null)} />}
  </>;
}

function ApplicationPanel({ tenant, application }: { tenant: string; application: string }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null), [events, setEvents] = useState<Events | null>(null), [page, setPage] = useState(0), [revision, setRevision] = useState(0);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [pending, setPending] = useState<Pending | null>(null), [busy, setBusy] = useState(false);
  const [variables, setVariables] = useState<Variable[]>([{ name: "firstName", type: "text" }]), [preview, setPreview] = useState("");
  const path = pathFor(tenant, application), current = catalog?.applications.find(item => item.id === application);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => { const abort = new AbortController(); lifetime.current = abort; return () => abort.abort(); }, []);
  useEffect(() => {
    const abort = new AbortController(); setError("");
    void Promise.all([api<Catalog>(path, undefined, abort.signal), api<Events>(`${path}/events?page=${page}`, undefined, abort.signal)]).then(([next, result]) => { setCatalog(next); setEvents(result); }).catch(failure => { if (!abort.signal.aborted) setError(errorText(failure)); });
    return () => abort.abort();
  }, [path, page, revision]);
  function review(title: string, collection: string, payload: Record<string, unknown>) {
    setPending({ title, path: `${path}/${collection}`, payload: structuredClone(payload) });
  }
  async function confirm() {
    if (!pending) return; const snapshot = pending; setBusy(true); setError("");
    try { await api(snapshot.path, snapshot.payload, lifetime.current?.signal); setPending(null); setNotice("Alteração registrada. Nenhum envio real foi autorizado."); setRevision(value => value + 1); }
    catch (failure) { if (!lifetime.current?.signal.aborted) { setError(errorText(failure)); setPending(null); } }
    finally { setBusy(false); }
  }
  function saveTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    review("Salvar nova versão de template", "templates", { id: data.get("id"), subject: data.get("subject"), body: data.get("body"), variables });
  }
  function saveBinding(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget), selected = String(data.get("template"));
    const [id, version] = selected.split("@");
    review("Associar evento e template", "bindings", { eventType: data.get("eventType"), templateId: id, templateVersion: Number(version), enabled: data.get("enabled") === "on" });
  }
  async function showPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); setError(""); setBusy(true);
    try { const [id, version] = String(data.get("template")).split("@"); const result = await api<{ subject: string; text: string }>(`${path}/preview`, { templateId: id, templateVersion: Number(version), data: JSON.parse(String(data.get("data"))) }, lifetime.current?.signal); setPreview(`${result.subject}\n\n${result.text}`); }
    catch (failure) { if (!lifetime.current?.signal.aborted) setError(failure instanceof SyntaxError ? "Os dados de prévia precisam ser um objeto JSON válido." : errorText(failure)); }
    finally { setBusy(false); }
  }
  const options = catalog?.templates?.map(item => <option key={`${item.id}@${item.version}`} value={`${item.id}@${item.version}`}>{item.id}@{item.version}</option>);
  return <section aria-label="Operação da aplicação">
    {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status">{notice}</p>}
    <header className={styles.header}><div><h2>{current?.name ?? application}</h2><p>{tenant} / {application}</p><p>{current?.senderName} {current?.senderEmail} · domínio {current?.domain ?? "não configurado"} · modo {current?.mode ?? "indisponível"}</p></div><button type="button" disabled={busy || !!pending} onClick={() => { setPending(null); setRevision(value => value + 1); }}>Atualizar dados</button></header>
    {current?.mode === "dry_run" && <p className={styles.banner}>Dry-run: as comunicações são simuladas. Esta tela não libera envio real.</p>}
    {!catalog ? <p role="status">Carregando catálogo…</p> : current?.status !== "active" ? <p role="alert">Aplicação desativada ou indisponível.</p> : <fieldset disabled={busy || !!pending}>
      {!current.managed ? <section className={styles.card}><h3>Catálogo legado</h3><p>Adotar os templates comuns substitui a resolução legada desta aplicação. As quatro comunicações começarão desabilitadas; pedidos novos só serão aceitos após ativação individual.</p><button type="button" onClick={() => review("Adotar catálogo e desabilitar comunicações comuns", "catalog", { name: current.name ?? application })}>Preparar catálogo da aplicação</button></section> : <>
        <section className={styles.card}><h3>Comunicações</h3><p>Ative cada evento explicitamente. Desativar bloqueia novos pedidos e trabalhos pendentes; não desfaz envios em trânsito.</p>
          <ul className={styles.list}>{catalog.bindings?.map(item => <li key={item.eventType}><div><strong>{item.eventType}</strong><p>{item.templateId}@{item.templateVersion} · {item.enabled ? "Habilitada" : "Desabilitada"}</p></div><button type="button" onClick={() => review(item.enabled ? "Desabilitar comunicação" : "Habilitar comunicação", "bindings", { eventType: item.eventType, templateId: item.templateId, templateVersion: item.templateVersion, enabled: !item.enabled })}>{item.enabled ? "Desabilitar" : "Habilitar"} {item.eventType}</button></li>)}</ul>
          <details><summary>Associar outro evento ou versão</summary><form onSubmit={saveBinding}><label>Evento<input name="eventType" placeholder="user.welcome" required maxLength={120} /></label><label>Versão do template<select name="template" required>{options}</select></label><label className={styles.checkbox}><input name="enabled" type="checkbox" />Habilitar comunicação</label><button>Revisar associação</button></form></details>
        </section>
        <section className={styles.card}><h3>Templates da aplicação</h3><ul>{catalog.templates?.map(item => <li key={`${item.id}@${item.version}`}><strong>{item.id}@{item.version}</strong> — {item.subject}<details><summary>Ver conteúdo e variáveis</summary><pre>{item.body}</pre><p>{item.variables.map(variable => `${variable.name} (${variable.type})`).join(", ") || "Sem variáveis"}</p></details></li>)}</ul>
          <details><summary>Criar template ou nova versão</summary><p>Use {'{{nome}}'} para variáveis. O conteúdo é texto; versões publicadas são imutáveis. Reutilize o identificador para criar a próxima versão.</p><form onSubmit={saveTemplate}>
            <label>Identificador do template<input name="id" required pattern="[a-z][a-z0-9_.-]*" maxLength={100} /></label><label>Assunto<input name="subject" required maxLength={200} /></label><label>Conteúdo<textarea name="body" required maxLength={8000} rows={5} /></label>
            <div><h4>Variáveis obrigatórias</h4>{variables.map((variable, index) => <div key={index} className={styles.variable}><label>Nome da variável {index + 1}<input value={variable.name} onChange={event => setVariables(values => values.map((value, at) => at === index ? { ...value, name: event.target.value } : value))} required pattern="[a-zA-Z][a-zA-Z0-9]*" /></label><label>Tipo da variável {index + 1}<select value={variable.type} onChange={event => setVariables(values => values.map((value, at) => at === index ? { ...value, type: event.target.value as Variable["type"] } : value))}><option value="text">Texto</option><option value="https_url">Link HTTPS</option></select></label><button type="button" onClick={() => setVariables(values => values.filter((_, at) => at !== index))}>Remover variável {index + 1}</button></div>)}<button type="button" disabled={variables.length >= 15} onClick={() => setVariables(values => [...values, { name: "", type: "text" }])}>Adicionar variável</button></div><button>Revisar nova versão</button>
          </form></details>
          <details><summary>Pré-visualizar template</summary><form onSubmit={showPreview}><label>Template para prévia<select name="template" required>{options}</select></label><label>Dados de exemplo (JSON)<textarea name="data" defaultValue={'{"firstName":"Exemplo"}'} required rows={3} /></label><button>Gerar prévia sem envio</button></form>{preview && <pre aria-label="Prévia renderizada">{preview}</pre>}</details>
        </section>
      </>}
      <section className={styles.card}><h3>Estado das mensagens</h3><p>Sem destinatários ou conteúdo sensível. “Aceita” indica persistência; “dry_run” é simulação.</p>{!events?.events.length ? <p>Nenhum evento nesta aplicação.</p> : <ul className={styles.list}>{events.events.map(item => <li key={item.id}><div><strong>{item.eventType}</strong><p className={styles.break}>{item.id}</p><p>{item.createdAt} · {item.mode} · fila {item.queueStatus} · entrega {item.deliveryState} · {item.attempts} tentativa(s)</p>{item.error && <p role="status">Falha: {item.error}</p>}</div></li>)}</ul>}<div className={styles.actions}><button type="button" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Anterior</button><span>Página {page + 1}</span><button type="button" disabled={!events?.hasMore} onClick={() => setPage(value => value + 1)}>Próxima</button></div>
        <details><summary>Trilha de auditoria recente</summary>{[...(events?.audit ?? []), ...(events?.deliveryAudit ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((item, index) => <div key={index}><strong>{item.action}</strong><p>{item.createdAt}</p><pre>{item.details}</pre></div>)}</details>
      </section>
    </fieldset>}
    {pending && <Confirmation pending={pending} busy={busy} confirm={() => void confirm()} cancel={() => setPending(null)} />}
  </section>;
}
