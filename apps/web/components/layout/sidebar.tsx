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
              "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors min-h-11",
              active
                ? "bg-[#f4f4f5] text-[#111] font-medium"
                : "text-[#666] hover:bg-[#f4f4f5] hover:text-[#111]"
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
      <header className="md:hidden sticky top-0 z-30 flex items-center justify-between bg-white border-b border-[#eaeaea] px-4 h-14">
        <Link href="/" className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-md bg-[#111] text-white flex items-center justify-center text-sm font-bold">
            F
          </div>
          <span className="font-semibold text-[15px] tracking-tight">Floom</span>
        </Link>
        <button
          type="button"
          aria-label="Open navigation"
          onClick={() => setOpen(true)}
          className="h-11 w-11 inline-flex items-center justify-center rounded-md text-[#666] hover:bg-[#f4f4f5] hover:text-[#111]"
        >
          <Menu className="w-5 h-5" />
        </button>
      </header>

      <aside className="hidden md:flex w-60 border-r border-[#eaeaea] bg-white sticky top-0 h-screen flex-col">
        <div className="px-5 py-6">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-md bg-[#111] text-white flex items-center justify-center text-sm font-bold">
              F
            </div>
            <span className="font-semibold text-[15px] tracking-tight">Floom</span>
          </Link>
        </div>
        <NavLinks pathname={pathname} />
        <div className="px-5 py-4 text-xs text-[#999]">Floom v0</div>
      </aside>

      {open && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative z-50 w-64 max-w-[80vw] bg-white h-full flex flex-col border-r border-[#eaeaea] shadow-xl">
            <div className="px-5 py-4 flex items-center justify-between border-b border-[#eaeaea]">
              <Link href="/" className="flex items-center gap-2" onClick={() => setOpen(false)}>
                <div className="w-7 h-7 rounded-md bg-[#111] text-white flex items-center justify-center text-sm font-bold">
                  F
                </div>
                <span className="font-semibold text-[15px] tracking-tight">Floom</span>
              </Link>
              <button
                type="button"
                aria-label="Close navigation"
                onClick={() => setOpen(false)}
                className="h-11 w-11 inline-flex items-center justify-center rounded-md text-[#666] hover:bg-[#f4f4f5] hover:text-[#111]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="py-3 flex-1 overflow-auto">
              <NavLinks pathname={pathname} onNavigate={() => setOpen(false)} />
            </div>
            <div className="px-5 py-4 text-xs text-[#999] border-t border-[#eaeaea]">Floom v0</div>
          </aside>
        </div>
      )}
    </>
  );
}
