import Link from "next/link";
import { MessageCircle, Hash, LayoutDashboard } from "lucide-react";
import { FloomMark } from "@/components/layout/sidebar";

export const metadata = { title: "Start · Floom" };

// §5c / #817: channel-first onboarding — start where you already work. Full
// sign-in-free provisioning depends on backend (#762/#733/#800); until then
// these route through the install flow (sign in once, then install — #552).
const OPTIONS = [
  {
    href: "/login?install=slack",
    title: "Start in Slack",
    desc: "Install Floom in your Slack and DM Emily to get going.",
    Icon: Hash,
  },
  {
    href: "/login?install=whatsapp",
    title: "Start in WhatsApp",
    desc: "Text Emily on WhatsApp — no dashboard required.",
    Icon: MessageCircle,
  },
  {
    href: "/login",
    title: "Use the dashboard",
    desc: "Sign in and set up workers from the web app.",
    Icon: LayoutDashboard,
  },
];

export default function StartPage() {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-5 py-12">
      <div className="mb-8 flex items-center gap-2">
        <FloomMark size={22} />
        <span className="text-base font-semibold tracking-tight">Floom</span>
      </div>

      <h1 className="text-2xl font-semibold tracking-tight">Start where you work.</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">
        Pick a channel and Emily comes to you — or open the full dashboard.
      </p>

      <div className="mt-7 space-y-3">
        {OPTIONS.map(({ href, title, desc, Icon }) => (
          <Link
            key={title}
            href={href}
            className="flex items-center gap-4 rounded-[var(--radius-card)] [border:var(--bd-card)] bg-[var(--bg-card)] p-4 transition-colors hover:bg-[var(--bg-2)]"
          >
            <div className="grid size-10 shrink-0 place-items-center rounded-[var(--radius-button)] bg-[var(--bg-2)] text-[var(--ink-soft)]">
              <Icon className="size-5" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium">{title}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
            </div>
          </Link>
        ))}
      </div>

      <p className="mt-6 text-xs text-muted-foreground">
        Already set up? <Link href="/login" className="text-[var(--accent)] hover:underline">Sign in</Link>.
      </p>
    </div>
  );
}
