"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Activity, Box, Clock, KeyRound, Settings, Menu, X, Plug } from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeModeButton } from "@/components/ThemeModeButton";

const nav = [
  { href: "/", label: "Overview", icon: Activity },
  { href: "/workers", label: "Workers", icon: Box },
  { href: "/runs", label: "Runs", icon: Clock },
  { href: "/secrets", label: "Secrets", icon: KeyRound },
  { href: "/connections", label: "Connections", icon: Plug },
  { href: "/settings", label: "Settings", icon: Settings },
];

function NavLinks({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav className="flex-1 px-3 space-y-0.5">
      {nav.map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + "/");
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              "flex h-9 items-center gap-2.5 rounded-md border px-2.5 text-sm font-medium transition-[background,border-color,color] duration-150 ease-[var(--ease)]",
              active
                ? "border-[color-mix(in_srgb,var(--accent)_18%,transparent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] text-ink shadow-none [&_svg]:text-[var(--accent)] [&_svg]:opacity-100"
                : "border-transparent text-[var(--ink-soft)] hover:bg-[color-mix(in_srgb,var(--paper)_62%,transparent)] hover:text-ink [&_svg]:opacity-65"
            )}
          >
            <item.icon className="w-4 h-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close mobile nav on route changes; wrap in a callback to avoid
  // "setState synchronously inside an effect" lint rule
  useEffect(() => {
    const close = () => setOpen(false);
    close();
  }, [pathname]);

  return (
    <>
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-[var(--accent-line)] bg-[var(--sidebar-glass)] px-4 shadow-[var(--sidebar-glass-shadow)] backdrop-blur-[14px] backdrop-saturate-[140%] md:hidden">
        <Link href="/" className="flex items-center gap-2">
          <Image src="/floom-mark.png" width={28} height={28} alt="Floom" className="rounded-md" />
          <span className="font-semibold text-[15px] tracking-tight">Floom</span>
        </Link>
        <div className="flex items-center gap-2">
          <ThemeModeButton className="theme-mode-button-compact" />
          <button
            type="button"
            aria-label="Open navigation"
            onClick={() => setOpen(true)}
            className="inline-flex h-11 w-11 items-center justify-center rounded-md text-[var(--ink-soft)] hover:bg-[var(--bg-2)] hover:text-ink"
          >
            <Menu className="w-5 h-5" />
          </button>
        </div>
      </header>

      <aside className="sticky top-0 z-20 hidden h-screen w-60 flex-col border-r border-[var(--accent-line)] bg-[var(--sidebar-glass)] shadow-[var(--sidebar-glass-shadow)] backdrop-blur-[14px] backdrop-saturate-[140%] md:flex">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/70 dark:bg-white/[0.055]" aria-hidden="true" />
        <div className="px-5 py-6">
          <Link href="/" className="flex items-center gap-2">
            <Image src="/floom-mark.png" width={28} height={28} alt="Floom" className="rounded-md" />
            <span className="font-semibold text-[15px] tracking-tight">Floom</span>
          </Link>
        </div>
        <NavLinks pathname={pathname} />
        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-4 text-xs text-[var(--ink-mute)]">
          <span>Floom v0</span>
          <ThemeModeButton />
        </div>
      </aside>

      {open && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative z-50 flex h-full w-64 max-w-[80vw] flex-col border-r border-[var(--accent-line)] bg-[var(--sidebar-glass)] shadow-pop backdrop-blur-[14px] backdrop-saturate-[140%]">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/70 dark:bg-white/[0.055]" aria-hidden="true" />
            <div className="flex items-center justify-between border-b border-[var(--accent-line)] px-5 py-4">
              <Link href="/" className="flex items-center gap-2" onClick={() => setOpen(false)}>
                <Image src="/floom-mark.png" width={28} height={28} alt="Floom" className="rounded-md" />
                <span className="font-semibold text-[15px] tracking-tight">Floom</span>
              </Link>
              <button
                type="button"
                aria-label="Close navigation"
                onClick={() => setOpen(false)}
                className="inline-flex h-11 w-11 items-center justify-center rounded-md text-[var(--ink-soft)] hover:bg-[var(--bg-2)] hover:text-ink"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="py-3 flex-1 overflow-auto">
              <NavLinks pathname={pathname} onNavigate={() => setOpen(false)} />
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-4 text-xs text-[var(--ink-mute)]">
              <span>Floom v0</span>
              <ThemeModeButton />
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
