"use client";
import { useEffect, useRef, useState } from "react";

export default function InviteAcceptance() {
  const initialized = useRef(false);
  const [token, setToken] = useState(""),
    [user, setUser] = useState(""),
    [checking, setChecking] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const fragment = window.location.hash.slice(1);
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    if (/^[A-Za-z0-9_-]{43}$/.test(fragment)) setToken(fragment);
    else
      setError(
        "Este link de convite está incompleto. Abra o link original recebido do administrador.",
      );
    fetch("/api/mail/session", { cache: "no-store" })
      .then(async (response) => {
        if (response.ok) setUser((await response.json()).user.username);
      })
      .catch(() =>
        setError(
          "Não foi possível verificar sua sessão. Recarregue o link original e tente novamente.",
        ),
      )
      .finally(() => setChecking(false));
  }, []);
  async function accept() {
    if (!token || checking || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/mail/oidc/google/invite", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ token }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          "Convite indisponível, expirado ou não autorizado. Confira a conta e solicite um novo link ao administrador.",
        );
      const destination = new URL(data.authorizationUrl);
      if (destination.origin !== "https://accounts.google.com")
        throw new Error("Não foi possível iniciar a autenticação Google.");
      window.location.assign(destination.href);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Não foi possível aceitar o convite.",
      );
      setBusy(false);
    }
  }
  return (
    <main className="mail-login">
      <div className="login-story">
        <a className="mail-brand" href="/mail">
          <span className="brand-mark">t</span>todoku
          <span className="brand-sub">mail</span>
        </a>
        <span className="eyebrow">UM ESPAÇO COMPARTILHADO</span>
        <h1>
          Seu convite
          <br />
          para o Todoku.
        </h1>
        <p>
          Participe da sua organização.
          <br />
          Cada caixa tem suas próprias permissões.
        </p>
      </div>
      <div className="login-form-wrap">
        <section className="login-form" aria-labelledby="invite-title">
          <span className="eyebrow">ACESSO POR CONVITE</span>
          <h2 id="invite-title">Aceitar convite</h2>
          <p>
            Use a conta Google do endereço convidado. Aceitar o convite não
            libera leitura ou envio de mensagens: o administrador concederá
            esses acessos separadamente.
          </p>
          {user ? (
            <p>
              Sessão atual: <strong>{user}</strong>. O vínculo preservará seu
              usuário interno.
            </p>
          ) : (
            <p>
              Já tem acesso por senha?{" "}
              <a href="/mail" target="_blank" rel="noopener noreferrer">
                Entre na sua conta em outra aba
              </a>{" "}
              antes de continuar, para preservar o mesmo usuário.
            </p>
          )}
          {error ? (
            <p className="mail-error" role="alert">
              {error}
            </p>
          ) : null}
          <button
            className="secondary-button"
            type="button"
            disabled={!token || checking || busy}
            onClick={accept}
          >
            {busy ? "Abrindo Google…" : "Aceitar com Google"}
          </button>
          <p>O link é pessoal e de uso único. Não compartilhe.</p>
        </section>
      </div>
    </main>
  );
}
