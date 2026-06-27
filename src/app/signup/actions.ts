"use server";

import bcrypt from "bcryptjs";
import { z } from "zod";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";

const schema = z.object({
  name: z.string().trim().max(80).optional(),
  email: z.string().email(),
  password: z.string().min(8),
});

export type SignupState = { error?: string };

export async function signup(_prev: SignupState, formData: FormData): Promise<SignupState> {
  const parsed = schema.safeParse({
    name: formData.get("name") || undefined,
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: "Enter a valid email and a password of at least 8 characters." };
  }
  const { name, email, password } = parsed.data;

  if (await prisma.user.findUnique({ where: { email } })) {
    return { error: "An account with that email already exists." };
  }
  await prisma.user.create({
    data: { email, name: name ?? null, passwordHash: await bcrypt.hash(password, 10) },
  });
  redirect("/signin?registered=1");
}
