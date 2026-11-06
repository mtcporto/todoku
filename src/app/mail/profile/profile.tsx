"use client";
import { useEffect, useRef, useState } from "react";
import AccountMenu, {
  methodLabel,
  type PersonalSession,
} from "../account-menu";
import ConfirmAction from "../admin/confirm-action";
import { api, adminError, AdminError, type Page } from "../admin/admin-api";

type OwnSession = {
  id: string;
  method: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  current: number;
};
type Google = { enabled: boolean; linked: boolean; canLink: boolean };
const date = (value: string) =>
  new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
const expired = () => window.location.replace("/mail?sessionExpired=1");
export default function Profile() {
  const [session, setSession] = useState<PersonalSession | null>(null),
    [sessions, setSessions] = useState<Page<OwnSession> | null>(null),
    [google, setGoogle] = useState<Google | null>(null),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [paging, setPaging] = useState(false),
    [review, setReview] = useState<OwnSession | null>(null),
    [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState("");
  const writing = useRef(false),
    noticeFocus = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (notice) noticeFocus.current?.focus();
  }, [notice]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    (async () => {
      try {
        const [current, list, status] = await Promise.all([
          api<PersonalSession>("session", { signal: controller.signal }),
          api<Page<OwnSession>>("sessions?limit=25", {
            signal: controller.signal,
          }),
          api<Google>("oidc/google/status", {
            signal: controller.signal,
          }).catch(() => null),
        ]);
        if (controller.signal.aborted) return;
        setSession(current);
        setSessions(list);
        setGoogle(status);
      } catch (e) {
        if (controller.signal.aborted) return;
        setSession(null);
        setSessions(null);
        setGoogle(null);
        if (e instanceof AdminError && e.status === 401) expired();
        else setError(adminError(e));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [revision]);
  function sessionLost() {
    setSession(null);
    setSessions(null);
    setGoogle(null);
    setReview(null);
    expired();
  }
  async function more() {
    if (!sessions?.nextCursor || paging) return;
    setPaging(true);
    setError("");
    try {
      const page = await api<Page<OwnSession>>(
        "sessions?limit=25&cursor=" + encodeURIComponent(sessions.nextCursor),
      );
      setSessions((current) =>
        current
          ? {
              items: [...current.items, ...page.items],
              nextCursor: page.nextCursor,
            }
          : null,
      );
    } catch (e) {
      if (e instanceof AdminError && e.status === 401) sessionLost();
      else setError(adminError(e));
    } finally {
      setPaging(false);
    }
  }
  async function revoke() {
    if (!review || writing.current) return;
    writing.current = true;
    setBusy(true);
    setActionError("");
    try {
      const result = await api<{ loggedOut: boolean }>(
        "sessions/" + encodeURIComponent(review.id) + "/revoke",
        { method: "POST", body: "{}" },
      );
      if (result.loggedOut) {
        window.location.replace("/mail");
        return;
      }
      setReview(null);
      setNotice("Sessão encerrada. As demais sessões permanecem ativas.");
      setRevision((v) => v + 1);
    } catch (e) {
      if (e instanceof AdminError && e.status === 401) sessionLost();
      else setActionError(adminError(e));
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  return (
    <main className="admin-shell profile-shell">
      <header className="admin-header">
        <a className="mail-brand" href="/">
          <span className="brand-mark">t</span>todoku
          <span className="brand-sub">mail</span>
        </a>
        <div className="profile-navigation">
          <a href="/mail" className="secondary-button">
            Voltar ao Mail
          </a>
          {session ? (
            <AccountMenu
              username={session.user.username}
              method={session.session.method}
              canAdminister={session.administration?.canAdminister === true}
            />
          ) : null}
        </div>
      </header>
      <div className="admin-heading">
        <span className="eyebrow">TODOKU MAIL</span>
        <h1>Meu perfil e sessões</h1>
        <p>
          Seu acesso é pessoal. As permissões sobre caixas são concedidas
          separadamente.
        </p>
      </div>
      {error ? (
        <p role="alert" className="mail-error">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p
          role="status"
          className="admin-notice"
          tabIndex={-1}
          ref={noticeFocus}
        >
          {notice}
        </p>
      ) : null}
      {loading ? <p role="status">Carregando seu perfil…</p> : null}
      <button
        className="secondary-button"
        disabled={loading || paging || busy}
        onClick={() => {
          setReview(null);
          setRevision((v) => v + 1);
        }}
      >
        Atualizar perfil
      </button>
      {!loading && session ? (
        <>
          <section
            className="admin-card profile-card"
            aria-labelledby="profile-account-title"
          >
            <h2 id="profile-account-title">Seu acesso</h2>
            <dl className="profile-facts">
              <div>
                <dt>Usuário</dt>
                <dd>{session.user.username}</dd>
              </div>
              <div>
                <dt>ID interno</dt>
                <dd>{session.user.id}</dd>
              </div>
              <div>
                <dt>Método da sessão atual</dt>
                <dd>{methodLabel(session.session.method)}</dd>
              </div>
              <div>
                <dt>Sessão válida até</dt>
                <dd>{date(session.session.expiresAt)}</dd>
              </div>
              <div>
                <dt>Identidade Google</dt>
                <dd>
                  {!google
                    ? "Não foi possível consultar o vínculo."
                    : !google.enabled
                      ? "Login Google indisponível no momento."
                      : google.linked
                        ? "Conta Google vinculada"
                        : "Sem vínculo Google ativo"}
                </dd>
              </div>
            </dl>
            {google?.canLink ? (
              <form action="/api/mail/oidc/google/link" method="post">
                <button className="secondary-button" type="submit">
                  Vincular Google
                </button>
              </form>
            ) : null}
            <p className="admin-help">
              Vincular Google não altera o método desta sessão nem concede
              acesso a organizações ou mensagens.
            </p>
          </section>
          <section
            className="admin-card profile-card"
            aria-labelledby="profile-sessions-title"
          >
            <h2 id="profile-sessions-title">Suas sessões</h2>
            <p>
              Somente suas sessões são exibidas. Encerrar uma delas afeta seu
              acesso em todas as organizações naquele navegador, sem alterar
              seus grants.
            </p>
            <ul className="profile-sessions">
              {sessions?.items.map((item) => {
                const inactive =
                  !!item.revoked_at ||
                  Date.parse(item.expires_at) <= Date.now();
                return (
                  <li key={item.id}>
                    <div>
                      <strong>
                        {methodLabel(item.method)}
                        {item.current ? " · Sessão atual" : ""}
                      </strong>
                      <p>
                        Iniciada em {date(item.created_at)}
                        <br />
                        Válida até {date(item.expires_at)}
                      </p>
                      {inactive ? (
                        <small>
                          {item.revoked_at ? "Revogada" : "Expirada"}
                        </small>
                      ) : (
                        <small>Ativa</small>
                      )}
                    </div>
                    {!inactive ? (
                      <button
                        className="secondary-button"
                        onClick={() => {
                          setActionError("");
                          setReview({ ...item });
                        }}
                      >
                        {item.current
                          ? "Encerrar sessão atual"
                          : "Encerrar sessão"}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {sessions?.nextCursor ? (
              <button
                className="secondary-button"
                disabled={paging}
                onClick={more}
              >
                {paging ? "Carregando…" : "Carregar mais sessões"}
              </button>
            ) : null}
          </section>
        </>
      ) : null}
      {review ? (
        <ConfirmAction
          title={
            review.current ? "Encerrar sessão atual?" : "Encerrar esta sessão?"
          }
          busy={busy}
          error={actionError}
          onCancel={() => setReview(null)}
          onConfirm={revoke}
        >
          <p>
            Usuário <strong>{session?.user.username}</strong>. Sessão por{" "}
            <strong>{methodLabel(review.method)}</strong>, iniciada em{" "}
            <strong>{date(review.created_at)}</strong>.
          </p>
          <p>
            {review.current
              ? "Você sairá do Todoku neste navegador. Seus dados e permissões serão preservados."
              : "O acesso dessa sessão será revogado. Sua sessão atual e os acessos de outras pessoas serão preservados."}
          </p>
        </ConfirmAction>
      ) : null}
    </main>
  );
}
