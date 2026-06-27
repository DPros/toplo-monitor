import type { ReactNode } from "react";

export const metadata = {
  title: "Toplo Monitor",
  description: "Hot-water & heating outage alerts for Sofia (toplo.bg)",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif" }}>{children}</body>
    </html>
  );
}
