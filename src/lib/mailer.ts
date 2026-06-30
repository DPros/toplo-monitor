import nodemailer, { type Transporter } from "nodemailer";

/** Build an SMTP transport from env, or null if SMTP isn't configured. */
export function getTransport(): Transporter | null {
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT ?? "587");
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // 465 = implicit TLS; 587/25 = STARTTLS
    auth: user && pass ? { user, pass } : undefined,
  });
}

export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  const t = getTransport();
  if (!t) throw new Error("SMTP not configured (SMTP_HOST missing)");
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER || "toplo-monitor";
  await t.sendMail({ from, to, subject, text });
}
