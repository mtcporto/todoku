"use client";
import { useEffect, useRef, useState } from "react";

export type SessionMetadata = {
  id: string;
  method: string;
  createdAt: string;
  expiresAt: string;
};
export type PersonalSession = {
  user: { id: string; username: string };
  session: SessionMetadata;
  administration?: { canAdminister: boolean };
};
export const methodLabel = (method?: string) =>
  method === "google"
    ? "Google OIDC"
    : method === "password"
      ? "Senha"
      : "Método não registrado";

function fitPopover(root: HTMLDetailsElement | null) {
  if (!root?.open) return;
  const panel = root.querySelector<HTMLElement>(".account-popover");
  if (!panel) return;
  panel.style.transform = "none";
  const rect = panel.getBoundingClientRect();
  const shift =
    Math.max(0, 16 - rect.left) + Math.min(0, innerWidth - 16 - rect.right);
  panel.style.transform = `translateX(${shift}px)`;
}

export default function AccountMenu({
  username,
  method,
  canAdminister,
  onLogout,
}: {
  username: string;
  method?: string;
  canAdminister: boolean;
  onLogout?: () => Promise<void>;
}) {
  const root = useRef<HTMLDetailsElement>(null),
    summary = useRef<HTMLElement>(null),
    writing = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const resize = () => fitPopover(root.current);
    const close = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node))
        root.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && root.current?.open) {
        event.preventDefault();
        root.current.open = false;
        summary.current?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", resize);
    };
  }, []);
  async function logout() {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    setError("");
    try {
      if (onLogout) await onLogout();
      else {
        const response = await fetch("/api/mail/logout", { method: "POST" });
        if (!response.ok && response.status !== 401) throw new Error();
        window.location.assign("/mail");
      }
    } catch {
      setError("Não foi possível sair. Tente novamente.");
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  return (
    <details
      className="account-menu"
      ref={root}
      onToggle={() => fitPopover(root.current)}
      onBlur={(event) => {
        if (
          event.relatedTarget &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          event.currentTarget.open = false;
      }}
    >
      <summary ref={summary}>
        Perfil <span>{username}</span>
      </summary>
      <div className="account-popover">
        <p>
          <strong>{username}</strong>
          <small>Sessão: {methodLabel(method)}</small>
        </p>
        <nav aria-label="Navegação pessoal">
          <a href="/mail">Caixa de entrada</a>
          <a href="/mail/profile">Meu perfil e sessões</a>
          {canAdminister ? (
            <a href="/mail/admin">Administração do Mail</a>
          ) : null}
          <button type="button" disabled={busy} onClick={logout}>
            {busy ? "Saindo…" : "Sair"}
          </button>
        </nav>
        {error ? (
          <p role="alert" className="mail-error">
            {error}
          </p>
        ) : null}
      </div>
    </details>
  );
}
