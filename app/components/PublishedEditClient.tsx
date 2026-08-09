"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ApiError, PublicPublication, PublicationBinding } from "@/lib/types";
import { createLocalPlan } from "./local-store";

export function PublishedEditClient({ shareId, editId }: { shareId: string; editId: string }) {
  const router = useRouter();
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/publications/${shareId}/${editId}`).then(async (response) => {
      const payload = await response.json() as { data?: PublicPublication & { editId: string; binding: PublicationBinding }; error?: ApiError };
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "编辑链接不可用");
      const local = await createLocalPlan(payload.data.document, payload.data.binding);
      if (!cancelled) router.replace(`/plans/${local.id}`);
    }).catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : "编辑链接不可用"); });
    return () => { cancelled = true; };
  }, [editId, router, shareId]);

  if (error) return <main className="state-page"><div className="state-card"><h1>无法载入编辑版本</h1><p>{error}</p><a className="primary-action" href={`/s/${shareId}`}>打开只读版本</a></div></main>;
  return <main className="state-page"><p>正在把服务器版本复制到当前浏览器…</p></main>;
}
