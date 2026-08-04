import type { Metadata } from "next";
import { EditorClient } from "@/app/components/EditorClient";

export const metadata: Metadata = { title: "编辑排轴" };

export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EditorClient planId={id} />;
}
