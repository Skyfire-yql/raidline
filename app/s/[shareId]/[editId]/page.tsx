import type { Metadata } from "next";
import { PublishedEditClient } from "@/app/components/PublishedEditClient";

export const metadata: Metadata = { title: "载入发布版本" };

export default async function PublishedEditPage({ params }: { params: Promise<{ shareId: string; editId: string }> }) {
  const { shareId, editId } = await params;
  return <PublishedEditClient shareId={shareId} editId={editId} />;
}
