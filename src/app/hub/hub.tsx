"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import styles from "./hub.module.css";
import type { Branding, Presentation } from "../../lib/hub/presentation";

type Session = { user: { id: string; username: string }; tenants: { id: string }[] };
type Application = { id: string; name: string | null; managed: number; status: string; configurationId: string | null; mode: string | null; domain: string | null; senderEmail: string | null; senderName: string | null };
type Variable = { name: string; type: "text" | "https_url" };
type Template = { id: string; version: number; subject: string; body: string; variables: Variable[]; presentation?: Presentation | null };
type Model = Omit<Template, "version"> & { title: string; purpose: string; eventType: string; exampleData: Record<string, string>; defaultSelected: boolean };
type Binding = { eventType: string; templateId: string; templateVersion: number; enabled: number };
type Catalog = { applications: Application[]; templates?: Template[]; bindings?: Binding[]; globalTemplates: Model[]; branding?: Branding | null };
type Preview = { subject: string; text: string; html: string };
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
  hub_catalog_setup_required: "A biblioteca aguarda a migração 0010 autorizada. A ingestão existente continua funcionando.",
  catalog_model_not_found: "Esse modelo não está disponível na biblioteca.",
  catalog_duplicate_event: "Escolha somente um modelo inicial para cada evento.",
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

function PackagePicker({ models }: { models: Model[] }) {
  const [selected, setSelected] = useState(models.filter(item => item.defaultSelected).map(item => item.id));
  return <details><summary>Pacote inicial de eventos e templates ({selected.length})</summary><p>Modelos opcionais. Todos começam desabilitados; nenhum evento ou e-mail é gerado.</p>
    {models.map(item => <label key={item.id} className={styles.checkbox}><input type="checkbox" name="catalogItems" value={item.id} checked={selected.includes(item.id)} onChange={event => {
      const checked = event.target.checked;
      setSelected(values => checked ? [...values.filter(id => models.find(model => model.id === id)?.eventType !== item.eventType), item.id] : values.filter(id => id !== item.id));
    }} />{item.eventType} — {item.title}</label>)}
  </details>;
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
    setPending({ title: "Cadastrar aplicação em dry-run", path: pathFor(tenant), payload: { id: data.get("id"), name: data.get("name"), senderConfigurationId: data.get("sender"), catalogItems: data.getAll("catalogItems") } });
  }
  return <>
    {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status">{notice}</p>}
    {token && <section className={styles.card}><h2>Credencial da nova aplicação</h2><p>Exibida somente agora. Salve no ambiente privado do servidor consumidor. Ela não é uma chave Resend.</p><label>Token de ingestão<input readOnly value={token} autoComplete="off" /></label><button type="button" onClick={() => setToken("")}>Ocultar credencial</button></section>}
    {!catalog ? <p role="status">Carregando aplicações…</p> : <>
      <fieldset disabled={!!pending || busy}><label>Aplicação<select value={application} onChange={event => { setApplication(event.target.value); setToken(""); }}><option value="">Selecione</option>{catalog.applications.map(item => <option key={item.id} value={item.id}>{item.name ?? item.id} · {item.status}</option>)}</select></label>
        <details className={styles.card}><summary>Cadastrar aplicação</summary><p>Reutiliza somente o remetente de uma configuração existente na organização. Não copia chaves nem habilita envio.</p><form onSubmit={create}>
          <label>Identificador<input name="id" pattern="[a-zA-Z0-9_-]{1,100}" maxLength={100} required /></label><label>Nome da aplicação<input name="name" maxLength={100} required /></label>
          <label>Configuração de remetente<select name="sender" required defaultValue=""><option value="">Selecione um remetente existente</option>{catalog.applications.filter(item => item.configurationId && item.status === "active").map(item => <option key={item.configurationId} value={item.configurationId!}>{item.id} · {item.senderEmail} · {item.mode}</option>)}</select></label><PackagePicker models={catalog.globalTemplates} /><button>Cadastrar aplicação</button></form></details>
      </fieldset>
      {application && <ApplicationPanel key={`${application}:${catalog.applications.length}`} tenant={tenant} application={application} />}
    </>}
    {pending && <Confirmation pending={pending} busy={busy} confirm={() => void confirm()} cancel={() => setPending(null)} />}
  </>;
}

function ApplicationPanel({ tenant, application }: { tenant: string; application: string }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null), [events, setEvents] = useState<Events | null>(null), [page, setPage] = useState(0), [revision, setRevision] = useState(0);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [pending, setPending] = useState<Pending | null>(null), [busy, setBusy] = useState(false);
  const [variables, setVariables] = useState<Variable[]>([{ name: "firstName", type: "text" }]), [preview, setPreview] = useState<Preview | null>(null);
  const [editing, setEditing] = useState<Template | null>(null), [previewTemplate, setPreviewTemplate] = useState(""), [previewData, setPreviewData] = useState('{"firstName":"Exemplo"}');
  const editor = useRef<HTMLDetailsElement>(null), previewPanel = useRef<HTMLDetailsElement>(null);
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
    try { await api(snapshot.path, snapshot.payload, lifetime.current?.signal); setPending(null); setPreview(null); setNotice("Alteração registrada. Nenhum envio real foi autorizado."); setRevision(value => value + 1); }
    catch (failure) { if (!lifetime.current?.signal.aborted) { setError(errorText(failure)); setPending(null); } }
    finally { setBusy(false); }
  }
  function saveTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    const heading = String(data.get("heading") ?? "").trim();
    if (!heading && [data.get("footer"), data.get("buttonLabel"), data.get("buttonUrl")].some(Boolean)) { setError("Informe o título visual para usar botão ou rodapé."); return; }
    review("Salvar nova versão de template", "templates", { id: data.get("id"), subject: data.get("subject"), body: data.get("body"), variables,
      ...(heading ? { presentation: { heading, footer: data.get("footer"), ...(data.get("buttonLabel") || data.get("buttonUrl") ? { buttonLabel: data.get("buttonLabel"), buttonUrl: data.get("buttonUrl") } : {}) } } : {}) });
  }
  function saveBinding(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget), selected = String(data.get("template"));
    const [id, version] = selected.split("@");
    review("Associar evento e template", "bindings", { eventType: data.get("eventType"), templateId: id, templateVersion: Number(version), enabled: data.get("enabled") === "on" });
  }
  async function showPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); setError(""); setBusy(true);
    setPreview(null);
    try { const [id, version] = String(data.get("template")).split("@"); const result = await api<Preview>(`${path}/preview`, { templateId: id, templateVersion: Number(version), data: JSON.parse(String(data.get("data"))) }, lifetime.current?.signal); setPreview(result); }
    catch (failure) { if (!lifetime.current?.signal.aborted) setError(failure instanceof SyntaxError ? "Os dados de prévia precisam ser um objeto JSON válido." : errorText(failure)); }
    finally { setBusy(false); }
  }
  function editTemplate(template: Template) {
    setEditing(template); setVariables(template.variables.map(variable => ({ ...variable })));
    if (editor.current) { editor.current.open = true; editor.current.scrollIntoView({ block: "start", behavior: "smooth" }); }
  }
  function preparePreview(template: Template) {
    const model = catalog?.globalTemplates.find(item => item.id === template.id);
    setPreviewTemplate(`${template.id}@${template.version}`); setPreview(null);
    setPreviewData(JSON.stringify(model?.exampleData ?? Object.fromEntries(template.variables.map(variable => [variable.name, variable.type === "https_url" ? "https://example.invalid/acao" : "Exemplo"])), null, 2));
    if (previewPanel.current) { previewPanel.current.open = true; previewPanel.current.scrollIntoView({ block: "start", behavior: "smooth" }); }
  }
  function saveBranding(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    review("Salvar identidade visual da aplicação", "branding", Object.fromEntries(["name", "logoUrl", "primaryColor", "backgroundColor", "websiteUrl", "supportUrl", "signature"].map(name => [name, data.get(name)])));
  }
  const options = catalog?.templates?.map(item => <option key={`${item.id}@${item.version}`} value={`${item.id}@${item.version}`}>{item.id}@{item.version}</option>);
  return <section aria-label="Operação da aplicação">
    {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status">{notice}</p>}
    <header className={styles.header}><div><h2>{current?.name ?? application}</h2><p>{tenant} / {application}</p><p>{current?.senderName} {current?.senderEmail} · domínio {current?.domain ?? "não configurado"} · modo {current?.mode ?? "indisponível"}</p></div><button type="button" disabled={busy || !!pending} onClick={() => { setPending(null); setRevision(value => value + 1); }}>Atualizar dados</button></header>
    {current?.mode === "dry_run" && <p className={styles.banner}>Dry-run: as comunicações são simuladas. Esta tela não libera envio real.</p>}
    {!catalog ? <p role="status">Carregando catálogo…</p> : current?.status !== "active" ? <p role="alert">Aplicação desativada ou indisponível.</p> : <fieldset disabled={busy || !!pending}>
      {!current.managed ? <section className={styles.card}><h3>Catálogo legado</h3><p>Adotar o catálogo substitui a resolução legada desta aplicação. Os modelos iniciais são opcionais e começam desabilitados; pedidos novos só serão aceitos após ativação individual.</p><form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); review("Adotar catálogo e desabilitar comunicações comuns", "catalog", { name: current.name ?? application, catalogItems: data.getAll("catalogItems") }); }}><PackagePicker models={catalog.globalTemplates} /><button>Preparar catálogo da aplicação</button></form></section> : <>
        <section className={styles.card}><h3>Identidade visual</h3><p>Aplicada aos novos snapshots dos templates visuais desta aplicação. Não altera remetente, snapshots anteriores ou outras aplicações.</p><form key={JSON.stringify(catalog.branding)} onSubmit={saveBranding}>
          <label>Nome da marca<input name="name" required maxLength={100} defaultValue={catalog.branding?.name ?? current.name ?? application} /></label>
          <label>Logotipo (URL HTTPS)<input name="logoUrl" type="url" pattern="https://.*" defaultValue={catalog.branding?.logoUrl ?? ""} /></label>
          <label>Cor principal<input name="primaryColor" type="color" defaultValue={catalog.branding?.primaryColor ?? "#163b73"} /></label>
          <label>Cor de fundo<input name="backgroundColor" type="color" defaultValue={catalog.branding?.backgroundColor ?? "#f4f6f9"} /></label>
          <label>Site (URL HTTPS)<input name="websiteUrl" type="url" pattern="https://.*" defaultValue={catalog.branding?.websiteUrl ?? ""} /></label>
          <label>Suporte (URL HTTPS)<input name="supportUrl" type="url" pattern="https://.*" defaultValue={catalog.branding?.supportUrl ?? ""} /></label>
          <label>Assinatura<textarea name="signature" maxLength={500} defaultValue={catalog.branding?.signature ?? ""} /></label><button>Revisar identidade visual</button>
        </form></section>
        <section className={styles.card}><h3>Biblioteca global</h3><p>Copie um modelo para personalizar nesta aplicação. Importar cria uma versão; associações existentes não são trocadas. Eventos novos ficam desabilitados.</p><ul className={styles.list}>{catalog.globalTemplates.map(item => <li key={item.id}><div><strong>{item.title}</strong><p>{item.eventType} · {item.purpose}</p><details><summary>Variáveis e exemplo de {item.id}</summary><pre>{JSON.stringify(item.exampleData, null, 2)}</pre></details></div><button type="button" onClick={() => review(`Copiar modelo ${item.id}`, "models", { modelId: item.id })}>Usar modelo {item.id}</button></li>)}</ul></section>
        <section className={styles.card}><h3>Comunicações</h3><p>Ative cada evento explicitamente. Desativar bloqueia novos pedidos e trabalhos pendentes; não desfaz envios em trânsito.</p>
          <ul className={styles.list}>{catalog.bindings?.map(item => <li key={item.eventType}><div><strong>{item.eventType}</strong><p>{item.templateId}@{item.templateVersion} · {item.enabled ? "Habilitada" : "Desabilitada"}</p></div><button type="button" onClick={() => review(item.enabled ? "Desabilitar comunicação" : "Habilitar comunicação", "bindings", { eventType: item.eventType, templateId: item.templateId, templateVersion: item.templateVersion, enabled: !item.enabled })}>{item.enabled ? "Desabilitar" : "Habilitar"} {item.eventType}</button></li>)}</ul>
          <details><summary>Associar outro evento ou versão</summary><form onSubmit={saveBinding}><label>Evento<input name="eventType" placeholder="user.welcome" required maxLength={120} /></label><label>Versão do template<select name="template" required>{options}</select></label><label className={styles.checkbox}><input name="enabled" type="checkbox" />Habilitar comunicação</label><button>Revisar associação</button></form></details>
        </section>
        <section className={styles.card}><h3>Templates da aplicação</h3><ul>{catalog.templates?.map(item => <li key={`${item.id}@${item.version}`}><strong>{item.id}@{item.version}</strong> — {item.subject}<div className={styles.actions}><button type="button" onClick={() => editTemplate(item)}>Personalizar {item.id}@{item.version}</button><button type="button" onClick={() => preparePreview(item)}>Prévia de {item.id}@{item.version}</button></div><details><summary>Ver conteúdo e variáveis</summary><pre>{item.body}</pre><p>{item.variables.map(variable => `${variable.name} (${variable.type})`).join(", ") || "Sem variáveis"}</p></details></li>)}</ul>
          <button type="button" onClick={() => { setEditing(null); setVariables([{ name: "firstName", type: "text" }]); if (editor.current) editor.current.open = true; }}>Criar outro template</button>
          <details ref={editor}><summary>Criar template ou nova versão</summary><p>Use {'{{nome}}'} para variáveis. O conteúdo é texto; versões publicadas são imutáveis. Salvar não troca associações. Campos visuais vazios preservam o formato simples.</p><form key={editing ? `${editing.id}@${editing.version}` : "new"} onSubmit={saveTemplate}>
            <label>Identificador do template<input name="id" required pattern="[a-z][a-z0-9_.-]*" maxLength={100} defaultValue={editing?.id ?? ""} /></label><label>Assunto<input name="subject" required maxLength={200} defaultValue={editing?.subject ?? ""} /></label><label>Conteúdo<textarea name="body" required maxLength={8000} rows={5} defaultValue={editing?.body ?? ""} /></label>
            <label>Título visual<input name="heading" maxLength={300} defaultValue={editing?.presentation?.heading ?? ""} /></label><label>Texto do botão<input name="buttonLabel" maxLength={100} defaultValue={editing?.presentation?.buttonLabel ?? ""} /></label><label>Link do botão (HTTPS ou variável https_url)<input name="buttonUrl" maxLength={2000} defaultValue={editing?.presentation?.buttonUrl ?? ""} /></label><label>Rodapé de segurança<textarea name="footer" maxLength={1000} defaultValue={editing?.presentation?.footer ?? ""} /></label>
            <div><h4>Variáveis obrigatórias</h4>{variables.map((variable, index) => <div key={index} className={styles.variable}><label>Nome da variável {index + 1}<input value={variable.name} onChange={event => setVariables(values => values.map((value, at) => at === index ? { ...value, name: event.target.value } : value))} required pattern="[a-zA-Z][a-zA-Z0-9]*" /></label><label>Tipo da variável {index + 1}<select value={variable.type} onChange={event => setVariables(values => values.map((value, at) => at === index ? { ...value, type: event.target.value as Variable["type"] } : value))}><option value="text">Texto</option><option value="https_url">Link HTTPS</option></select></label><button type="button" onClick={() => setVariables(values => values.filter((_, at) => at !== index))}>Remover variável {index + 1}</button></div>)}<button type="button" disabled={variables.length >= 15} onClick={() => setVariables(values => [...values, { name: "", type: "text" }])}>Adicionar variável</button></div><button>Revisar nova versão</button>
          </form></details>
          <details ref={previewPanel}><summary>Pré-visualizar template</summary><form onSubmit={showPreview}><label>Template para prévia<select name="template" required value={previewTemplate} onChange={event => { setPreviewTemplate(event.target.value); setPreview(null); }}><option value="">Selecione</option>{options}</select></label><label>Dados de exemplo (JSON)<textarea name="data" value={previewData} onChange={event => setPreviewData(event.target.value)} required rows={3} /></label><button>Gerar prévia sem envio</button></form>{preview && <><h4>{preview.subject}</h4><iframe className={styles.preview} title="Prévia HTML do template" sandbox="" referrerPolicy="no-referrer" srcDoc={preview.html.replace("<head>", '<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src https:; base-uri \'none\'; form-action \'none\'">')} /><pre aria-label="Prévia renderizada">{preview.text}</pre></>}</details>
        </section>
      </>}
      <section className={styles.card}><h3>Estado das mensagens</h3><p>Sem destinatários ou conteúdo sensível. “Aceita” indica persistência; “dry_run” é simulação.</p>{!events?.events.length ? <p>Nenhum evento nesta aplicação.</p> : <ul className={styles.list}>{events.events.map(item => <li key={item.id}><div><strong>{item.eventType}</strong><p className={styles.break}>{item.id}</p><p>{item.createdAt} · {item.mode} · fila {item.queueStatus} · entrega {item.deliveryState} · {item.attempts} tentativa(s)</p>{item.error && <p role="status">Falha: {item.error}</p>}</div></li>)}</ul>}<div className={styles.actions}><button type="button" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Anterior</button><span>Página {page + 1}</span><button type="button" disabled={!events?.hasMore} onClick={() => setPage(value => value + 1)}>Próxima</button></div>
        <details><summary>Trilha de auditoria recente</summary>{[...(events?.audit ?? []), ...(events?.deliveryAudit ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((item, index) => <div key={index}><strong>{item.action}</strong><p>{item.createdAt}</p><pre>{item.details}</pre></div>)}</details>
      </section>
    </fieldset>}
    {pending && <Confirmation pending={pending} busy={busy} confirm={() => void confirm()} cancel={() => setPending(null)} />}
  </section>;
}
