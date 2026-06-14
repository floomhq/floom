"use client";

/**
 * /integrations — the connections page, rebuilt to match the /v3/product
 * voice: a centered hero with a single <Hl> highlight, Reveal motion on every
 * beat, the product page's type scale and spacing, and a product-style close.
 * The full integrations catalog is unchanged; only the surrounding shell is
 * brought to product-page polish.
 */

import Link from "next/link";
import { motion } from "motion/react";
import { Hl, V3Shell } from "@/app/v3/V3Shell";
import "@/app/v3/theme.css";
import { IntegrationsCatalog } from "./IntegrationsCatalog";
import catalog from "./catalog.json";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.25, margin: "0px 0px -8% 0px" }}
      transition={{ duration: 0.55, delay, ease: EASE }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export function IntegrationsBody() {
  return (
    <V3Shell active="integrations">
      {/* hero — centered, one highlight, product type scale */}
      <div className="pb-10 pt-20 text-center">
        <motion.h1
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, ease: EASE }}
          className="text-[34px] font-semibold leading-[1.03] tracking-[-0.032em] sm:text-[48px]"
        >
          Plugs into the stack you <Hl>already</Hl> use.
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.08, ease: EASE }}
          className="mx-auto mt-4 max-w-[460px] text-[15.5px] text-muted-foreground"
        >
          Floom connects to 1,000+ tools so a worker can read the right context,
          produce the output, and ask for approval where your team already works.
        </motion.p>
      </div>

      <div className="pb-16">
        <Reveal delay={0.1}>
          <IntegrationsCatalog catalog={catalog} />
        </Reveal>
      </div>

      {/* close — product-style centered CTA */}
      <Reveal className="flex flex-col items-center gap-4 pb-10 text-center">
        <h2 className="text-[27px] font-semibold leading-[1.06] tracking-[-0.025em] sm:text-[34px]">
          Bring one job. Connect only what it needs.
        </h2>
        <p className="max-w-[420px] text-[15px] leading-relaxed text-muted-foreground">
          Each worker gets scoped tools and approval gates. You can expand access
          later from the connections page.
        </p>
        <Link
          href="/templates"
          className="mt-1 inline-flex items-center rounded-[12px] px-6 py-3 text-[14.5px] font-medium text-white"
          style={{ background: "var(--v3-accent)" }}
        >
          Browse workers
        </Link>
      </Reveal>
    </V3Shell>
  );
}
