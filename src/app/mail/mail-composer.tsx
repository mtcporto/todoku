"use client";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";

type FileItem = {
  existingId?: string;
  filename: string;
  size: number;
  contentType?: string;
  content?: string;
};
export type ComposerPreset = {
  id?: string;
  version?: number;
  identityId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html: string;
  attachments: FileItem[];
  reply?: { messageId: string; mode: "reply" | "reply-all" | "forward" };
};
type Sender = {
  id: string;
  address: string;
  status: string;
  can_send: number;
  sending_configured: number;
};
const errors: Record<string, string> = {
  sending_disabled:
    "O envio externo está pausado. Seu rascunho foi preservado.",
  sending_not_configured:
    "Esta identidade ainda não está configurada para enviar.",
  sending_not_permitted: "Você não tem permissão de envio nesta identidade.",
  draft_conflict:
    "O rascunho foi alterado em outra sessão. Feche e abra novamente para conferir a versão atual.",
  draft_locked: "Esta mensagem já entrou na fila e não pode ser editada.",
  recipient_not_allowed:
    "Há um destinatário fora da lista autorizada para esta identidade.",
  subject_required: "Informe um assunto antes de enviar.",
  body_required: "Escreva uma mensagem antes de enviar.",
  too_many_recipients:
    "Use no máximo 10 destinatários, somando Para, Cc e Cco.",
  unsupported_attachment: "Use TXT, CSV, PDF, PNG, JPEG, ZIP, DOCX ou XLSX.",
  attachment_type_mismatch:
    "O conteúdo de um arquivo não corresponde ao tipo informado.",
  attachment_size_limit: "Os anexos devem somar no máximo 2 MiB.",
  draft_quota: "O limite de rascunhos desta identidade foi atingido.",
  mail_rate_limited: "Aguarde um minuto antes de tentar novamente.",
  send_quota: "O limite diário de envio desta identidade foi atingido.",
};
export function mailError(code: string) {
  return (
    errors[code] ??
    "Não foi possível concluir. Confira os campos e tente novamente."
  );
}
export default function MailComposer({
  initial,
  identities,
  sendingEnabled,
  onClose,
  onSaved,
  fallbackFocus,
}: {
  initial: ComposerPreset;
  identities: Sender[];
  sendingEnabled: boolean;
  onClose: () => void;
  onSaved: (sent: boolean) => void;
  fallbackFocus: RefObject<HTMLButtonElement | null>;
}) {
  const [draftId, setDraftId] = useState(initial.id),
    [version, setVersion] = useState(initial.version),
    [requestId] = useState(() => crypto.randomUUID());
  const [identity, setIdentity] = useState(initial.identityId),
    [to, setTo] = useState(initial.to.join(", ")),
    [cc, setCc] = useState(initial.cc.join(", ")),
    [bcc, setBcc] = useState(initial.bcc.join(", "));
  const [subject, setSubject] = useState(initial.subject),
    [text, setText] = useState(initial.text),
    [html, setHtml] = useState(initial.html),
    [format, setFormat] = useState(initial.html ? "html" : "text"),
    [files, setFiles] = useState(initial.attachments);
  const [operation, setOperation] = useState<
      "saving" | "sending" | "attaching" | null
    >(null),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState("");
  const [showCc, setShowCc] = useState(initial.cc.length > 0),
    [showBcc, setShowBcc] = useState(initial.bcc.length > 0);
  const working = useRef(false),
    fileInput = useRef<HTMLInputElement>(null),
    backdrop = useRef<HTMLDivElement>(null);
  const busy = operation !== null;
  const title = useRef<HTMLHeadingElement>(null),
    dialog = useRef<HTMLDivElement>(null),
    previousFocus = useRef<HTMLElement | null>(null);
  const senders = identities.filter((x) => x.can_send && x.status === "active"),
    sender = senders.find((x) => x.id === identity),
    ready = Boolean(sendingEnabled && sender?.sending_configured);
  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement;
    title.current?.focus();
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = old;
      if (
        previousFocus.current?.isConnected &&
        !previousFocus.current.matches(":disabled")
      )
        previousFocus.current.focus();
      else fallbackFocus.current?.focus();
    };
  }, [fallbackFocus]);
  useEffect(() => {
    const viewport = window.visualViewport;
    function fitViewport() {
      backdrop.current?.style.setProperty(
        "--composer-height",
        `${viewport?.height ?? window.innerHeight}px`,
      );
      backdrop.current?.style.setProperty(
        "--composer-top",
        `${viewport?.offsetTop ?? 0}px`,
      );
    }
    fitViewport();
    viewport?.addEventListener("resize", fitViewport);
    viewport?.addEventListener("scroll", fitViewport);
    window.addEventListener("resize", fitViewport);
    return () => {
      viewport?.removeEventListener("resize", fitViewport);
      viewport?.removeEventListener("scroll", fitViewport);
      window.removeEventListener("resize", fitViewport);
    };
  }, []);
  useEffect(() => {
    if (!dirty && !busy) return;
    const protect = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dirty, busy]);
  useEffect(() => {
    if (busy) title.current?.focus({ preventScroll: true });
  }, [busy]);
  function change() {
    setDirty(true);
    setError("");
  }
  function close() {
    if (
      !busy &&
      (!dirty || window.confirm("Fechar sem salvar estas alterações?"))
    )
      onClose();
  }
  function keyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
    if (event.key === "Tab") {
      const nodes = Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]:not(:disabled)',
        ) ?? [],
      ).filter((x) => x.offsetParent !== null);
      if (!nodes.length) {
        event.preventDefault();
        title.current?.focus();
        return;
      }
      const first = nodes[0],
        last = nodes.at(-1)!;
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === title.current)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }
  const addresses = (value: string) =>
    value
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  async function save() {
    const input = {
      requestId,
      identityId: identity,
      ...(draftId ? { version } : {}),
      to: addresses(to),
      cc: addresses(cc),
      bcc: addresses(bcc),
      subject,
      text: format === "text" ? text : "",
      html: format === "html" ? html : "",
      attachments: files.map((x) =>
        x.existingId
          ? { existingId: x.existingId }
          : {
              filename: x.filename,
              contentType: x.contentType ?? "",
              content: x.content ?? "",
            },
      ),
      ...(initial.reply ? { reply: initial.reply } : {}),
    };
    const body = JSON.stringify(input);
    if (new TextEncoder().encode(body).length > 4 * 1024 * 1024)
      throw new Error(
        "A mensagem excede o limite de tamanho. Reduza texto ou anexos.",
      );
    const r = await fetch(
      draftId ? `/api/mail/messages/${draftId}/draft` : "/api/mail/drafts",
      { method: "POST", headers: { "content-type": "application/json" }, body },
    );
    const result = await r.json();
    if (!r.ok) throw new Error(mailError(result.error));
    setDraftId(result.id);
    setVersion(result.version);
    setFiles(
      result.attachments.map(
        (x: { id: string; filename: string; size: number }) => ({
          existingId: x.id,
          filename: x.filename,
          size: x.size,
        }),
      ),
    );
    setDirty(false);
    onSaved(false);
    return result;
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working.current) return;
    working.current = true;
    setOperation("saving");
    setError("");
    try {
      await save();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao salvar.");
    } finally {
      working.current = false;
      setOperation(null);
    }
  }
  async function send() {
    if (working.current || !ready) return;
    working.current = true;
    setOperation("sending");
    setError("");
    try {
      const draft = await save();
      const r = await fetch(
        `/api/mail/messages/${draft.id}/send?identity=${encodeURIComponent(identity)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: draft.version }),
        },
      );
      const data = await r.json();
      if (!r.ok) throw new Error(mailError(data.error));
      onSaved(true);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao enviar.");
    } finally {
      working.current = false;
      setOperation(null);
    }
  }
  async function addFiles(list: FileList | null) {
    if (!list?.length || working.current) return;
    working.current = true;
    setOperation("attaching");
    setError("");
    try {
      const selected = Array.from(list);
      if (
        files.length + selected.length > 5 ||
        files.reduce((n, x) => n + x.size, 0) +
          selected.reduce((n, x) => n + x.size, 0) >
          2 * 1024 * 1024
      )
        throw new Error("Use até cinco arquivos, somando no máximo 2 MiB.");
      const added = await Promise.all(
        selected.map(
          (file) =>
            new Promise<FileItem>((resolve, reject) => {
              const reader = new FileReader();
              reader.onerror = () =>
                reject(new Error("Não foi possível ler o arquivo."));
              reader.onload = () =>
                resolve({
                  filename: file.name,
                  size: file.size,
                  contentType: file.type,
                  content: String(reader.result).split(",")[1],
                });
              reader.readAsDataURL(file);
            }),
        ),
      );
      setFiles((previous) => [...previous, ...added]);
      change();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao anexar.");
    } finally {
      working.current = false;
      setOperation(null);
    }
  }
  return (
    <div className="composer-backdrop" ref={backdrop}>
      <div
        className="mail-composer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="composer-title"
        aria-busy={busy}
        ref={dialog}
        onKeyDown={keyDown}
      >
        <header>
          <div>
            <h2 id="composer-title" ref={title} tabIndex={-1}>
              {draftId ? "Editar rascunho" : "Nova mensagem"}
            </h2>
          </div>
          <button
            type="button"
            onClick={close}
            disabled={busy}
            aria-label="Fechar composição"
          >
            ×
          </button>
        </header>
        <form onSubmit={submit}>
          <div className="composer-scroll">
            <fieldset
              disabled={busy}
              onChange={(event) => {
                if (
                  !(
                    event.target instanceof HTMLInputElement &&
                    event.target.type === "file"
                  )
                )
                  change();
              }}
            >
              <label className="composer-address">
                De
                <select
                  aria-label="Identidade remetente"
                  value={identity}
                  onChange={(e) => setIdentity(e.target.value)}
                  disabled={Boolean(draftId) || !senders.length}
                >
                  <option value="">Selecione uma identidade</option>
                  {senders.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.address}
                    </option>
                  ))}
                </select>
              </label>
              <div className="composer-recipient-row">
                <label className="composer-address">
                  Para
                  <input
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    placeholder="destinatario@exemplo.com"
                    autoComplete="off"
                    aria-describedby="composer-recipient-help"
                  />
                </label>
                <div className="composer-recipient-toggles">
                  <button
                    type="button"
                    aria-expanded={showCc}
                    aria-controls="composer-cc"
                    onClick={() => setShowCc((value) => !value)}
                  >
                    Cc{!showCc && cc.trim() ? ` (${addresses(cc).length})` : ""}
                  </button>
                  <button
                    type="button"
                    aria-expanded={showBcc}
                    aria-controls="composer-bcc"
                    onClick={() => setShowBcc((value) => !value)}
                  >
                    Cco
                    {!showBcc && bcc.trim()
                      ? ` (${addresses(bcc).length})`
                      : ""}
                  </button>
                </div>
              </div>
              <div className="composer-columns">
                <label
                  id="composer-cc"
                  className="composer-address"
                  hidden={!showCc}
                >
                  Cc
                  <input
                    value={cc}
                    onChange={(e) => setCc(e.target.value)}
                    autoComplete="off"
                  />
                </label>
                <label
                  id="composer-bcc"
                  className="composer-address"
                  hidden={!showBcc}
                >
                  Cco
                  <input
                    value={bcc}
                    onChange={(e) => setBcc(e.target.value)}
                    autoComplete="off"
                  />
                </label>
              </div>
              <small
                id="composer-recipient-help"
                className="composer-recipient-help"
              >
                Separe endereços por vírgula. Até 10 destinatários no total.
              </small>
              <label className="composer-subject">
                Assunto
                <input
                  value={subject}
                  maxLength={1000}
                  onChange={(e) => setSubject(e.target.value)}
                />
              </label>
              <label className="composer-format">
                Formato
                <select
                  value={format}
                  onChange={(e) => setFormat(e.target.value)}
                >
                  <option value="text">Texto simples</option>
                  <option value="html">HTML seguro</option>
                </select>
              </label>
              <label className="composer-editor">
                Mensagem
                <textarea
                  aria-label="Mensagem"
                  value={format === "html" ? html : text}
                  maxLength={256 * 1024}
                  rows={10}
                  onChange={(e) =>
                    format === "html"
                      ? setHtml(e.target.value)
                      : setText(e.target.value)
                  }
                />
              </label>
              {format === "html" ? (
                <small>
                  Scripts, estilos, links ativos e imagens serão removidos ao
                  salvar.
                </small>
              ) : null}
              <section
                className="composer-attachments"
                aria-labelledby="composer-attachments-title"
              >
                <div className="composer-attachment-heading">
                  <h3 id="composer-attachments-title">
                    Anexos <span>{files.length}/5</span>
                  </h3>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => fileInput.current?.click()}
                  >
                    Anexar arquivos
                  </button>
                </div>
                <label className="composer-file-input">
                  Selecionar anexos
                  <input
                    type="file"
                    ref={fileInput}
                    multiple
                    accept=".txt,.csv,.pdf,.png,.jpg,.jpeg,.zip,.docx,.xlsx"
                    onChange={(e) => {
                      void addFiles(e.target.files);
                      e.target.value = "";
                    }}
                  />
                </label>
                <small>
                  Até 5 arquivos e 2 MiB somados. Arquivos não são verificados
                  por antivírus.
                </small>
                {files.length ? (
                  <ul className="composer-files">
                    {files.map((file, index) => (
                      <li key={file.existingId ?? index}>
                        <span className="composer-file-icon" aria-hidden="true">
                          ↗
                        </span>
                        <span className="composer-file-info">
                          <strong>{file.filename}</strong>
                          <small>
                            {file.size < 1024
                              ? `${file.size} B`
                              : `${Math.ceil(file.size / 1024)} KiB`}
                          </small>
                        </span>
                        <button
                          type="button"
                          aria-label={`Remover ${file.filename}`}
                          onClick={() => {
                            setFiles((previous) =>
                              previous.filter((_, i) => i !== index),
                            );
                            change();
                          }}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="composer-files-empty">
                    Nenhum arquivo anexado.
                  </p>
                )}
                {files.length ? (
                  <small>
                    {Math.ceil(
                      files.reduce((sum, file) => sum + file.size, 0) / 1024,
                    )}{" "}
                    KiB de 2 MiB utilizados.
                  </small>
                ) : null}
              </section>
            </fieldset>
          </div>
          <footer>
            <div
              className="composer-feedback"
              aria-live="polite"
              aria-atomic="true"
            >
              <span className="composer-save-state">
                {operation === "saving"
                  ? "Salvando rascunho…"
                  : operation === "sending"
                    ? "Preparando envio…"
                    : operation === "attaching"
                      ? "Lendo anexos…"
                      : dirty
                        ? "Alterações pendentes"
                        : draftId
                          ? "Rascunho salvo."
                          : "Novo rascunho"}
              </span>
              {!senders.length ? (
                <p className="composer-note">
                  Seu acesso ainda não possui uma identidade autorizada para
                  compor.
                </p>
              ) : !ready ? (
                <p className="composer-note">
                  Envio externo pausado. Você pode salvar rascunhos.
                </p>
              ) : (
                <p className="composer-note">
                  Ao enviar, a mensagem entra na fila. Acompanhe o envio e a
                  entrega em Enviados.
                </p>
              )}
              {error ? (
                <p className="mail-error" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
            <div className="composer-footer-actions">
              <button
                className="secondary-button"
                type="submit"
                disabled={busy || !sender}
              >
                {operation === "saving" ? "Salvando…" : "Salvar rascunho"}
              </button>
              <button
                className="compose-button"
                type="button"
                onClick={send}
                disabled={busy || !ready}
              >
                {operation === "sending" ? "Enfileirando…" : "Enviar"}
              </button>
            </div>
          </footer>
        </form>
      </div>
    </div>
  );
}
