import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const base = new URL(`${protocol}://${host}`);
  return {
    metadataBase: base,
    title: { default: "团轴 Raidline", template: "%s｜团轴 Raidline" },
    description: "简洁的魔兽世界团本机制与团队技能排轴工具。",
    applicationName: "团轴 Raidline",
    icons: { icon: "/og.png", shortcut: "/og.png" },
    openGraph: {
      title: "团轴 Raidline",
      description: "把每一次减伤放在正确的秒数。",
      type: "website",
      locale: "zh_CN",
      images: [{ url: new URL("/og.png", base).toString(), width: 1200, height: 630, alt: "团轴 Raidline 团本排轴工具" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "团轴 Raidline",
      description: "把每一次减伤放在正确的秒数。",
      images: [new URL("/og.png", base).toString()],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const themeBoot = `(function(){try{var m=localStorage.getItem('raidline:theme')||'system';var d=m==='dark'||(m==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.themeMode=m;document.documentElement.dataset.theme=d?'dark':'light'}catch(e){document.documentElement.dataset.theme='dark'}})()`;
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeBoot }} /></head>
      <body>{children}</body>
    </html>
  );
}
