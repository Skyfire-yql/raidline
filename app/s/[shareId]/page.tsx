import type { Metadata } from "next";
import { SharedPlanClient } from "@/app/components/SharedPlanClient";

export const metadata: Metadata = { title: "只读排轴" };

export default async function SharedPlanPage({ params }: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await params;
  return <SharedPlanClient shareId={shareId} />;
}
