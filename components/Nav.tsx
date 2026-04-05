"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton, OrganizationSwitcher } from "@clerk/nextjs";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

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
        floom
      </Link>

      <div className="flex items-center gap-1">
        {links.map(({ href, label }) => {
          const isActive =
            pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                buttonVariants({ variant: "ghost", size: "sm" }),
                isActive && "bg-muted text-foreground"
              )}
            >
              {label}
            </Link>
          );
        })}

        <Separator orientation="vertical" className="mx-1.5 h-5" />

        <OrganizationSwitcher
          hidePersonal={false}
          afterSelectOrganizationUrl="/gallery"
          afterSelectPersonalUrl="/gallery"
          appearance={{
            elements: {
              rootBox: "",
              organizationSwitcherTrigger:
                "px-2 py-1 rounded text-sm text-gray-600 hover:bg-gray-50 border border-gray-200 transition-colors",
            },
          }}
        />
        <div className="ml-1">
          <UserButton />
        </div>
      </div>
    </nav>
  );
}
