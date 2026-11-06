import type { Metadata } from "next";
import Profile from "./profile";
import "../mail.css";
import "../admin/admin.css";
export const metadata: Metadata = {
  title: "Meu perfil — Todoku Mail",
  robots: { index: false, follow: false },
};
export default function Page() {
  return <Profile />;
}
