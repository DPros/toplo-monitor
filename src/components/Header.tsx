import Link from "next/link";
import { auth, signOut } from "@/lib/auth";

export default async function Header() {
  const session = await auth();

  return (
    <header style={{ borderBottom: "1px solid #eaeaea", background: "#fff" }}>
      <nav
        style={{
          maxWidth: 960,
          margin: "0 auto",
          padding: "12px 1rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Link href="/" style={{ fontWeight: 700, fontSize: 18, color: "#c0392b" }}>
          🔥 Toplo Monitor
        </Link>

        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          {session?.user ? (
            <>
              <Link href="/cabinet" className="nav-link">
                My addresses
              </Link>
              <span style={{ color: "#999", fontSize: 14 }}>{session.user.email}</span>
              <form
                action={async () => {
                  "use server";
                  await signOut({ redirectTo: "/" });
                }}
              >
                <button type="submit">Sign out</button>
              </form>
            </>
          ) : (
            <>
              <Link href="/signin" className="nav-link">
                Sign in
              </Link>
              <Link href="/signup" className="btn-primary">
                Sign up
              </Link>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}
