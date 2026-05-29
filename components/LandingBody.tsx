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

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

const ShieldIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <path d="m9 12 2 2 4-4" />
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

/* ── Brand tool logos for worker cards (real SVG paths, not text chips) ── */
const GmailLogo = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
    <path fill="#4285F4" d="M22 5.5v13a1.5 1.5 0 0 1-1.5 1.5H19V8.4l-7 5.1-7-5.1V20H3.5A1.5 1.5 0 0 1 2 18.5v-13L12 13z" />
    <path fill="#EA4335" d="M2 5.5A1.5 1.5 0 0 1 3.5 4H4l8 5.8L20 4h.5A1.5 1.5 0 0 1 22 5.5L12 13z" />
  </svg>
);
const LinkedInLogo = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
    <path fill="#0A66C2" d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.45zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13M7.12 20.45H3.55V9h3.57zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.22.79 24 1.77 24h20.45c.98 0 1.78-.78 1.78-1.73V1.73C24 .77 23.2 0 22.22 0" />
  </svg>
);
const SlackLogo = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
    <path fill="#36C5F0" d="M5.04 15.16a2.52 2.52 0 1 1-2.52-2.52h2.52zm1.26 0a2.52 2.52 0 0 1 5.04 0v6.32a2.52 2.52 0 0 1-5.04 0z" />
    <path fill="#2EB67D" d="M8.82 5.04a2.52 2.52 0 1 1 2.52-2.52v2.52zm0 1.26a2.52 2.52 0 0 1 0 5.04H2.52a2.52 2.52 0 0 1 0-5.04z" />
    <path fill="#ECB22E" d="M18.96 8.82a2.52 2.52 0 1 1 2.52 2.52h-2.52zm-1.26 0a2.52 2.52 0 0 1-5.04 0V2.52a2.52 2.52 0 0 1 5.04 0z" />
    <path fill="#E01E5A" d="M15.18 18.96a2.52 2.52 0 1 1-2.52 2.52v-2.52zm0-1.26a2.52 2.52 0 0 1 0-5.04h6.3a2.52 2.52 0 0 1 0 5.04z" />
  </svg>
);
const SheetsLogo = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
    <path fill="#0F9D58" d="M5.5 2h8L20 8.5V20a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2" />
    <path fill="#fff" d="M7.6 11.2h8.8v7.2H7.6zm1.4 1.4v1.2h2.6v-1.2zm4 0v1.2h2.6v-1.2zm-4 2.5v1.2h2.6v-1.2zm4 0v1.2h2.6v-1.2z" />
  </svg>
);
const HubSpotLogo = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
    <path fill="#FF7A59" d="M18.2 7.9V5.5a1.9 1.9 0 1 0-1.7 0v2.4a5.6 5.6 0 0 0-2.6 1.1L6.7 4.3a2.1 2.1 0 1 0-1 1.5l7.1 4.6a5.4 5.4 0 0 0-.9 3 5.5 5.5 0 1 0 6.3-5.5m-2.6 8.4a2.9 2.9 0 1 1 2.9-2.9 2.9 2.9 0 0 1-2.9 2.9" />
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

/* ── Hero new-worker flow ──────────────────────────────────────────
   The hero IS the /workers/new experience: a visitor types a job in
   plain English, then watches Workeros configure a worker — worker.yml,
   tools, schedule, connections, approval — and run it once.
   Phases drive the staged reveal. */
type HeroPhase = "typing" | "thinking" | "config" | "run" | "done";

const HERO_PROMPT =
  "Every 30 minutes, find new inbound leads, score them against our ICP, and draft a reply for the high-fit ones.";

const HERO_TOOLS: Array<{ label: string; logo: React.ReactNode }> = [
  { label: "Gmail", logo: <GmailLogo /> },
  { label: "HubSpot", logo: <HubSpotLogo /> },
  { label: "LinkedIn", logo: <LinkedInLogo /> },
];

const HERO_RUN_STEPS = [
  "Pulled 14 new inbound leads from Gmail + HubSpot",
  "Scored each against ICP context · 3 high-fit",
  "Drafted 3 replies · held for your approval",
];

function HeroNewWorker() {
  const [phase, setPhase] = useState<HeroPhase>("typing");
  const [typed, setTyped] = useState("");
  const [runStep, setRunStep] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const startedRef = useRef(false);

  const run = useCallback(() => {
    const timers: number[] = [];
    const rm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    if (rm) {
      setTyped(HERO_PROMPT);
      setPhase("done");
      setRunStep(HERO_RUN_STEPS.length);
      return () => {};
    }

    let i = 0;
    setTyped("");
    setRunStep(0);
    setPhase("typing");

    function typeChar() {
      if (i <= HERO_PROMPT.length) {
        setTyped(HERO_PROMPT.slice(0, i));
        i += 1;
        const ch = HERO_PROMPT[i - 1];
        const delay = ch === "," || ch === "." ? 90 : 17 + Math.random() * 26;
        timers.push(window.setTimeout(typeChar, delay));
      } else {
        timers.push(window.setTimeout(() => setPhase("thinking"), 360));
        timers.push(window.setTimeout(() => setPhase("config"), 1280));
        timers.push(window.setTimeout(() => setPhase("run"), 2700));
        // staged run-step reveal
        HERO_RUN_STEPS.forEach((_, s) => {
          timers.push(window.setTimeout(() => setRunStep(s + 1), 2980 + s * 620));
        });
        timers.push(window.setTimeout(() => setPhase("done"), 2980 + HERO_RUN_STEPS.length * 620 + 360));
      }
    }
    timers.push(window.setTimeout(typeChar, 620));
    return () => timers.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    function start() {
      if (startedRef.current) return;
      startedRef.current = true;
      cleanup = run();
    }
    if ("IntersectionObserver" in window && rootRef.current) {
      const io = new IntersectionObserver((es) => {
        if (es.some((e) => e.isIntersecting)) { start(); io.disconnect(); }
      }, { threshold: 0.3 });
      io.observe(rootRef.current);
      return () => { io.disconnect(); cleanup?.(); };
    }
    start();
    return () => cleanup?.();
  }, [run]);

  const showConfig = phase === "config" || phase === "run" || phase === "done";
  const showRun = phase === "run" || phase === "done";

  return (
    <div className="ln-nw" id="demo" ref={rootRef} data-phase={phase}>
      <div className="ln-nw-chrome">
        <div className="ln-nw-chrome-tl"><i /><i /><i /></div>
        <div className="ln-nw-chrome-url">
          <LockSVG />
          workeros.floom.dev/workers/new
        </div>
        <button className="ln-nw-chrome-burger" type="button" aria-label="Menu">
          <BurgerIcon />
        </button>
      </div>

      <div className="ln-nw-body">
        {/* Prompt */}
        <div className="ln-nw-prompt">
          <span className="ln-nw-step-k">Step 1 · Describe the job</span>
          <div className="ln-nw-field">
            <label className="ln-nw-label">What should your worker do?</label>
            <div className="ln-nw-text">
              {typed}
              {phase === "typing" && <span className="ln-nw-caret" aria-hidden="true" />}
            </div>
            <div className="ln-nw-prompt-foot">
              <span className="ln-nw-hint">Plain English. No code required.</span>
              <span className={"ln-nw-gen" + (phase === "thinking" ? " on" : "")}>
                <SparkIcon />
                {phase === "thinking" ? "Configuring worker…" : "Generate"}
              </span>
            </div>
          </div>
        </div>

        {/* Generated config */}
        <div className={"ln-nw-config" + (showConfig ? " on" : "")} aria-hidden={!showConfig}>
          <span className="ln-nw-step-k">Step 2 · Workeros configures it</span>
          <div className="ln-nw-worker-head">
            <span className="ln-nw-worker-ic"><MailIcon /></span>
            <div className="ln-nw-worker-id">
              <div className="ln-nw-worker-nm">Inbound Lead Researcher</div>
              <div className="ln-nw-worker-mt">worker.yml · agent · runner=e2b</div>
            </div>
            <span className="ln-nw-worker-badge"><i />Configured</span>
          </div>

          <div className="ln-nw-rows">
            <div className="ln-nw-row" style={{ animationDelay: "60ms" }}>
              <span className="ln-nw-row-k"><ClockIcon /> Schedule</span>
              <span className="ln-nw-row-v">Every 30 minutes</span>
            </div>
            <div className="ln-nw-row" style={{ animationDelay: "180ms" }}>
              <span className="ln-nw-row-k"><PlugIcon /> Connections</span>
              <span className="ln-nw-row-v ln-nw-tools">
                {HERO_TOOLS.map((t) => (
                  <span key={t.label} className="ln-nw-tool">{t.logo}{t.label}</span>
                ))}
              </span>
            </div>
            <div className="ln-nw-row" style={{ animationDelay: "300ms" }}>
              <span className="ln-nw-row-k"><FolderIcon /> Context</span>
              <span className="ln-nw-row-v">icp-profile · mounted</span>
            </div>
            <div className="ln-nw-row" style={{ animationDelay: "420ms" }}>
              <span className="ln-nw-row-k"><ShieldIcon /> Approval</span>
              <span className="ln-nw-row-v">Ask before sending external email</span>
            </div>
          </div>
        </div>

        {/* First test run */}
        <div className={"ln-nw-run" + (showRun ? " on" : "")} aria-hidden={!showRun}>
          <div className="ln-nw-run-head">
            <span className="ln-nw-step-k">Step 3 · First test run</span>
            <span className={"ln-nw-run-stat" + (phase === "done" ? " done" : "")}>
              {phase === "done" ? <><CheckIcon /> Done in 3.4s</> : <><span className="ln-nw-spin" />Running…</>}
            </span>
          </div>
          <div className="ln-nw-run-steps">
            {HERO_RUN_STEPS.map((s, idx) => (
              <div
                key={s}
                className={"ln-nw-run-step" + (idx < runStep ? " on" : "")}
              >
                <span className="ln-nw-run-dot">{idx < runStep ? <CheckIcon /> : <i />}</span>
                {s}
              </div>
            ))}
          </div>
          <div className={"ln-nw-artifact" + (phase === "done" ? " on" : "")}>
            <span className="ln-nw-art-ic"><FileTextIcon /></span>
            <div className="ln-nw-art-id">
              <div className="ln-nw-art-nm">3 drafted replies + lead scorecard</div>
              <div className="ln-nw-art-mt">artifact · awaiting your approval</div>
            </div>
            <span className="ln-nw-art-cta">Review</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Employee-shaped worker cards (the team you hire) ──────────────── */
interface EmployeeCard {
  id: string;
  icon: React.ReactNode;
  name: string;
  trigger: string;
  tools: React.ReactNode[];
  result: string;
  approval: string;
  owner: string;
  attention?: boolean;
}

const EMPLOYEES: EmployeeCard[] = [
  {
    id: "lead",
    icon: <MailIcon />,
    name: "Inbound Lead Researcher",
    trigger: "Runs every 30 min",
    tools: [<GmailLogo key="g" />, <HubSpotLogo key="h" />, <LinkedInLogo key="l" />],
    result: "14 leads pulled · 3 high-fit · 3 replies drafted",
    approval: "Asks before sending external email",
    owner: "Federico",
  },
  {
    id: "invoice",
    icon: <FileTextIcon />,
    name: "Invoice Processor",
    trigger: "Runs on inbox webhook",
    tools: [<GmailLogo key="g" />, <SheetsLogo key="s" />],
    result: "4 invoices parsed · logged to Sheets",
    approval: "Auto-files under $2k, flags the rest",
    owner: "Ops",
    attention: true,
  },
  {
    id: "digest",
    icon: <TrendIcon />,
    name: "Market Digest Writer",
    trigger: "Runs 09:00 daily",
    tools: [<SlackLogo key="sl" />, <SheetsLogo key="s" />],
    result: "Top movers + score deltas posted to #market",
    approval: "Posts to Slack automatically",
    owner: "Federico",
  },
];

const OUTCOME_TILES = [
  { n: "12", label: "New leads researched", sub: "today" },
  { n: "8", label: "Follow-ups drafted", sub: "today" },
  { n: "4", label: "Invoices processed", sub: "today" },
  { n: "17", label: "Reports written", sub: "this week" },
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

  return (
    <>
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
        <section className="lp1 ln-hero-section">
          <div className="ln-hero ln-rise ln-rise-1">
            <div className="ln-badge">
              <span className="ln-badge-k">Backed by</span>
              <span className="ln-badge-v">
                <FoundersIncSVG />
                Founders Inc
              </span>
            </div>

            <h1 className="ln-h1">Hire AI workers for your company</h1>

            <p className="ln-sub">
              Describe the job. Connect your tools. Workeros runs it on a
              schedule, a webhook, or with your approval.
            </p>

            <div className="ln-ctas">
              <a href={SIGN_IN_HREF} className="ln-btn-primary">Hire your first worker</a>
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

            <div className="ln-hero-trust" aria-label="Works with">
              <span>Works in</span>
              <span className="flogo"><ClaudeSVG />Claude</span>
              <span className="flogo"><CodexSVG />Codex</span>
              <span className="flogo"><CursorSVG />Cursor</span>
              <span>or any agent that speaks MCP</span>
            </div>
          </div>

          <div className="ln-hero-visual ln-rise ln-rise-2">
            <HeroNewWorker />
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

        {/* Your team — outcome tiles + employee-shaped worker cards */}
        <section className="ln-team lp1" aria-label="Your team of AI workers">
          <div className="ln-sec-head">
            <div className="ln-ft-eye">Your team</div>
            <h2>Workers you hire, not scripts you babysit.</h2>
            <p>
              Each worker has a job, a trigger, the tools it needs, and an
              approval policy you set. You see what it shipped, who owns it,
              and what is waiting on you.
            </p>
          </div>

          <div className="ln-outcomes">
            {OUTCOME_TILES.map((t) => (
              <div key={t.label} className="ln-outcome">
                <div className="ln-outcome-n">{t.n}</div>
                <div className="ln-outcome-l">{t.label}</div>
                <div className="ln-outcome-s">{t.sub}</div>
              </div>
            ))}
          </div>

          <div className="ln-emps">
            {EMPLOYEES.map((e) => (
              <div key={e.id} className={"ln-emp" + (e.attention ? " att" : "")}>
                <div className="ln-emp-head">
                  <span className="ln-emp-ic">{e.icon}</span>
                  <div className="ln-emp-id">
                    <div className="ln-emp-nm">{e.name}</div>
                    <div className="ln-emp-trig"><ClockIcon />{e.trigger}</div>
                  </div>
                </div>
                <div className="ln-emp-result">
                  <span className="ln-emp-result-k">Last result</span>
                  <p>{e.result}</p>
                </div>
                <div className="ln-emp-meta">
                  <div className="ln-emp-tools" aria-label="Tools">
                    {e.tools.map((t, i) => (
                      <span key={i} className="ln-emp-tool">{t}</span>
                    ))}
                  </div>
                  {e.attention ? (
                    <span className="ln-emp-att">Needs attention</span>
                  ) : (
                    <span className="ln-emp-owner">{e.owner}</span>
                  )}
                </div>
                <div className="ln-emp-approval">
                  <ShieldIcon />
                  {e.approval}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Three pillars — what makes a Workeros worker different. */}
        <section className="ln-pillars lp1" aria-label="Why Workeros">
          <div className="ln-pillar">
            <span className="ln-pillar-ic" aria-hidden="true">
              <FolderIcon />
            </span>
            <h3>Never starts from scratch</h3>
            <p>
              Drop your style guide, CRM playbook, or 2026 OKRs into a
              Context. It mounts into every run, so your worker carries the
              same knowledge across days, triggers, and tools — not a blank
              slate each time.
            </p>
            <span className="ln-pillar-tag">Contexts, mounted per run</span>
          </div>
          <div className="ln-pillar">
            <span className="ln-pillar-ic" aria-hidden="true">
              <TrendIcon />
            </span>
            <h3>Sharper every run</h3>
            <p>
              Every run is captured and every worker is versioned. Read the
              real transcript, tweak the brief, re-run in one click — by hand
              or from your agent over MCP. Each run teaches the next.
            </p>
            <span className="ln-pillar-tag">Versioned + replayable</span>
          </div>
          <div className="ln-pillar">
            <span className="ln-pillar-ic" aria-hidden="true">
              <ClockIcon />
            </span>
            <h3>Glass box, not black box</h3>
            <p>
              Open any run and see the inputs, every step, each tool call, the
              output, the errors, and the cost. Replay it. Nothing your worker
              did is hidden behind a spinner.
            </p>
            <span className="ln-pillar-tag">Artifact-native runs</span>
          </div>
        </section>

        <section className="ln-feat lp1">
          {/* Runs — artifact-native. A run produces the THING. */}
          <div className="ln-feat-row">
            <div className="ln-ft-txt">
              <div className="ln-ft-eye">Runs</div>
              <h2>Every run produces the thing, not a log line.</h2>
              <p>
                Open any run and you get the artifact your worker made — the
                drafted replies, the parsed invoices, the digest — plus the
                inputs, every step, each tool call, the cost, and the approval
                trail. Replay it in one click.
              </p>
              <a href={SIGN_IN_HREF} className="ln-ft-lnk">
                See a run
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" aria-hidden="true">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </a>
            </div>
            <div className="ln-ft-vis">
              <div className="ln-ftv-bar">
                <i /><i /><i />
                <span>workeros.floom.dev/runs/0193f7c4</span>
              </div>
              <div className="ln-ftv-body ln-run">
                <div className="ln-run-top">
                  <div className="ln-run-id">
                    <div className="ln-run-nm">Inbound Lead Researcher · run 0193f7c4</div>
                    <div className="ln-run-mt">schedule · 09:30 · runner=e2b</div>
                  </div>
                  <span className="ln-run-stat"><CheckIcon /> 3.4s · $0.02</span>
                </div>
                <div className="ln-run-track">
                  <div className="ln-run-st"><span className="d"><CheckIcon /></span>Pulled 14 leads <em>· gmail, hubspot</em></div>
                  <div className="ln-run-st"><span className="d"><CheckIcon /></span>Scored vs ICP context <em>· 3 high-fit</em></div>
                  <div className="ln-run-st"><span className="d"><CheckIcon /></span>Drafted 3 replies <em>· held for approval</em></div>
                </div>
                <div className="ln-run-art">
                  <span className="ln-run-art-ic"><FileTextIcon /></span>
                  <div className="ln-run-art-id">
                    <div className="ln-run-art-nm">scorecard.md + 3 drafts</div>
                    <div className="ln-run-art-mt">artifact · 4.1 KB · awaiting approval</div>
                  </div>
                  <span className="ln-run-art-cta">Replay</span>
                </div>
              </div>
            </div>
          </div>

          {/* Workspaces — multi-tenant. */}
          <div className="ln-feat-row rev">
            <div className="ln-ft-txt">
              <div className="ln-ft-eye">Workspaces</div>
              <h2>One account. As many teams as you run.</h2>
              <p>
                Your company work, your fund, your personal automations: keep
                them separate. Workers, runs, connections, secrets, and
                contexts are scoped per workspace, with one click to switch.
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
                <span>workeros.floom.dev/workspaces</span>
              </div>
              <div className="ln-ftv-body ln-sync">
                <div className="ln-sync-hd">
                  <span className="ln-sync-t">Switch workspace</span>
                  <span className="ln-sync-sub">3 yours</span>
                </div>
                {WORKSPACES.map((w) => (
                  <div key={w.id} className="ln-sync-row">
                    <span className="ln-sync-ag">
                      <span aria-hidden="true" className="ln-ws-chip">{w.short}</span>
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

          {/* Contexts — knowledge mounted into every run. */}
          <div className="ln-feat-row">
            <div className="ln-ft-txt">
              <div className="ln-ft-eye">Contexts</div>
              <h2>Your knowledge, mounted into every run.</h2>
              <p>
                Style guide, CRM playbook, OKRs, prior emails: drop them in a
                Context folder. Workeros mounts it read-only into the sandbox
                at run time. Your worker reads it like local files. No vector
                store, no retrieval guessing.
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
                <span>workeros.floom.dev/contexts</span>
              </div>
              <div className="ln-ftv-body ln-sync">
                <div className="ln-sync-hd">
                  <span className="ln-sync-t">Contexts in this workspace</span>
                  <span className="ln-sync-sub">3 folders</span>
                </div>
                <div className="ln-sync-row">
                  <span className="ln-sync-ag">
                    <FolderIcon />
                    icp-profile
                    <span className="ln-sync-d">12 files · 84 KB · used by 2 workers</span>
                  </span>
                  <span className="ln-sync-st ok">Mounted</span>
                </div>
                <div className="ln-sync-row">
                  <span className="ln-sync-ag">
                    <FolderIcon />
                    voice-guide
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

          {/* Connections — live OAuth + MCP. */}
          <div className="ln-feat-row rev">
            <div className="ln-ft-txt">
              <div className="ln-ft-eye">Connections</div>
              <h2>1,043 apps via OAuth. Any MCP server as a tool.</h2>
              <p>
                Workers reuse the same OAuth token Workeros holds for each
                service. Add any MCP server with a URL and an auth header to
                expose its tools to your worker. No secrets in code, no
                expired tokens silently failing in cron.
              </p>
              <a href={SIGN_IN_HREF} className="ln-ft-lnk">
                See connections
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" aria-hidden="true">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </a>
            </div>
            <div className="ln-ft-vis">
              <div className="ln-ftv-bar">
                <i /><i /><i />
                <span>workeros.floom.dev/connections</span>
              </div>
              <div className="ln-ftv-body ln-sync">
                <div className="ln-sync-hd">
                  <span className="ln-sync-t">Connected</span>
                  <span className="ln-sync-sub">7 active</span>
                </div>
                <div className="ln-sync-row">
                  <span className="ln-sync-ag">
                    <span className="ln-sync-logo"><GmailLogo /></span>
                    Gmail
                    <span className="ln-sync-d">depontefede@gmail.com</span>
                  </span>
                  <span className="ln-sync-st ok">Live</span>
                </div>
                <div className="ln-sync-row">
                  <span className="ln-sync-ag">
                    <span className="ln-sync-logo"><SlackLogo /></span>
                    Slack
                    <span className="ln-sync-d">rocketlist · #market</span>
                  </span>
                  <span className="ln-sync-st ok">Live</span>
                </div>
                <div className="ln-sync-row pending">
                  <span className="ln-sync-ag">
                    <span className="ln-sync-logo"><LinkedInLogo /></span>
                    LinkedIn
                    <span className="ln-sync-d">@fedeponte · token rotates in 12d</span>
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

          {/* Agent-native. */}
          <div className="ln-feat-row">
            <div className="ln-ft-txt">
              <div className="ln-ft-eye">Agent-native</div>
              <h2>Your agent creates the worker. Workeros runs it.</h2>
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
                <div className="ln-share-av"><ClaudeSVG /></div>
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
                    <div className="ln-share-sn">Market Digest Writer</div>
                    <div className="ln-share-sm">schedule · 09:00 daily · slack</div>
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
          <h2>Hire your first AI worker in two minutes.</h2>
          <p className="ln-cta-sub">
            Describe the job, connect its tools, set the approval policy. It
            runs on a schedule, a webhook, or on demand.
          </p>
          <div className="ln-ctas" style={{ marginTop: 34 }}>
            <a href={SIGN_IN_HREF} className="ln-btn-primary">Hire your first worker</a>
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
