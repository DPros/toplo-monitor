"use client";

import { useActionState } from "react";
import { signup, type SignupState } from "./actions";

const initial: SignupState = {};

export default function SignUp() {
  const [state, action, pending] = useActionState(signup, initial);

  return (
    <main style={{ maxWidth: 380, margin: "4rem auto", padding: "0 1rem" }}>
      <h1>Create account</h1>
      {state.error && <p style={{ color: "crimson" }}>{state.error}</p>}

      <form action={action} style={{ display: "grid", gap: 8, marginTop: 12 }}>
        <input name="name" placeholder="Name (optional)" />
        <input name="email" type="email" placeholder="Email" required />
        <input name="password" type="password" placeholder="Password (min 8 chars)" required minLength={8} />
        <button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create account"}
        </button>
      </form>

      <p style={{ marginTop: 16 }}>
        Have an account? <a href="/signin">Sign in</a>
      </p>
    </main>
  );
}
