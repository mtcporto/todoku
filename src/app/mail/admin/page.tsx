import type { Metadata } from "next";
import AdminPanel from "./admin-panel";
import "../mail.css";
import "./admin.css";
export const metadata: Metadata = {
  title: "Todoku Mail — Administração",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
// Like /mail, this page serves only a data-free shell. The existing session and
// scoped administrative APIs authorize every read/mutation; no credentials in props.
export default function MailAdministrationPage() {
  return <AdminPanel />;
}
