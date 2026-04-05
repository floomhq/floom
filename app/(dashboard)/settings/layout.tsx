"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { Nav } from "@/components/Nav";

const sections = [
  { href: "/settings/api-key", label: "API Key" },
  { href: "/settings/secrets", label: "Workspace Secrets" },
];

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <Nav />
      <div className="max-w-4xl mx-auto w-full px-4 py-6 flex-1">
        <h1 className="text-lg font-semibold text-gray-900 mb-6">Settings</h1>
        <div className="flex gap-6">
          {/* Sidebar nav */}
          <nav className="w-40 shrink-0">
            <ul className="space-y-1">
              {sections.map((s) => (
                <li key={s.href}>
                  <Link
                    href={s.href}
                    className={`block w-full text-left px-3 py-2 rounded text-sm transition-colors ${
                      pathname === s.href
                        ? "bg-gray-100 text-gray-900 font-medium"
                        : "text-gray-600 hover:text-gray-900"
                    }`}
                  >
                    {s.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          {/* Content */}
          <div className="flex-1 min-w-0">{children}</div>
        </div>
      </div>
    </div>
  );
}
