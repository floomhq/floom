"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { clsx } from "clsx";

export function Nav() {
  const pathname = usePathname();

  const links = [
    { href: "/gallery", label: "Gallery" },
    { href: "/settings", label: "Settings" },
  ];

  return (
    <nav className="flex items-center justify-between h-12 px-4 border-b border-gray-200 bg-white">
      <Link
        href="/gallery"
        className="font-semibold text-sm text-gray-900 hover:text-primary"
      >
        deploy-skill
      </Link>

      <div className="flex items-center gap-1">
        {links.map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            className={clsx(
              "px-3 py-1.5 rounded text-sm font-medium transition-colors",
              pathname === href || pathname.startsWith(href + "/")
                ? "bg-gray-100 text-gray-900"
                : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
            )}
          >
            {label}
          </Link>
        ))}
        <div className="ml-2">
          <UserButton />
        </div>
      </div>
    </nav>
  );
}
