"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Activity, Box, Clock, KeyRound, Settings, Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";

const nav = [
  { href: "/", label: "Overview", icon: Activity },
  { href: "/workers", label: "Workers", icon: Box },
  { href: "/runs", label: "Runs", icon: Clock },
  { href: "/secrets", label: "Secrets", icon: KeyRound },
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
              "flex min-h-11 items-center gap-2.5 rounded-md border-l px-3 py-2 text-sm transition-all duration-150 ease-[var(--ease)]",
              active
                ? "border-[var(--accent-line)] bg-[var(--accent-soft)] font-medium text-ink shadow-sm"
                : "border-transparent text-[var(--ink-soft)] hover:bg-[var(--bg-2)] hover:text-ink"
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

  // Close mobile nav on route changes — wrap in a callback to avoid
  // "setState synchronously inside an effect" lint rule
  useEffect(() => {
    const close = () => setOpen(false);
    close();
  }, [pathname]);

  return (
    <>
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-[var(--sidebar-glass)] px-4 shadow-sm backdrop-blur-xl md:hidden">
        <Link href="/" className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--solid)] text-sm font-bold text-[var(--solid-fg)] shadow-btn">
            F
          </div>
          <span className="font-semibold text-[15px] tracking-tight">Floom</span>
        </Link>
        <button
          type="button"
          aria-label="Open navigation"
          onClick={() => setOpen(true)}
          className="inline-flex h-11 w-11 items-center justify-center rounded-md text-[var(--ink-soft)] hover:bg-[var(--bg-2)] hover:text-ink"
        >
          <Menu className="w-5 h-5" />
        </button>
      </header>

      <aside className="sticky top-0 hidden h-screen w-60 flex-col border-r border-line bg-[var(--sidebar-glass)] shadow-[var(--sidebar-glass-shadow)] backdrop-blur-xl md:flex">
        <div className="px-5 py-6">
          <Link href="/" className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--solid)] text-sm font-bold text-[var(--solid-fg)] shadow-btn">
              F
            </div>
            <span className="font-semibold text-[15px] tracking-tight">Floom</span>
          </Link>
        </div>
        <NavLinks pathname={pathname} />
        <div className="border-t border-line px-5 py-4 text-xs text-[var(--ink-mute)]">Floom v0</div>
      </aside>

      {open && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative z-50 flex h-full w-64 max-w-[80vw] flex-col border-r border-line bg-[var(--paper)] shadow-pop">
            <div className="flex items-center justify-between border-b border-line px-5 py-4">
              <Link href="/" className="flex items-center gap-2" onClick={() => setOpen(false)}>
                <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--solid)] text-sm font-bold text-[var(--solid-fg)] shadow-btn">
                  F
                </div>
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
            <div className="border-t border-line px-5 py-4 text-xs text-[var(--ink-mute)]">Floom v0</div>
          </aside>
        </div>
      )}
    </>
  );
}
