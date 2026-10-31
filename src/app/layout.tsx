import { SoftNavigationBridge } from "@/components/soft-navigation";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BabulTech CRM",
  description: "Marketing, Sales, Partners, Support, Projects and Finance in one place.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <SoftNavigationBridge />{children}</body>
    </html>
  );
}
