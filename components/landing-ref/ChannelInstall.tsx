"use client";

import Link from "next/link";
import { ArrowRight, Terminal } from "lucide-react";
import { motion, useReducedMotion, type Variants } from "motion/react";
import {
  DiscordLogo,
  SlackLogo,
  WhatsAppLogo,
} from "../landing-icons";

const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1];

const stagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06, delayChildren: 0.05 } },
};
const item: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE_OUT } },
};

type Channel = {
  key: string;
  name: string;
  href: string;
  logo: React.ReactNode;
  hint: string;
};

const CLILogo = () => (
  <Terminal className="h-3.5 w-3.5" strokeWidth={2} />
);

const CHANNELS: Channel[] = [
  {
    key: "slack",
    name: "Slack",
    href: "/start/slack",
    logo: <SlackLogo />,
    hint: "Workspace install",
  },
  {
    key: "whatsapp",
    name: "WhatsApp",
    href: "/start/whatsapp",
    logo: <WhatsAppLogo />,
    hint: "Personal or shared number",
  },
  {
    key: "discord",
    name: "Discord",
    href: "/login?install=discord",
    logo: <DiscordLogo />,
    hint: "Server bot",
  },
  {
    key: "cli",
    name: "CLI",
    href: "/login?install=cli",
    logo: <CLILogo />,
    hint: "Pair from your terminal",
  },
];

/**
 * ChannelInstall — alternative entry point under the hero composer.
 * Visitor picks the surface they actually work in; the install link routes
 * to /login with `?install=<channel>` so after sign-in the dashboard kicks
 * off the corresponding OAuth/install flow. Until the backends are wired,
 * this is a forward-compatible placeholder — the sign-in still works and the
 * dashboard can read the param later.
 */
export function ChannelInstall() {
  const reduce = useReducedMotion() ?? false;

  // Mount-animated, not viewport-triggered. This sits in the hero, so the
  // initial IntersectionObserver may not fire before the user scrolls or
  // focuses the composer (the audit caught this exact pattern). Match the
  // composer's always-on entrance.
  const Wrapper = reduce ? "div" : motion.div;
  const wrapperProps = reduce
    ? {}
    : {
        initial: "hidden",
        animate: "show",
        variants: stagger,
      };

  return (
    <Wrapper
      {...wrapperProps}
      className="mx-auto mt-7 w-full max-w-2xl"
      aria-label="Install WorkerOS directly in a channel"
    >
      {reduce ? (
        <div className="mb-2.5 text-center text-[12px] text-muted-foreground">
          Or install directly where your team works.
        </div>
      ) : (
        <motion.div
          variants={item}
          className="mb-2.5 text-center text-[12px] text-muted-foreground"
        >
          Or install directly where your team works.
        </motion.div>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {CHANNELS.map((c) => {
          const inner = (
            <Link
              href={c.href}
              prefetch={false}
              className="group/install flex h-full flex-col items-start gap-1 rounded-[12px] border border-border bg-card p-3 text-left transition-all hover:-translate-y-px hover:border-[#3a6ea5]/40 hover:shadow-[0_10px_24px_-14px_rgba(58,110,165,0.25)]"
            >
              <div className="flex w-full items-center justify-between">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-[8px] border border-border bg-background [&>svg]:h-3.5 [&>svg]:w-3.5">
                  {c.logo}
                </span>
                <ArrowRight
                  className="h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 group-hover/install:translate-x-0.5 group-hover/install:text-[#3a6ea5]"
                  aria-hidden
                />
              </div>
              <div className="mt-1 text-[13px] font-semibold text-foreground">
                Install in {c.name}
              </div>
              <div className="text-[11px] text-muted-foreground">{c.hint}</div>
            </Link>
          );

          if (reduce) {
            return (
              <div key={c.key} className="min-w-0">
                {inner}
              </div>
            );
          }
          return (
            <motion.div key={c.key} variants={item} className="min-w-0">
              {inner}
            </motion.div>
          );
        })}
      </div>
      {reduce ? (
        <div className="mt-2 text-center text-[10.5px] text-muted-foreground/85">
          Same flow if a teammate invited you: sign in and you&apos;re in the workspace.
        </div>
      ) : (
        <motion.div
          variants={item}
          className="mt-2 text-center text-[10.5px] text-muted-foreground/85"
        >
          Same flow if a teammate invited you: sign in and you&apos;re in the workspace.
        </motion.div>
      )}
    </Wrapper>
  );
}
