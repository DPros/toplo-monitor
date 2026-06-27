"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn } from "@/lib/auth";

export async function credentialsSignIn(formData: FormData): Promise<void> {
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo: "/cabinet",
    });
  } catch (error) {
    // signIn throws a redirect on success; only treat auth failures as errors.
    if (error instanceof AuthError) redirect("/signin?error=1");
    throw error;
  }
}

export async function googleSignIn(): Promise<void> {
  await signIn("google", { redirectTo: "/cabinet" });
}
