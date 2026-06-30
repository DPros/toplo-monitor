import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import AddAddressForm from "@/components/AddAddressForm";
import { deleteAddress } from "./actions";

export default async function Cabinet() {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  const addresses = await prisma.address.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "asc" },
  });

  return (
    <main style={{ maxWidth: 680, margin: "2.5rem auto", padding: "0 1rem" }}>
      <h1 style={{ margin: 0 }}>Your addresses</h1>
      <p style={{ color: "#666", marginTop: 4 }}>
        We email you when an outage covers one of your pins.
      </p>

      <section style={{ margin: "1.5rem 0" }}>
        {addresses.length === 0 ? (
          <p style={{ color: "#888" }}>No addresses yet — add your first below.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 10 }}>
            {addresses.map((a) => (
              <li
                key={a.id}
                style={{
                  border: "1px solid #e3e3e3",
                  borderRadius: 8,
                  padding: "10px 12px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div>
                  <strong>{a.label}</strong>
                  <div style={{ color: "#777", fontSize: 13 }}>
                    {a.neighborhood ? `${a.neighborhood} · ` : ""}
                    {a.lat?.toFixed(5)}, {a.lng?.toFixed(5)}
                  </div>
                </div>
                <form action={deleteAddress}>
                  <input type="hidden" name="id" value={a.id} />
                  <button type="submit" style={{ color: "crimson" }}>
                    Delete
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={{ borderTop: "1px solid #eee", paddingTop: "1.5rem" }}>
        <AddAddressForm />
      </section>
    </main>
  );
}
