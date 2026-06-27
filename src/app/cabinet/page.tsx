import { redirect } from "next/navigation";
import { auth, signOut } from "@/lib/auth";

export default async function Cabinet() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  return (
    <main style={{ maxWidth: 640, margin: "3rem auto", padding: "0 1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Your cabinet</h1>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/" });
          }}
        >
          <button type="submit">Sign out</button>
        </form>
      </div>
      <p>
        Signed in as <strong>{session.user.email ?? session.user.name}</strong>.
      </p>
      <p style={{ color: "#888" }}>Address management &amp; the Leaflet map land in the next phase.</p>
    </main>
  );
}
