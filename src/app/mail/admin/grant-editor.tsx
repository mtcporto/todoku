"use client";
import { useEffect, useState, type FormEvent } from "react";
import {
  api,
  accessLost,
  adminError,
  organizationPath,
  type Mailbox,
  type Member,
  type Grant,
  type Page,
} from "./admin-api";
import type { Action } from "./admin-panel";
type Bits = { canRead: boolean; canSend: boolean; canManage: boolean };
const empty: Bits = { canRead: false, canSend: false, canManage: false };
export default function GrantEditor({
  tenant,
  mailboxes,
  members,
  selectedMailbox,
  onReview,
  onDenied,
}: {
  tenant: string;
  mailboxes: Mailbox[];
  members: Member[];
  selectedMailbox: string;
  onReview: (action: Action) => void;
  onDenied: (error: unknown) => void;
}) {
  const [identity, setIdentity] = useState(selectedMailbox),
    [user, setUser] = useState(""),
    [bits, setBits] = useState<Bits>(empty),
    [ready, setReady] = useState(false),
    [error, setError] = useState("");
  useEffect(() => setIdentity(selectedMailbox), [selectedMailbox]);
  useEffect(() => {
    const controller = new AbortController();
    setReady(false);
    setError("");
    setBits(empty);
    if (!identity || !user) return () => controller.abort();
    (async () => {
      try {
        // Do not treat an unloaded page as an absent grant: scan this mailbox's pages
        // until the target is found or the authorized listing is exhausted.
        let cursor: string | null = null,
          grant: Grant | undefined;
        do {
          const page: Page<Grant> = await api<Page<Grant>>(
            organizationPath(tenant) +
              "/grants?limit=100&identityId=" +
              encodeURIComponent(identity) +
              (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
            { signal: controller.signal },
          );
          grant = page.items.find((item) => item.user_id === user);
          cursor = page.nextCursor;
        } while (!grant && cursor);
        if (!controller.signal.aborted) {
          setBits(
            grant
              ? {
                  canRead: !!grant.can_read,
                  canSend: !!grant.can_send,
                  canManage: !!grant.can_manage,
                }
              : empty,
          );
          setReady(true);
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(adminError(e));
          if (accessLost(e)) onDenied(e);
        }
      }
    })();
    return () => controller.abort();
  }, [tenant, identity, user, onDenied]);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    onReview({
      title: "Alterar permissões de conteúdo",
      description: (
        <>
          <p>
            Usuário{" "}
            <strong>
              {members.find((member) => member.user_id === user)?.username ??
                user}
            </strong>
            , caixa{" "}
            <strong>
              {mailboxes.find((box) => box.id === identity)?.address ??
                identity}
            </strong>
            , organização <strong>{tenant}</strong>.
          </p>
          <ul>
            <li>Leitura: {bits.canRead ? "Sim" : "Não"}</li>
            <li>Envio: {bits.canSend ? "Sim" : "Não"}</li>
            <li>Gerenciamento: {bits.canManage ? "Sim" : "Não"}</li>
          </ul>
          <p>
            Gerenciamento geral exige também leitura. Esta alteração não concede
            papel administrativo nem ativa a caixa.
          </p>
        </>
      ),
      path:
        organizationPath(tenant) +
        "/mailboxes/" +
        encodeURIComponent(identity) +
        "/grants/" +
        encodeURIComponent(user),
      method: "PUT",
      body: bits,
    });
  }
  return (
    <form
      className="admin-form"
      onSubmit={submit}
      aria-label="Editar permissões de conteúdo"
    >
      <label htmlFor="grant-mailbox">
        Caixa postal
        <select
          id="grant-mailbox"
          aria-label="Caixa postal"
          value={identity}
          onChange={(e) => {
            setReady(false);
            setIdentity(e.target.value);
          }}
          required
        >
          <option value="">Selecione uma caixa</option>
          {mailboxes.map((box) => (
            <option value={box.id} key={box.id}>
              {box.address}
              {box.status === "active" ? "" : " · desativada"}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor="grant-user">
        Usuário
        <select
          id="grant-user"
          aria-label="Usuário"
          value={user}
          onChange={(e) => {
            setReady(false);
            setUser(e.target.value);
          }}
          required
        >
          <option value="">Selecione um usuário</option>
          {members.map((member) => (
            <option value={member.user_id} key={member.user_id}>
              {member.username}
              {member.status === "active" ? "" : " · suspenso"}
            </option>
          ))}
        </select>
      </label>
      <p className="admin-help admin-form-wide">
        As opções usam os registros carregados acima. Use “Carregar mais” nas
        listas de caixas/usuários para acessar outras páginas.
      </p>
      <fieldset className="admin-form-wide" disabled={!ready}>
        <legend>Permissões explícitas</legend>
        {(
          [
            ["canRead", "Ler mensagens"],
            ["canSend", "Enviar mensagens"],
            ["canManage", "Gerenciar mensagens"],
          ] as const
        ).map(([key, label]) => (
          <label className="admin-check" key={key}>
            <input
              type="checkbox"
              checked={bits[key]}
              onChange={(e) =>
                setBits((current) => ({ ...current, [key]: e.target.checked }))
              }
            />
            {label}
          </label>
        ))}
      </fieldset>
      {identity && user && !ready && !error ? (
        <p role="status">Consultando permissões atuais…</p>
      ) : null}
      {error ? (
        <p role="alert" className="mail-error admin-form-wide">
          {error}
        </p>
      ) : null}
      <button className="secondary-button" type="submit" disabled={!ready}>
        Revisar permissões
      </button>
    </form>
  );
}
