"use client";

import { ArrowRight } from "lucide-react";

export function ScrollToHeroButton({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        window.scrollTo({ top: 0, behavior: "smooth" });
        setTimeout(() => {
          const ta = document.querySelector<HTMLTextAreaElement>(
            'textarea[aria-label="Describe what your AI worker should do"]',
          );
          ta?.focus();
        }, 600);
      }}
      className={`group/cta inline-flex h-12 items-center justify-center gap-2 rounded-[12px] bg-[#3a6ea5] px-6 text-[15px] font-semibold text-white shadow-[0_8px_24px_-8px_rgba(58,110,165,0.55)] transition hover:-translate-y-px hover:shadow-[0_14px_36px_-10px_rgba(58,110,165,0.65)] ${className ?? ""}`}
    >
      {children}
      <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover/cta:translate-x-0.5" />
    </button>
  );
}
