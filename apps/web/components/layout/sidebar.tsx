"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Box, Clock, ShieldCheck, KeyRound, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

const nav = [
  { href: "/", label: "Overview", icon: Activity },
  { href: "/workers", label: "Workers", icon: Box },
  { href: "/runs", label: "Runs", icon: Clock },
  { href: "/approvals", label: "Approvals", icon: ShieldCheck },
  { href: "/secrets", label: "Secrets", icon: KeyRound },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-60 border-r border-[#eaeaea] bg-white sticky top-0 h-screen flex flex-col">
      <div className="px-5 py-6">
        <Link href="/" className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-md bg-[#111] text-white flex items-center justify-center text-sm font-bold">
            F
          </div>
          <span className="font-semibold text-[15px] tracking-tight">Floom</span>
        </Link>
      </div>
      <nav className="flex-1 px-3 space-y-0.5">
        {nav.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors",
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
      <div className="px-5 py-4 text-xs text-[#999]">
        Workeros
      </div>
    </aside>
  );
}
