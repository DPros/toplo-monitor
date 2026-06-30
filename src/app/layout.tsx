import type { ReactNode } from "react";
import "./globals.css";
import Header from "@/components/Header";

export const metadata = {
  title: "Toplo Monitor",
  description: "Hot-water & heating outage alerts for Sofia (toplo.bg)",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Header />
        {children}
      </body>
    </html>
  );
}
