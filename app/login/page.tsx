import { AuthButton } from "@/components/AuthButton";
import { LoginEmailPanel } from "@/components/LoginEmailPanel";
import { OAUTH_LOGIN_URL, OAUTH_LOGIN_URL_GITHUB } from "@/lib/api";
import { LoginView } from "../../web/shared/LoginView";

export const metadata = {
  title: "Sign in · Floom Workers",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<{ next?: string }>;
}) {
  const sp = (await searchParams) ?? {};
  const next = sp.next ?? "/app";

  return (
    <LoginView
      googleHref={OAUTH_LOGIN_URL(next)}
      githubHref={OAUTH_LOGIN_URL_GITHUB(next)}
      authButton={AuthButton}
      emailPanel={<LoginEmailPanel next={next} />}
    />
  );
}
