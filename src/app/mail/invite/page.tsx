import type { Metadata } from "next";
import InviteAcceptance from "./invite-acceptance";
import "../mail.css";

export const metadata: Metadata = {
  title: "Todoku Mail — Aceitar convite",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export default function InvitationPage() {
  return <InviteAcceptance />;
}
