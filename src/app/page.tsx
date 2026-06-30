import Link from "next/link";
import { auth } from "@/lib/auth";

const FEATURES: [string, string][] = [
  ["📍 Pin your address", "Drop a pin on the map; outages are matched to your exact location with point-in-polygon precision."],
  ["✉️ Email alerts", "Get notified when an outage starts and again when it's resolved — never spammed twice for the same one."],
  ["🛠️ Planned & emergency", "Covers scheduled maintenance and unplanned accidents, with start and expected-recovery times."],
];

export default async function Home() {
  const session = await auth();

  return (
    <main style={{ maxWidth: 760, margin: "3.5rem auto", padding: "0 1rem" }}>
      <section style={{ textAlign: "center" }}>
        <h1 style={{ fontSize: 36, lineHeight: 1.2, margin: "0 0 12px" }}>
          Never get caught out by a hot-water outage
        </h1>
        <p style={{ fontSize: 18, color: "#555", lineHeight: 1.6, maxWidth: 600, margin: "0 auto" }}>
          Toplo Monitor watches Toplofikatsia Sofia&rsquo;s outage feed and emails you the moment a planned or
          emergency hot-water / heating cut affects one of your addresses.
        </p>

        <div style={{ marginTop: 28, display: "flex", gap: 12, justifyContent: "center" }}>
          {session?.user ? (
            <Link href="/cabinet" className="btn-primary">
              Go to my addresses →
            </Link>
          ) : (
            <>
              <Link href="/signup" className="btn-primary">
                Get started
              </Link>
              <Link href="/signin" className="btn-ghost">
                Sign in
              </Link>
            </>
          )}
        </div>
      </section>

      <section style={{ marginTop: 48, display: "grid", gap: 14 }}>
        {FEATURES.map(([title, body]) => (
          <div key={title} style={{ border: "1px solid #eee", borderRadius: 10, padding: "14px 16px", background: "#fff" }}>
            <strong>{title}</strong>
            <p style={{ margin: "6px 0 0", color: "#666" }}>{body}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
