import type { Metadata } from "next";
import { AdminClient } from "@/app/components/AdminClient";

export const metadata: Metadata = { title: "内容目录管理", robots: { index: false, follow: false } };

export default function AdminPage() {
  return <AdminClient />;
}
