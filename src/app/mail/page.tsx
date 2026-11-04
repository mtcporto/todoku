import type { Metadata } from "next";
import MailApp from "./mail-app";
import "./mail.css";
export const metadata: Metadata = {
  title: "Todoku Mail — Sua caixa unificada",
  robots: { index: false, follow: false },
};
export default function MailPage() {
  return <MailApp />;
}
