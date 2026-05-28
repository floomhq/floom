"use client";
import "../app/landing.css";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ThemeModeButton } from "./ThemeModeButton";
// Landing CTAs point at /login (lets the user choose Google or GitHub) instead
// of triggering one provider directly.
const SIGN_IN_HREF = "/login";

/* ─── SVG icons ──────────────────────────────────────────────────── */
const MarkSVG = ({ size = 17 }: { size?: number }) => (
  <span
    className="ln-sb-mark"
    style={{ width: size, height: size }}
    aria-hidden="true"
  />
);

const GitHubSVG = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true">
    <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2 0 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2 0-.4-.5-1.6.2-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.6.2 2.8.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3" />
  </svg>
);

const ArrowSVG = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13" aria-hidden="true">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

const CopySVG = () => (
  <svg className="ln-cmd-ic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect width="13" height="13" x="9" y="9" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

const LockSVG = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <rect width="18" height="11" x="3" y="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

const BoxIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
    <path d="M3.27 6.96 12 12.01l8.73-5.05M12 22.08V12" />
  </svg>
);

const ClockIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);

const PlugIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    <path d="M12 22v-5M9 8V2M15 8V2M5 8h14v3a7 7 0 0 1-14 0V8z" />
  </svg>
);

const FolderIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
  </svg>
);

const MailIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="m22 7-10 5L2 7" />
  </svg>
);

const GlobeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <line x1="2" x2="22" y1="12" y2="12" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
);

const FileTextIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="9" x2="15" y1="13" y2="13" />
    <line x1="9" x2="15" y1="17" y2="17" />
  </svg>
);

const SparkIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
  </svg>
);

const TrendIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 3v18h18" />
    <path d="M7 14l4-4 3 3 5-6" />
  </svg>
);

const WebhookIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 1 1 8.36 13.4" />
    <path d="m6.97 8.65 3.04 6.05M9 5l6 .03M14.95 5.04a4 4 0 1 1 .98 7.34" />
  </svg>
);

const PlayIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="0" aria-hidden="true">
    <polygon points="6 4 20 12 6 20 6 4" />
  </svg>
);

const ChevronIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 9l5-5 5 5M7 15l5 5 5-5" />
  </svg>
);

const BurgerIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);

const ClaudeSVG = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true">
    <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
  </svg>
);

const ChatGPTSVG = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true">
    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.1419.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7866A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654 2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
  </svg>
);

const CursorSVG = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true">
    <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
  </svg>
);

const CodexSVG = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true">
    <path fillRule="evenodd" d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z" />
  </svg>
);

const WindsurfSVG = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true">
    <path d="M23.55 5.067c-1.2038-.002-2.1806.973-2.1806 2.1765v4.8676c0 .972-.8035 1.7594-1.7597 1.7594-.568 0-1.1352-.286-1.4718-.7659l-4.9713-7.1003c-.4125-.5896-1.0837-.941-1.8103-.941-1.1334 0-2.1533.9635-2.1533 2.153v4.8957c0 .972-.7969 1.7594-1.7596 1.7594-.57 0-1.1363-.286-1.4728-.7658L.4076 5.1598C.2822 4.9798 0 5.0688 0 5.2882v4.2452c0 .2147.0656.4228.1884.599l5.4748 7.8183c.3234.462.8006.8052 1.3509.9298 1.3771.313 2.6446-.747 2.6446-2.0977v-4.893c0-.972.7875-1.7593 1.7596-1.7593h.003a1.798 1.798 0 0 1 1.4718.7658l4.9723 7.0994c.4135.5905 1.05.941 1.8093.941 1.1587 0 2.1515-.9645 2.1515-2.153v-4.8948c0-.972.7875-1.7594 1.7596-1.7594h.194a.22.22 0 0 0 .2204-.2202v-4.622a.22.22 0 0 0-.2203-.2203Z" />
  </svg>
);

const FoundersIncSVG = () => (
  <svg className="ln-badge-logo" viewBox="0 0 96 96" fill="currentColor" aria-hidden="true">
    <path d="M55.9 17.1 19.8 38c-1.7 1-1.7 3.4 0 4.4l11.8 6.8 46.9-27.1V10.6c0-2.7-2.9-4.4-5.2-3.1L55.9 17.6v-.5Z" />
    <path d="M15.8 43.4 78.5 79.6v11.1c0 2.7-2.9 4.4-5.2 3.1L7.1 55.6c-2.7-1.6-2.7-5.4 0-7l8.7-5.2Z" />
    <path d="M52.7 43.3 78.5 28.4v38.5L52.7 52c-3.3-1.9-3.3-6.8 0-8.7Z" />
  </svg>
);

/* Nav scroll docking */
function useNavScroll() {
  useEffect(() => {
    const navEl = document.getElementById("lnNav");
    if (!navEl) return;
    const nav = navEl;
    let lastY = window.scrollY || 0;
    let ticking = false;
    const TOP = 10, DELTA = 6;
    function apply() {
      ticking = false;
      const y = window.scrollY || 0;
      const docked = y > TOP;
      nav.classList.toggle("docked", docked);
      if (!docked) {
        nav.classList.remove("ln-hide");
      } else if (Math.abs(y - lastY) > DELTA) {
        if (y > lastY) nav.classList.add("ln-hide");
        else nav.classList.remove("ln-hide");
      }
      lastY = y;
    }
    function onScroll() {
      if (!ticking) { ticking = true; requestAnimationFrame(apply); }
    }
    apply();
    window.addEventListener("scroll", onScroll, { passive: true });
    nav.addEventListener("focusin", () => nav.classList.remove("ln-hide"));
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
}

type DemoView = "neutral" | "workers" | "runs" | "conns" | "contexts";

interface WorkerCardData {
  id: string;
  icon: React.ReactNode;
  name: string;
  desc: string;
  tags: string[];
  sync: string;
  version: string;
  detailTitle: string;
  detailMeta: string;
  detailTag: string;
  detailC1: string;
  detailBody: string;
  detailC2: string;
  detailBody2: string;
}

/* Workers reflect a real Rocketlist-flavoured workspace: recruiter-ops + GTM
   automation, not generic "Gmail intake" templates. These are the kinds of
   workers Federico actually runs in his Rocketlist workspace today. */
const CARDS: WorkerCardData[] = [
  {
    id: "applicants",
    icon: <MailIcon />,
    name: "applicant_followup",
    desc: "Reply to new applicants in Federico's voice, log to ATS.",
    tags: ["#recruiting", "#webhook", "#gmail"],
    sync: "last run · 4m ago",
    version: "v2.3.1",
    detailTitle: "applicant_followup",
    detailMeta: "@fede · v2.3.1 · python · Rocketlist",
    detailTag: "webhook · supabase event · runner=e2b",
    detailC1: "# worker.yml",
    detailBody: "name: applicant_followup\nruntime:\n  type: python\n  runner: e2b\ntrigger:\n  type: webhook\nconnections:\n  - gmail\ncontexts:\n  - voice-guide",
    detailC2: "# last run",
    detailBody2: "input: applicant_id=ap_82af\noutput: draft saved to gmail",
  },
  {
    id: "digest",
    icon: <TrendIcon />,
    name: "job_market_digest",
    desc: "Daily roundup of new jobs scraped, score deltas, top movers.",
    tags: ["#reports", "#cron", "#slack"],
    sync: "next run · 09:00 daily",
    version: "v1.7.0",
    detailTitle: "job_market_digest",
    detailMeta: "@fede · v1.7.0 · python · Rocketlist",
    detailTag: "cron · 09:00 daily · runner=e2b",
    detailC1: "# worker.yml",
    detailBody: "name: job_market_digest\nruntime:\n  type: python\n  runner: e2b\ntrigger:\n  type: schedule\n  cron: \"0 9 * * *\"\nconnections:\n  - slack",
    detailC2: "# output",
    detailBody2: "posts to slack #market-digest\nartifact: digest.md (4.2 KB)",
  },
  {
    id: "sourcing",
    icon: <GlobeIcon />,
    name: "sourcing_brief",
    desc: "Research a role from a JD, return ranked candidate angles.",
    tags: ["#recruiting", "#manual", "#linkedin"],
    sync: "running now · step 4/7",
    version: "v1.2.0",
    detailTitle: "sourcing_brief",
    detailMeta: "@fede · v1.2.0 · python · Rocketlist",
    detailTag: "manual · runner=e2b · context=role-playbook",
    detailC1: "# worker.yml",
    detailBody: "name: sourcing_brief\nruntime:\n  type: agent\n  runner: e2b\ntrigger:\n  type: manual\nconnections:\n  - linkedin\ncontexts:\n  - role-playbook",
    detailC2: "# inputs",
    detailBody2: "jd_text: string\ngeo: enum(EU, US, remote)",
  },
  {
    id: "investor",
    icon: <SparkIcon />,
    name: "investor_update",
    desc: "Monthly metrics into a tight investor update draft.",
    tags: ["#reports", "#monthly"],
    sync: "next run · 1st of month",
    version: "v2.1.0",
    detailTitle: "investor_update",
    detailMeta: "@fede · v2.1.0 · python · Rocketlist",
    detailTag: "cron · 09:00 1st of month · runner=local",
    detailC1: "# worker.yml",
    detailBody: "name: investor_update\nruntime:\n  type: python\n  runner: local\ntrigger:\n  type: schedule\n  cron: \"0 9 1 * *\"\ncontexts:\n  - 2026-OKRs",
    detailC2: "# output",
    detailBody2: "draft: gmail (review before send)",
  },
  {
    id: "csv",
    icon: <FileTextIcon />,
    name: "csv_enricher",
    desc: "Enrich a CSV of leads with web data, write back to Sheets.",
    tags: ["#leads", "#webhook"],
    sync: "last run · 1h ago",
    version: "v1.4.2",
    detailTitle: "csv_enricher",
    detailMeta: "@fede · v1.4.2 · python · Rocketlist",
    detailTag: "webhook · HMAC · runner=e2b",
    detailC1: "# worker.yml",
    detailBody: "name: csv_enricher\nruntime:\n  type: python\n  runner: e2b\ntrigger:\n  type: webhook\n  hmac: required\nconnections:\n  - google_sheets",
    detailC2: "# inputs",
    detailBody2: "rows: array · 86 leads last run",
  },
  {
    id: "outbound",
    icon: <PlugIcon />,
    name: "outbound_pitch",
    desc: "Draft cold-outbound pitches per mandate, in the team voice.",
    tags: ["#bd", "#cron"],
    sync: "next run · Mon 07:00",
    version: "v1.1.0",
    detailTitle: "outbound_pitch",
    detailMeta: "@fede · v1.1.0 · python · Rocketlist",
    detailTag: "cron · MON 07:00 · runner=e2b",
    detailC1: "# worker.yml",
    detailBody: "name: outbound_pitch\nruntime:\n  type: agent\n  runner: e2b\ntrigger:\n  type: schedule\n  cron: \"0 7 * * MON\"\nconnections:\n  - gmail\ncontexts:\n  - outbound-canonical",
    detailC2: "# approvals",
    detailBody2: "send: required · drafts by default",
  },
];

const WORKSPACES = [
  { id: "rocketlist", short: "RL", name: "Rocketlist", role: "Owner · 6 workers", active: true },
  { id: "floom",      short: "FL", name: "Floom",       role: "Owner · 3 workers" },
  { id: "personal",   short: "FD", name: "Personal",    role: "Owner · 2 workers" },
];

export function LandingBody() {
  useNavScroll();

  const [copied, setCopied] = useState(false);
  const CMD = "npx -y @floomhq/workeros";
  async function copyCmd() {
    try {
      await navigator.clipboard.writeText(CMD);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* ignore */ }
  }

  const shotRef = useRef<HTMLDivElement | null>(null);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const navRunsRef = useRef<HTMLDivElement | null>(null);
  const navWorkersRef = useRef<HTMLDivElement | null>(null);
  const navConnsRef = useRef<HTMLDivElement | null>(null);
  const navCtxRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const appRef = useRef<HTMLDivElement | null>(null);

  const [activeView, setActiveView] = useState<DemoView>("neutral");
  const [selCard, setSelCard] = useState<WorkerCardData | null>(null);
  const [hotCardId, setHotCardId] = useState<string | null>(null);
  const [cursorVisible, setCursorVisible] = useState(false);
  const [cursorTap, setCursorTap] = useState(false);

  const moveTo = useCallback((el: HTMLElement | null, bx = 0.5, by = 0.5) => {
    const shot = shotRef.current;
    const cur = cursorRef.current;
    if (!shot || !el || !cur) return;
    const a = shot.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    cur.style.transform = `translate(${(b.left - a.left + b.width * bx).toFixed(1)}px,${(b.top - a.top + b.height * by).toFixed(1)}px)`;
  }, []);

  const tap = useCallback(() => {
    setCursorTap(false);
    requestAnimationFrame(() => setCursorTap(true));
    window.setTimeout(() => setCursorTap(false), 420);
  }, []);

  const showView = useCallback((v: DemoView) => {
    setActiveView(v);
    setSelCard(null);
    setHotCardId(null);
    if (appRef.current) {
      appRef.current.setAttribute("data-view", v);
      appRef.current.setAttribute("data-sel", "0");
    }
  }, []);

  const selectCard = useCallback((card: WorkerCardData) => {
    setHotCardId(card.id);
    setSelCard(card);
    if (appRef.current) appRef.current.setAttribute("data-sel", "1");
  }, []);

  useEffect(() => {
    const rm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (rm) return;

    const steps: Array<() => void> = [
      () => { showView("neutral"); moveTo(navWorkersRef.current, 0.5, 0.5); },
      () => { tap(); showView("workers"); },
      () => { moveTo(cardRefs.current["applicants"], 0.5, 0.4); },
      () => { tap(); selectCard(CARDS[0]); },
      () => { moveTo(cardRefs.current["sourcing"], 0.5, 0.4); },
      () => { tap(); selectCard(CARDS[2]); },
      () => { moveTo(navRunsRef.current, 0.5, 0.5); },
      () => { tap(); showView("runs"); },
      () => { moveTo(navCtxRef.current, 0.5, 0.5); },
      () => { tap(); showView("contexts"); },
      () => { moveTo(navConnsRef.current, 0.5, 0.5); },
      () => { tap(); showView("conns"); },
      () => { moveTo(navWorkersRef.current, 0.55, 1.6); },
      () => { tap(); showView("neutral"); },
    ];

    let i = 0, cancelled = false;
    function loop() {
      if (cancelled) return;
      steps[i]();
      const isTap = i % 2 === 1;
      i = (i + 1) % steps.length;
      setTimeout(loop, isTap ? 1750 : 560);
    }

    function start() {
      showView("neutral");
      setCursorVisible(true);
      moveTo(navWorkersRef.current, 0.55, 1.8);
      setTimeout(loop, 1100);
    }

    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((es) => {
        if (es.some(e => e.isIntersecting)) { start(); io.disconnect(); }
      }, { threshold: 0.25 });
      if (shotRef.current) io.observe(shotRef.current);
      return () => { cancelled = true; io.disconnect(); };
    } else {
      start();
      return () => { cancelled = true; };
    }
  }, [moveTo, tap, showView, selectCard]);

  const detailCard = selCard ?? CARDS[0];

  return (
    <>
      <div className="ln-prev-opts" aria-hidden="true">
        <button className="ln-prev-opt on" type="button" tabIndex={-1}>
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="2" y="4" width="20" height="13" rx="2" />
            <path d="M8 21h8M12 17v4" />
          </svg>
          Desktop
        </button>
        <button className="ln-prev-opt" type="button" tabIndex={-1}>
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="6" y="2" width="12" height="20" rx="2" />
            <path d="M11 18h2" />
          </svg>
          Mobile
        </button>
      </div>

      <nav className="ln-nav" id="lnNav" aria-label="Main navigation">
        <Link href="/" className="ln-brand">
          <span className="ln-mark" aria-hidden="true" />
          Floom <span style={{ color: "var(--ink-mute)", fontWeight: 450, marginLeft: 4 }}>/ workeros</span>
        </Link>
        <div className="ln-right">
          <a
            href="https://github.com/floomhq/workeros"
            target="_blank"
            rel="noopener noreferrer"
            className="ln-link"
          >
            Docs
          </a>
          <a
            href="https://github.com/floomhq/workeros"
            target="_blank"
            rel="noopener noreferrer"
            className="ln-gh-link"
            aria-label="GitHub"
          >
            <GitHubSVG />
          </a>
          <ThemeModeButton />
          <a href={SIGN_IN_HREF} className="ln-cta">Sign in</a>
        </div>
      </nav>

      <main id="flm-main">
        <section className="lp1">
          <div className="ln-hero ln-rise ln-rise-1">
            <div className="ln-badge">
              <span className="ln-badge-k">Backed by</span>
              <span className="ln-badge-v">
                <FoundersIncSVG />
                Founders Inc
              </span>
            </div>

            <h1 className="ln-h1">
              The <em>cockpit</em><br />
              for background work
            </h1>

            <p className="ln-sub">
              Workspaces, workers, triggers, connections, and contexts in one
              place. Drive it from{" "}
              <span className="flogo">
                <ClaudeSVG />
                Claude
              </span>
              ,{" "}
              <span className="flogo">
                <CodexSVG />
                Codex
              </span>
              ,{" "}
              <span className="flogo">
                <CursorSVG />
                Cursor
              </span>
              , or any agent that speaks MCP.
            </p>

            <div className="ln-ctas">
              <a href={SIGN_IN_HREF} className="ln-btn-primary">Start a workspace</a>
              <button
                type="button"
                className={"ln-cmd" + (copied ? " copied" : "")}
                onClick={copyCmd}
                aria-label="Copy the MCP install command"
              >
                <span className="ln-cmd-pr">$</span>
                <code>{CMD}</code>
                <CopySVG />
                <span className="ln-cmd-ok" aria-hidden="true">Copied</span>
              </button>
            </div>

            <a href="#demo" className="ln-demo-link">
              See a live demo
              <ArrowSVG />
            </a>
          </div>

          <div className="ln-shot-wrap ln-rise ln-rise-2" id="demo">
            <div className="ln-shot" id="lnShot" ref={shotRef}>
              <div className="ln-chrome">
                <div className="ln-chrome-tl">
                  <i /><i /><i />
                </div>
                <div className="ln-chrome-url">
                  <LockSVG />
                  workeros.floom.dev/app
                </div>
                <button className="ln-chrome-burger" type="button" aria-label="Menu">
                  <BurgerIcon />
                </button>
              </div>

              <div
                className="ln-app"
                id="lnApp"
                ref={appRef}
                data-view={activeView}
                data-sel={selCard ? "1" : "0"}
              >
                <aside className="ln-sidebar">
                  {/* Workspace switcher chip (mirrors the real dashboard:
                      bottom-left in the live app, surfaced top-left here so
                      it is the first thing the visitor sees). */}
                  <div
                    className="ln-sb-ws"
                    style={{ marginTop: 0, marginBottom: 14 }}
                  >
                    <i>RL</i>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="wn">Rocketlist</div>
                      <div className="wr">Owner · 6 workers</div>
                    </div>
                    <span style={{ color: "var(--ink-mute)", display: "inline-flex" }}>
                      <ChevronIcon />
                    </span>
                  </div>

                  <div className="ln-sb-lbl">Workspace</div>

                  <div
                    ref={navWorkersRef}
                    className={"ln-sb-item" + (activeView === "workers" ? " on" : "")}
                    id="lnNavWorkers"
                  >
                    <BoxIcon />
                    Workers
                    <span className="badge">6</span>
                  </div>

                  <div className="ln-sb-folders">
                    <div className="ln-sb-folder"><span className="nm">Recruiting</span><span className="ct">2</span></div>
                    <div className="ln-sb-folder"><span className="nm">Reports</span><span className="ct">2</span></div>
                    <div className="ln-sb-folder"><span className="nm">Leads</span><span className="ct">2</span></div>
                  </div>

                  <div
                    ref={navRunsRef}
                    className={"ln-sb-item" + (activeView === "runs" ? " on" : "")}
                    id="lnNavRuns"
                  >
                    <ClockIcon />
                    Runs
                    <span className="badge">142</span>
                  </div>

                  <div
                    ref={navConnsRef}
                    className={"ln-sb-item" + (activeView === "conns" ? " on" : "")}
                    id="lnNavConns"
                  >
                    <PlugIcon />
                    Connections
                    <span className="badge">7</span>
                  </div>

                  <div
                    ref={navCtxRef}
                    className={"ln-sb-item" + (activeView === "contexts" ? " on" : "")}
                    id="lnNavCtx"
                  >
                    <FolderIcon />
                    Contexts
                    <span className="badge">3</span>
                  </div>

                  <div style={{ marginTop: "auto", paddingTop: "12px" }}>
                    <div className="lp-sa-fg">
                      <span className="lp-sa-fl">Sandbox</span>
                      <span className="lp-sa-chip">local</span>
                      <span className="lp-sa-chip">e2b</span>
                    </div>
                  </div>
                </aside>

                <div className="ln-main">
                  <div className={"ln-view" + (activeView === "neutral" ? " on" : "")} id="lnViewNeutral">
                    <div className="ln-neutral">
                      <div className="ln-neutral-mark">
                        <MarkSVG size={22} />
                      </div>
                      <div className="ln-neutral-h">Rocketlist</div>
                      <div className="ln-neutral-sub">Six workers. Always on.</div>
                      <div className="ln-neutral-stats">
                        <div className="ln-ns"><b>23</b><span>Replies drafted</span></div>
                        <div className="ln-ns"><b>4</b><span>Briefs shipped</span></div>
                        <div className="ln-ns"><b>86</b><span>Leads enriched</span></div>
                      </div>
                      <div className="ln-neutral-hint">Pick a section</div>
                    </div>
                  </div>

                  <div className={"ln-view" + (activeView === "workers" ? " on" : "")} id="lnViewWorkers">
                    <div className="ln-pane-h">Workers</div>
                    <div className="ln-pane-sub">Describe one in English, upload a bundle, or pick a template.</div>
                    <div className="ln-filters">
                      <div className="ln-filters-chips">
                        <span className="ln-ffl">TRIGGER</span>
                        <span className="ln-chip on">all</span>
                        <span className="ln-chip">cron</span>
                        <span className="ln-chip">webhook</span>
                        <span className="ln-chip">manual</span>
                        <span className="ln-ffl">SANDBOX</span>
                        <span className="ln-chip on">All</span>
                        <span className="ln-chip">local</span>
                        <span className="ln-chip">e2b</span>
                      </div>
                    </div>
                    <div className="ln-grid">
                      {CARDS.map((card) => (
                        <div
                          key={card.id}
                          className={"ln-card" + (hotCardId === card.id ? " hot" : "")}
                          ref={(el) => { cardRefs.current[card.id] = el; }}
                        >
                          <div className="ln-card-icon">{card.icon}</div>
                          <div className="ln-card-name">{card.name}</div>
                          <div className="ln-card-desc">{card.desc}</div>
                          <div className="ln-card-tags">
                            {card.tags.map((t) => (
                              <span key={t} className="ln-tag">{t}</span>
                            ))}
                          </div>
                          <div className="ln-card-sync">
                            <span className="ln-syncdot" />
                            {card.sync}
                          </div>
                          <div className="ln-card-meta">
                            <span className="pub"><i />Active</span>
                            <span>{card.version}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className={"ln-view" + (activeView === "conns" ? " on" : "")} id="lnViewConns">
                    <div className="ln-pane-h">Connections</div>
                    <div className="ln-pane-sub">1,043 apps via OAuth, plus any MCP server. One token, every worker.</div>
                    <div className="ln-context-list">
                      <div className="ln-context-row on">
                        <span className="ln-context-path">gmail · depontefede@gmail.com</span>
                        <span className="ln-context-meta">live · 3 workers</span>
                      </div>
                      <div className="ln-context-row">
                        <span className="ln-context-path">linkedin · @fedeponte</span>
                        <span className="ln-context-meta">live · expires 12d</span>
                      </div>
                      <div className="ln-context-row">
                        <span className="ln-context-path">slack · rocketlist · #market-digest</span>
                        <span className="ln-context-meta">live · 1 worker</span>
                      </div>
                      <div className="ln-context-row">
                        <span className="ln-context-path">google_sheets · fede@</span>
                        <span className="ln-context-meta">live · 2 workers</span>
                      </div>
                      <div className="ln-context-row">
                        <span className="ln-context-path">mcp · rocketlist-internal · 12 tools</span>
                        <span className="ln-context-meta">live · 2 workers</span>
                      </div>
                    </div>
                    <div className="ln-context-preview">
                      <span className="ln-sysi-k">How workers use it</span>
                      <p>Declare <code>connections: [gmail, mcp:rocketlist-internal]</code> in worker.yml. Floom injects fresh tokens at run time and exposes the MCP tools to the agent.</p>
                    </div>
                  </div>

                  <div className={"ln-view" + (activeView === "runs" ? " on" : "")} id="lnViewRuns">
                    <div className="ln-pane-h">Recent runs</div>
                    <div className="ln-pane-sub">Every execution on the record. Logs, output, artifacts.</div>
                    <div className="ln-sysi">
                      <div className="ln-sysi-hd">
                        <div className="ln-sysi-ic"><ClockIcon /></div>
                        <div className="ln-sysi-id">
                          <div className="ln-sysi-nm">applicant_followup · run 0193f7c4</div>
                          <div className="ln-sysi-mt">webhook · ap_82af · draft saved · 3.4s</div>
                        </div>
                        <span className="ln-sysi-ver">done <i /></span>
                      </div>
                      <div className="ln-sysi-body">
                        <div className="ln-sysi-blk">
                          <span className="ln-sysi-k">Step timings</span>
                          <p>[fetch applicant] 220ms · [load voice-guide] 84ms · [draft] 2.6s · [save] 510ms</p>
                        </div>
                        <div className="ln-sysi-blk">
                          <span className="ln-sysi-k">Output</span>
                          <p>draft.eml · 1 reply queued in gmail (awaiting approval)</p>
                        </div>
                        <div className="ln-sysi-blk">
                          <span className="ln-sysi-k">Logs</span>
                          <p>09:42:12 INFO mounted context voice-guide (12 files) · 09:42:15 ✓ completed in 3.4s</p>
                        </div>
                      </div>
                      <div className="ln-sysi-ft">
                        <span className="ln-sysi-ft-lbl">Next runs</span>
                        <span className="ln-sysi-tag">job_market_digest · 09:00</span>
                        <span className="ln-sysi-tag">outbound_pitch · MON 07:00</span>
                        <span className="ln-sysi-tag">investor_update · 1st</span>
                      </div>
                    </div>
                  </div>

                  <div className={"ln-view" + (activeView === "contexts" ? " on" : "")} id="lnViewContexts">
                    <div className="ln-pane-h">Contexts</div>
                    <div className="ln-pane-sub">Shared folders mounted into every run. Your knowledge, not retrieval guesses.</div>
                    <div className="ln-context-list">
                      <div className="ln-context-row on">
                        <span className="ln-context-path">voice-guide</span>
                        <span className="ln-context-meta">12 files · used by 2 workers</span>
                      </div>
                      <div className="ln-context-row">
                        <span className="ln-context-path">role-playbook</span>
                        <span className="ln-context-meta">8 files · used by 1 worker</span>
                      </div>
                      <div className="ln-context-row">
                        <span className="ln-context-path">2026-OKRs</span>
                        <span className="ln-context-meta">3 files · used by 1 worker</span>
                      </div>
                    </div>
                    <div className="ln-context-preview">
                      <span className="ln-sysi-k">How workers use it</span>
                      <p>Add <code>contexts: [voice-guide]</code> to worker.yml. Floom mounts the folder read-only at <code>/contexts/voice-guide</code> in the E2B sandbox before run.</p>
                    </div>
                  </div>
                </div>

                <div className="ln-detail" id="lnDetail">
                  <div className="ln-detail-head">
                    <div className="ln-detail-icon">
                      <BoxIcon />
                    </div>
                    <div>
                      <div className="ln-detail-title">{detailCard.detailTitle}</div>
                      <div className="ln-detail-meta">{detailCard.detailMeta}</div>
                    </div>
                  </div>
                  <div className="ln-detail-tag">{detailCard.detailTag}</div>
                  <div className="ln-detail-body">
                    <span className="ln-detail-comment">{detailCard.detailC1}</span>
                    <br /><br />
                    {detailCard.detailBody.split("\n").map((line, i) => (
                      <span key={i}>{line}<br /></span>
                    ))}
                    <br />
                    <span className="ln-detail-comment">{detailCard.detailC2}</span>
                    <br />
                    {detailCard.detailBody2.split("\n").map((line, i) => (
                      <span key={i}>{line}<br /></span>
                    ))}
                  </div>
                  <div className="ln-detail-agents">
                    <div className="lbl">Triggered by</div>
                    <div className="ln-agent-row">
                      <ClockIcon />
                      Cron
                      <span className="status">active</span>
                    </div>
                    <div className="ln-agent-row">
                      <WebhookIcon />
                      Webhook
                      <span className="status">ready</span>
                    </div>
                    <div className="ln-agent-row">
                      <PlayIcon />
                      Manual
                      <span className="status">ready</span>
                    </div>
                  </div>
                </div>

                <div
                  ref={cursorRef}
                  className={"ln-cursor" + (cursorVisible ? " show" : "") + (cursorTap ? " tap" : "")}
                  aria-hidden="true"
                >
                  <svg viewBox="0 0 24 24" fill="var(--ink)" stroke="var(--paper)" strokeWidth="1.4">
                    <path d="M5 3l15 9-7 1.5L9 21z" />
                  </svg>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="ln-trust lp1">
          <div className="ln-trust-label">Drive Workeros from any MCP-capable agent</div>
          <div className="ln-logos">
            <span className="ln-logo-cell"><ClaudeSVG />Claude</span>
            <span className="ln-logo-cell"><ChatGPTSVG />ChatGPT</span>
            <span className="ln-logo-cell"><CursorSVG />Cursor</span>
            <span className="ln-logo-cell"><CodexSVG />Codex</span>
            <span className="ln-logo-cell"><WindsurfSVG />Windsurf</span>
          </div>
        </section>

        <section className="ln-feat lp1">
          {/* Workspaces — the multi-tenant story. Your work life is not one
              pile; neither is your worker fleet. */}
          <div className="ln-feat-row">
            <div className="ln-ft-txt">
              <div className="ln-ft-eye">Workspaces</div>
              <h2>One account. As many workspaces as you run.</h2>
              <p>
                Rocketlist work, your investment thesis, your personal
                automations: keep them separate. Workers, runs, connections,
                secrets, and contexts are scoped per workspace, with one
                click to switch.
              </p>
              <a href={SIGN_IN_HREF} className="ln-ft-lnk">
                Create your first workspace
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" aria-hidden="true">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </a>
            </div>
            <div className="ln-ft-vis">
              <div className="ln-ftv-bar">
                <i /><i /><i />
                <span>workeros.floom.dev/app</span>
              </div>
              <div className="ln-ftv-body ln-sync">
                <div className="ln-sync-hd">
                  <span className="ln-sync-t">Switch workspace</span>
                  <span className="ln-sync-sub">3 yours</span>
                </div>
                {WORKSPACES.map((w) => (
                  <div key={w.id} className="ln-sync-row">
                    <span className="ln-sync-ag">
                      <span
                        aria-hidden="true"
                        style={{
                          display: "inline-grid",
                          placeItems: "center",
                          width: 20,
                          height: 20,
                          borderRadius: 6,
                          background: "color-mix(in srgb, var(--accent) 18%, transparent)",
                          color: "var(--accent)",
                          fontSize: 9,
                          fontWeight: 700,
                          letterSpacing: "0.02em",
                        }}
                      >
                        {w.short}
                      </span>
                      {w.name}
                      <span className="ln-sync-d">{w.role}</span>
                    </span>
                    <span className={"ln-sync-st" + (w.active ? " ok" : "")}>
                      {w.active ? "Active" : "Switch"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="ln-feat-row rev">
            <div className="ln-ft-txt">
              <div className="ln-ft-eye">Source of truth</div>
              <h2>One worker file. Every trigger reads the same thing.</h2>
              <p>
                A worker is a folder with <code>worker.yml</code> plus your
                code. Declare the trigger, the connections, the contexts.
                Floom handles cron, webhooks, manual runs, and the MCP
                surface from the same file.
              </p>
              <a
                href="https://github.com/floomhq/workeros"
                target="_blank"
                rel="noopener noreferrer"
                className="ln-ft-lnk"
              >
                How it works
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" aria-hidden="true">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </a>
            </div>
            <div className="ln-ft-vis">
              <div className="ln-ftv-bar">
                <i /><i /><i />
                <span>workeros.floom.dev/app/workers</span>
              </div>
              <div className="ln-ftv-body ln-sot">
                <div className="ln-sot-src">
                  <div className="ln-sot-ic"><MailIcon /></div>
                  <div className="ln-sot-id">
                    <div className="ln-sot-nm">applicant_followup</div>
                    <div className="ln-sot-mt">@fede · Rocketlist · one source of truth</div>
                  </div>
                  <div className="ln-sot-ver">
                    <span className="ln-sot-vchip">v2.3.1</span>
                    <span className="ln-sot-vsub">active · 6 prior versions</span>
                  </div>
                </div>
                <div className="ln-sot-fan">
                  <div className="ln-sot-fan-lbl">Triggered by</div>
                  <div className="ln-sot-targets">
                    <div className="ln-sot-t">
                      <ClockIcon />
                      Cron <i className="ok" />
                    </div>
                    <div className="ln-sot-t">
                      <WebhookIcon />
                      Webhook <i className="ok" />
                    </div>
                    <div className="ln-sot-t">
                      <PlayIcon />
                      Manual <i className="ok" />
                    </div>
                    <div className="ln-sot-t">
                      <SparkIcon />
                      MCP <i className="ok" />
                    </div>
                  </div>
                  <div className="ln-sot-note">Change worker.yml once. Every trigger picks it up.</div>
                </div>
              </div>
            </div>
          </div>

          {/* Contexts — Federico's S36 feature. Shared folders mounted into
              every run, so the worker has your knowledge without you wiring
              retrieval. */}
          <div className="ln-feat-row">
            <div className="ln-ft-txt">
              <div className="ln-ft-eye">Contexts</div>
              <h2>Your knowledge, mounted into every run.</h2>
              <p>
                Style guide, CRM playbook, OKRs, prior emails: drop them in a
                Context folder. Floom mounts it read-only into the E2B
                sandbox at run time. Your worker reads it like local files.
                No vector store, no retrieval guessing.
              </p>
              <a href={SIGN_IN_HREF} className="ln-ft-lnk">
                See contexts in action
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" aria-hidden="true">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </a>
            </div>
            <div className="ln-ft-vis">
              <div className="ln-ftv-bar">
                <i /><i /><i />
                <span>workeros.floom.dev/app/contexts</span>
              </div>
              <div className="ln-ftv-body ln-sync">
                <div className="ln-sync-hd">
                  <span className="ln-sync-t">Contexts in Rocketlist</span>
                  <span className="ln-sync-sub">3 folders</span>
                </div>
                <div className="ln-sync-row">
                  <span className="ln-sync-ag">
                    <FolderIcon />
                    voice-guide
                    <span className="ln-sync-d">12 files · 84 KB · used by 2 workers</span>
                  </span>
                  <span className="ln-sync-st ok">Mounted</span>
                </div>
                <div className="ln-sync-row">
                  <span className="ln-sync-ag">
                    <FolderIcon />
                    role-playbook
                    <span className="ln-sync-d">8 files · 31 KB · used by 1 worker</span>
                  </span>
                  <span className="ln-sync-st ok">Mounted</span>
                </div>
                <div className="ln-sync-row">
                  <span className="ln-sync-ag">
                    <FolderIcon />
                    2026-OKRs
                    <span className="ln-sync-d">3 files · 14 KB · used by 1 worker</span>
                  </span>
                  <span className="ln-sync-st ok">Mounted</span>
                </div>
              </div>
            </div>
          </div>

          <div className="ln-feat-row rev">
            <div className="ln-ft-txt">
              <div className="ln-ft-eye">Live by default</div>
              <h2>1,043 apps via OAuth. Any MCP server as a tool.</h2>
              <p>
                Workers reuse the same OAuth token Floom holds for each
                service. Add any MCP server with a URL and an auth header to
                expose its tools to your worker. No secrets in code, no
                expired tokens silently failing in cron.
              </p>
              <a
                href="https://github.com/floomhq/workeros"
                target="_blank"
                rel="noopener noreferrer"
                className="ln-ft-lnk"
              >
                See connections
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" aria-hidden="true">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </a>
            </div>
            <div className="ln-ft-vis">
              <div className="ln-ftv-bar">
                <i /><i /><i />
                <span>workeros.floom.dev/app/connections</span>
              </div>
              <div className="ln-ftv-body ln-sync">
                <div className="ln-sync-hd">
                  <span className="ln-sync-t">Connected</span>
                  <span className="ln-sync-sub">7 active</span>
                </div>
                <div className="ln-sync-row">
                  <span className="ln-sync-ag">
                    <MailIcon />
                    Gmail · depontefede@gmail.com
                  </span>
                  <span className="ln-sync-st ok">Live</span>
                </div>
                <div className="ln-sync-row">
                  <span className="ln-sync-ag">
                    <SparkIcon />
                    Slack · rocketlist · #market-digest
                  </span>
                  <span className="ln-sync-st ok">Live</span>
                </div>
                <div className="ln-sync-row pending">
                  <span className="ln-sync-ag">
                    <GlobeIcon />
                    LinkedIn · @fedeponte
                    <span className="ln-sync-d">token rotates in 12d</span>
                  </span>
                  <span className="ln-sync-pull">Refresh</span>
                </div>
                <div className="ln-sync-row">
                  <span className="ln-sync-ag">
                    <PlugIcon />
                    MCP · rocketlist-internal
                    <span className="ln-sync-d">12 tools exposed</span>
                  </span>
                  <span className="ln-sync-st ok">Live</span>
                </div>
              </div>
            </div>
          </div>

          <div className="ln-feat-row">
            <div className="ln-ft-txt">
              <div className="ln-ft-eye">Agent-native</div>
              <h2>Your agent creates the worker. Floom runs it.</h2>
              <p>
                Run <code>floom login</code> once, then call{" "}
                <code>workers.create</code>, <code>workspaces.switch</code>,
                or <code>runs.tail</code> from Claude, Codex, or Cursor.
                Skip the canvas. The brief is the workflow.
              </p>
              <a
                href="https://github.com/floomhq/workeros"
                target="_blank"
                rel="noopener noreferrer"
                className="ln-ft-lnk"
              >
                MCP reference
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" aria-hidden="true">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </a>
            </div>
            <div className="ln-ft-vis">
              <div className="ln-share-head">
                <div className="ln-share-av">CL</div>
                <div className="ln-share-tx">
                  <div className="ln-share-who">
                    <b>Claude</b>
                    <span className="ln-share-time">via MCP · 2h</span>
                  </div>
                  <div className="ln-share-msg">In the Rocketlist workspace, every weekday at 9am send a digest of new jobs scraped and post it to #market-digest.</div>
                </div>
              </div>
              <div className="ln-share-body">
                <div className="ln-share-sk">
                  <div className="ln-share-si"><TrendIcon /></div>
                  <div className="ln-share-skid">
                    <div className="ln-share-sn">job_market_digest</div>
                    <div className="ln-share-sm">cron · 09:00 daily · slack</div>
                  </div>
                  <span className="ln-share-badge"><i />Active</span>
                </div>
                <div className="ln-share-trust">
                  <SparkIcon />
                  Created via <code>workers.create</code> in workspace{" "}
                  <code>rocketlist</code>. Scheduled before you finish the sentence.
                </div>
                <div className="ln-share-actions">
                  <div className="ln-share-btn p">
                    <PlayIcon />
                    Run now
                  </div>
                  <div className="ln-share-btn s">
                    <CopySVG />
                    Copy worker.yml
                  </div>
                </div>
                <div className="ln-share-nf">Works in any agent that speaks MCP</div>
              </div>
            </div>
          </div>
        </section>

        <section className="ln-cta-section lp1">
          <h2>Spin up a worker in two minutes.</h2>
          <p className="ln-cta-sub">
            The cockpit for every background task you direct. Triggered by cron, webhook, or your agent.
          </p>
          <div className="ln-ctas" style={{ marginTop: 34 }}>
            <a href={SIGN_IN_HREF} className="ln-btn-primary">Start a workspace</a>
            <button
              type="button"
              className={"ln-cmd" + (copied ? " copied" : "")}
              onClick={copyCmd}
              aria-label="Copy the MCP install command"
            >
              <span className="ln-cmd-pr">$</span>
              <code>{CMD}</code>
              <CopySVG />
              <span className="ln-cmd-ok" aria-hidden="true">Copied</span>
            </button>
          </div>
          <a href="#demo" className="ln-demo-link" style={{ marginTop: 20 }}>
            See a live demo
            <ArrowSVG />
          </a>
        </section>
      </main>

      <footer className="ln-footer">
        <div className="ln-footer-in">
          <div className="ln-footer-brand">Workeros<span className="cp">© 2026 · Built with care in San Francisco</span></div>
          <div className="ln-footer-col">
            <h3>Product</h3>
            <a href={SIGN_IN_HREF}>Sign in</a>
            <a href="https://github.com/floomhq/workeros" target="_blank" rel="noopener noreferrer">Docs</a>
            <a href="https://github.com/floomhq/workeros" target="_blank" rel="noopener noreferrer">GitHub</a>
          </div>
          <div className="ln-footer-col">
            <h3>Floom</h3>
            <a href="https://skills.floom.dev" target="_blank" rel="noopener noreferrer">Skills</a>
            <a href="https://floom.dev" target="_blank" rel="noopener noreferrer">Floom</a>
          </div>
          <div className="ln-footer-col">
            <h3>Legal</h3>
            <Link href="/terms">Terms</Link>
            <Link href="/privacy">Privacy</Link>
          </div>
          <div className="ln-footer-col">
            <h3>Connect</h3>
            <a href="https://www.linkedin.com/company/floomhq/" target="_blank" rel="noopener noreferrer">LinkedIn</a>
            <a href="https://x.com/floomhq" target="_blank" rel="noopener noreferrer">X</a>
          </div>
        </div>
      </footer>
    </>
  );
}
