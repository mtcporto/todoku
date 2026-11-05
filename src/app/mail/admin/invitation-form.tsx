"use client";
import { useState, type FormEvent } from "react";
import type { Action } from "./admin-panel";
export default function InvitationForm({
  base,
  tenant,
  onReview,
}: {
  base: string;
  tenant: string;
  onReview: (action: Action) => void;
}) {
  const [email, setEmail] = useState(""),
    [userId, setUserId] = useState(""),
    [hours, setHours] = useState(24);
  function submit(event: FormEvent) {
    event.preventDefault();
    onReview({
      title: "Criar convite",
      description: (
        <>
          <p>
            Endereço <strong>{email}</strong>, organização{" "}
            <strong>{tenant}</strong>, validade de{" "}
            <strong>{hours} horas</strong>.
          </p>
          {userId ? (
            <p>
              Alvo interno explícito: <strong>{userId}</strong>. A aceitação
              exigirá prova desse usuário existente.
            </p>
          ) : null}
          <p>
            Um link pessoal será exibido uma única vez, sem envio automático.
            Aceitar cria apenas a membership; nenhum grant ou papel
            administrativo será concedido.
          </p>
        </>
      ),
      path: base + "/invitations",
      method: "POST",
      body: { email, ...(userId ? { userId } : {}), expiresInHours: hours },
    });
  }
  return (
    <form onSubmit={submit} className="admin-form" aria-label="Criar convite">
      <label htmlFor="invite-email">
        E-mail convidado
        <input
          id="invite-email"
          type="email"
          autoComplete="off"
          required
          maxLength={254}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <label htmlFor="invite-hours">
        Validade em horas
        <input
          id="invite-hours"
          type="number"
          required
          min={1}
          max={168}
          value={hours}
          onChange={(e) => setHours(Number(e.target.value))}
        />
      </label>
      <details className="admin-form-wide">
        <summary>Convidar um usuário interno existente</summary>
        <label htmlFor="invite-user">
          UUID do usuário existente (opcional)
          <input
            id="invite-user"
            autoComplete="off"
            maxLength={100}
            value={userId}
            onChange={(e) => setUserId(e.target.value.trim())}
          />
        </label>
        <p className="admin-help">
          Use somente um ID conhecido e autorizado. Ele pode ser consultado na
          lista de usuários de outra organização que você administra. Quem já
          pertence a esta organização deve ter sua membership gerenciada na
          lista, sem novo convite.
        </p>
      </details>
      <button type="submit" className="secondary-button">
        Revisar convite
      </button>
    </form>
  );
}
