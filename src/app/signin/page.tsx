import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { credentialsSignIn, googleSignIn } from "./actions";

const formStyle = { display: "grid", gap: 8, marginTop: 12 } as const;

export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; registered?: string }>;
}) {
  if ((await auth())?.user) redirect("/cabinet");
  const { error, registered } = await searchParams;
  const googleEnabled = Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);

  return (
    <main style={{ maxWidth: 380, margin: "4rem auto", padding: "0 1rem" }}>
      <h1>Sign in</h1>
      {registered && <p style={{ color: "green" }}>Account created — sign in below.</p>}
      {error && <p style={{ color: "crimson" }}>Invalid email or password.</p>}

      <form action={credentialsSignIn} style={formStyle}>
        <input name="email" type="email" placeholder="Email" required />
        <input name="password" type="password" placeholder="Password" required />
        <button type="submit">Sign in</button>
      </form>

      {googleEnabled && (
        <form action={googleSignIn} style={{ marginTop: 12 }}>
          <button type="submit">Sign in with Google</button>
        </form>
      )}

      <p style={{ marginTop: 16 }}>
        No account? <a href="/signup">Create one</a>
      </p>
    </main>
  );
}
