import type { Metadata } from "next";
import { HomeClient } from "./components/HomeClient";

export const metadata: Metadata = {
  title: "团轴 Raidline｜把每一次减伤放在正确的秒数",
  description: "为魔兽世界团本设计的个人排轴工具，支持手动编排、WCL 战报导入、冲突提醒和 MRT 文本导出。",
};

export default function Home() {
  return <HomeClient />;
}
