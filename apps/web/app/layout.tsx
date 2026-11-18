import "./globals.css";
import type { ReactNode } from "react";

export const metadata = { title: "Local Audit Agent" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" className="dark">
      <body className="bg-background text-foreground">{children}</body>
    </html>
  );
}
