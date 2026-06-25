import { AuthButton } from "@/components/AuthButton";
import { LoginEmailPanel } from "@/components/LoginEmailPanel";
import { safeAppNext } from "@/lib/safe-next";
import { LoginView } from "../../shared/LoginView";

export const metadata = {
  title: "Sign in · Floom Workers",
};

// Same-origin proxy keeps PKCE + session cookies on the dashboard host
// (floom.dev/app), not the Railway API subdomain.
const PROXY_BASE = process.env.NEXT_PUBLIC_API_PROXY_BASE || "/app/api/proxy";

const oauthLoginUrl = (provider: "google" | "github", next = "/app", switchAccount = false) => {
  const params = new URLSearchParams({
    provider,
    next: safeAppNext(next),
  });
  if (switchAccount) params.set("switch", "1");
  return `${PROXY_BASE}/auth/login?${params.toString()}`;
};

const INSTALL_ROUTES: Record<string, string> = {
  slack: "/app/install/slack",
  whatsapp: "/app/install/whatsapp",
  discord: "/app/install/discord",
  cli: "/app/install/cli",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<{ next?: string; mode?: string; install?: string; switch?: string }>;
}) {
  // Next 16: searchParams is always a Promise in server components.
  const sp = (await searchParams) ?? {};
  const install = typeof sp.install === "string" ? sp.install.toLowerCase() : "";
  const next = install && INSTALL_ROUTES[install] ? INSTALL_ROUTES[install] : safeAppNext(sp.next);
  const initialMode = sp.mode === "signup" || sp.mode === "signin" ? sp.mode : "magic";
  const switchAccount = sp.switch === "1" || sp.switch === "true";
  const signupHref = `/login?mode=signup&next=${encodeURIComponent(next)}${
    install ? `&install=${encodeURIComponent(install)}` : ""
  }`;

  return (
    <LoginView
      install={install}
      googleHref={oauthLoginUrl("google", next, switchAccount)}
      githubHref={oauthLoginUrl("github", next, switchAccount)}
      authButton={AuthButton}
      emailPanel={<LoginEmailPanel next={next} initialMode={initialMode} />}
      signupHref={signupHref}
    />
  );
}
