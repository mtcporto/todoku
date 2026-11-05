"use client";
import { useEffect, useRef, type ReactNode } from "react";

export default function ConfirmAction({
  title,
  children,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  title: string;
  children: ReactNode;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    cancel.current?.focus();
    return () => {
      dialog.current?.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="admin-confirm"
      aria-labelledby="admin-confirm-title"
      aria-describedby="admin-confirm-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id="admin-confirm-title">{title}</h2>
      <div id="admin-confirm-description">{children}</div>
      {error ? (
        <p className="mail-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="admin-actions">
        <button
          ref={cancel}
          className="secondary-button"
          type="button"
          disabled={busy}
          onClick={onCancel}
        >
          Cancelar
        </button>
        <button
          className="compose-button"
          type="button"
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? "Aplicando…" : "Confirmar alteração"}
        </button>
      </div>
    </dialog>
  );
}
