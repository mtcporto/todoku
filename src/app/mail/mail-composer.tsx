"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";

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
}: {
  initial: ComposerPreset;
  identities: Sender[];
  sendingEnabled: boolean;
  onClose: () => void;
  onSaved: (sent: boolean) => void;
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
  const [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
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
      previousFocus.current?.focus();
    };
  }, []);
  function change() {
    setDirty(true);
    setNotice("");
    setError("");
  }
  function close() {
    if (
      !busy &&
      (!dirty || window.confirm("Fechar sem salvar estas alterações?"))
    )
      onClose();
  }
  function keyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
    if (event.key === "Tab") {
      const nodes = Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]',
        ) ?? [],
      ).filter((x) => x.offsetParent !== null);
      if (!nodes.length) return;
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
    setNotice("Rascunho salvo.");
    onSaved(false);
    return result;
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await save();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao salvar.");
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    setBusy(true);
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
      setBusy(false);
    }
  }
  async function addFiles(list: FileList | null) {
    if (!list) return;
    setBusy(true);
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
      setBusy(false);
    }
  }
  return (
    <div className="composer-backdrop">
      <div
        className="mail-composer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="composer-title"
        ref={dialog}
        onKeyDown={keyDown}
      >
        <header>
          <div>
            <span className="eyebrow">TODOKU MAIL</span>
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
          <fieldset disabled={busy} onChange={change}>
            <label>
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
            {!senders.length ? (
              <p role="status" className="composer-note">
                Seu acesso ainda não possui uma identidade autorizada para
                compor.
              </p>
            ) : !ready ? (
              <p className="composer-note">
                Envio externo pausado. Você pode preparar e salvar rascunhos.
              </p>
            ) : null}
            <label>
              Para
              <input
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="destinatario@exemplo.com"
                autoComplete="off"
              />
            </label>
            <div className="composer-columns">
              <label>
                Cc
                <input
                  value={cc}
                  onChange={(e) => setCc(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <label>
                Cco
                <input
                  value={bcc}
                  onChange={(e) => setBcc(e.target.value)}
                  autoComplete="off"
                />
              </label>
            </div>
            <small>
              Separe endereços por vírgula. Até 10 destinatários no total.
            </small>
            <label>
              Assunto
              <input
                value={subject}
                maxLength={1000}
                onChange={(e) => setSubject(e.target.value)}
              />
            </label>
            <label>
              Formato
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value)}
              >
                <option value="text">Texto simples</option>
                <option value="html">HTML seguro</option>
              </select>
            </label>
            <label>
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
            <label>
              Anexar arquivos
              <input
                type="file"
                multiple
                accept=".txt,.csv,.pdf,.png,.jpg,.jpeg,.zip,.docx,.xlsx"
                onChange={(e) => {
                  void addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            <small>
              Até 5 arquivos e 2 MiB somados. Arquivos não são verificados por
              antivírus.
            </small>
            <ul className="composer-files">
              {files.map((file, index) => (
                <li key={file.existingId ?? index}>
                  <span>
                    {file.filename} · {Math.ceil(file.size / 1024)} KB
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
                    Remover
                  </button>
                </li>
              ))}
            </ul>
          </fieldset>
          {error ? (
            <p className="mail-error" role="alert">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className="composer-notice" role="status">
              {notice}
            </p>
          ) : null}
          <footer>
            <button
              className="secondary-button"
              type="submit"
              disabled={busy || !sender}
            >
              {busy ? "Aguarde…" : "Salvar rascunho"}
            </button>
            <button
              className="compose-button"
              type="button"
              onClick={send}
              disabled={busy || !ready}
            >
              Enviar
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
