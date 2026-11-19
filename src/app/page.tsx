import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthGuard } from "@/components/auth/auth-guard";
import { hasAdminAccount } from "@/lib/auth/setup";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { LoginClient } from "./(auth)/login/login-client";
import { getHomeBranding } from "./home-server-utils";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const branding = await getHomeBranding();
  return {
    title: branding.appName,
    icons: { icon: branding.hasCustomIcon ? "/api/branding/icon" : "/icon-96.png" },
  };
}

export default async function HomePage() {
  const env = getEnv();
  if (!(await hasAdminAccount(env))) redirect("/setup");
  const user = await getCurrentUser(env).catch(() => null);
  if (user) redirect("/inbox");

  return (
    <AuthGuard mode="public">
      <LoginClient centered />
    </AuthGuard>
  );
}
