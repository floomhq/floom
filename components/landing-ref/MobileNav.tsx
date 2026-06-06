"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

export function MobileNav({
  links,
}: {
  links: Array<{ label: string; href: string }>;
}) {
  const [open, setOpen] = useState(false);

  // Lock body scroll while the panel is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] border border-border/70 bg-card text-foreground/85 transition hover:border-foreground/30 hover:text-foreground md:hidden"
      >
        {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
      </button>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-40 bg-background/70 backdrop-blur-sm md:hidden"
            />
            <motion.nav
              key="panel"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="fixed inset-x-3 top-16 z-50 overflow-hidden rounded-[14px] border border-border bg-card shadow-[0_24px_60px_-20px_rgba(20,20,20,0.18)] md:hidden"
              aria-label="Main navigation"
            >
              <ul className="flex flex-col py-1.5">
                {links.map((l) => (
                  <li key={l.label}>
                    <Link
                      href={l.href}
                      onClick={() => setOpen(false)}
                      className="block px-5 py-3 text-[15px] font-medium text-foreground transition-colors hover:bg-secondary/60"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
                <li className="mx-3 my-1 border-t border-border/60" />
                <li>
                  <Link
                    href="/templates"
                    onClick={() => setOpen(false)}
                    className="mx-3 mb-2 mt-1 inline-flex h-10 items-center justify-center rounded-[10px] px-4 text-[14px] font-semibold text-white"
                    style={{ background: "#3a6ea5" }}
                  >
                    Browse templates
                  </Link>
                </li>
              </ul>
            </motion.nav>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
