"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

const createSchema = z.object({
  label: z.string().trim().min(1).max(80),
  neighborhood: z.string().trim().max(120).optional(),
  street: z.string().trim().max(120).optional(),
  houseNumber: z.string().trim().max(40).optional(),
  block: z.string().trim().max(40).optional(),
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});

export type CreateAddressState = { error?: string; ok?: boolean };

export async function createAddress(
  _prev: CreateAddressState,
  formData: FormData,
): Promise<CreateAddressState> {
  const session = await auth();
  if (!session?.user?.id) return { error: "You are not signed in." };

  const parsed = createSchema.safeParse({
    label: formData.get("label"),
    neighborhood: formData.get("neighborhood") || undefined,
    street: formData.get("street") || undefined,
    houseNumber: formData.get("houseNumber") || undefined,
    block: formData.get("block") || undefined,
    lat: formData.get("lat"),
    lng: formData.get("lng"),
  });
  if (!parsed.success) {
    return { error: "Add a label and drop a pin on the map to set the location." };
  }

  const d = parsed.data;
  await prisma.address.create({
    data: {
      userId: session.user.id,
      label: d.label,
      neighborhood: d.neighborhood ?? "",
      street: d.street ?? "",
      houseNumber: d.houseNumber ?? "",
      block: d.block ?? "",
      lat: d.lat,
      lng: d.lng,
      channels: ["email"],
    },
  });

  revalidatePath("/cabinet");
  return { ok: true };
}

export async function deleteAddress(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) return;
  const id = String(formData.get("id") ?? "");
  // Scope the delete to the owner so one user can't remove another's address.
  await prisma.address.deleteMany({ where: { id, userId: session.user.id } });
  revalidatePath("/cabinet");
}
