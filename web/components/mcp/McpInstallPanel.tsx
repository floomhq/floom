"use client";

// SHARED MCP-install panel — the single source of truth for "Add Floom to your
// AI client". Rendered in BOTH places that install the MCP server:
//   1. the sidebar "MCP" popup (McpInstallModal wraps this in dialog chrome), and
//   2. Settings → Connect & automate → MCP ("Agent install").
//
// Before this, the two surfaces were different treatments: the popup had 3
// Claude/Cursor/VS-Code tabs with a real token baked in, while Settings showed a
// STATIC `npx`-based snippet with NO token. Federico: "mcp on left sidebar, why
// not simply same as mcp says on settings?" — so this is ONE component, using
// the SETTINGS wording (Claude Desktop, Cursor, VS Code, Windsurf, Cline, or any
// MCP client) and the REAL token flow.
//
// The snippet is the ready-to-paste `mcpServers` config from buildMcpJson(),
// with the user's real OSS secret embedded (+ the active workspace pinned). The
// token + generate flow are the shared oss-token helpers (same path the
// CliCommandPanel uses), so a token minted anywhere is reused everywhere.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Check, Copy, RefreshCw, ArrowRight } from "lucide-react";

import { buildMcpJson } from "@/lib/mcp-config";
import { getActiveWorkspaceId } from "@/lib/api";
import { getPublicApiHost } from "@/lib/api-base";
import { generateOssToken, readStoredSecret } from "@/lib/oss-token";

const MCP_CLIENTS = [
  {
    label: "Claude",
    viewBox: "0 0 24 24",
    path: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  },
  {
    label: "Cursor",
    viewBox: "0 0 24 24",
    path: "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
  },
  {
    label: "Codex",
    viewBox: "0 0 256 260",
    path: "M239.183914,106.202783 C245.054304,88.5242096 243.02228,69.1733805 233.607599,53.0998864 C219.451678,28.4588021 190.999703,15.7836129 163.213007,21.739505 C147.554077,4.32145883 123.794909,-3.42398554 100.87901,1.41873898 C77.9631105,6.26146349 59.3690093,22.9572536 52.0959621,45.2214219 C33.8436494,48.9644867 18.0901721,60.392749 8.86672513,76.5818033 C-5.443491,101.182962 -2.19544431,132.215255 16.8986662,153.320094 C11.0060865,170.990656 13.0197283,190.343991 22.4238231,206.422991 C36.5975553,231.072344 65.0680342,243.746566 92.8695738,237.783372 C105.235639,251.708249 123.001113,259.630942 141.623968,259.52692 C170.105359,259.552169 195.337611,241.165718 204.037777,214.045661 C222.28734,210.296356 238.038489,198.869783 247.267014,182.68528 C261.404453,158.127515 258.142494,127.262775 239.183914,106.202783 L239.183914,106.202783 Z M141.623968,242.541207 C130.255682,242.559177 119.243876,238.574642 110.519381,231.286197 L112.054146,230.416496 L163.724595,200.590881 C166.340648,199.056444 167.954321,196.256818 167.970781,193.224005 L167.970781,120.373788 L189.815614,133.010026 C190.034132,133.121423 190.186235,133.330564 190.224885,133.572774 L190.224885,193.940229 C190.168603,220.758427 168.442166,242.484864 141.623968,242.541207 Z M37.1575749,197.93062 C31.456498,188.086359 29.4094818,176.546984 31.3766237,165.342426 L32.9113895,166.263285 L84.6329973,196.088901 C87.2389349,197.618207 90.4682717,197.618207 93.0742093,196.088901 L156.255402,159.663793 L156.255402,184.885111 C156.243557,185.149771 156.111725,185.394602 155.89729,185.550176 L103.561776,215.733903 C80.3054953,229.131632 50.5924954,221.165435 37.1575749,197.93062 Z M23.5493181,85.3811273 C29.2899861,75.4733097 38.3511911,67.9162648 49.1287482,64.0478825 L49.1287482,125.438515 C49.0891492,128.459425 50.6965386,131.262556 53.3237748,132.754232 L116.198014,169.025864 L94.3531808,181.662102 C94.1132325,181.789434 93.8257461,181.789434 93.5857979,181.662102 L41.3526015,151.529534 C18.1419426,138.076098 10.1817681,108.385562 23.5493181,85.125333 L23.5493181,85.3811273 Z M203.0146,127.075598 L139.935725,90.4458545 L161.7294,77.8607748 C161.969348,77.7334434 162.256834,77.7334434 162.496783,77.8607748 L214.729979,108.044502 C231.032329,117.451747 240.437294,135.426109 238.871504,154.182739 C237.305714,172.939368 225.050719,189.105572 207.414262,195.67963 L207.414262,134.288998 C207.322521,131.276867 205.650697,128.535853 203.0146,127.075598 Z M224.757116,94.3850867 L223.22235,93.4642272 L171.60306,63.3828173 C168.981293,61.8443751 165.732456,61.8443751 163.110689,63.3828173 L99.9806554,99.8079259 L99.9806554,74.5866077 C99.9533004,74.3254088 100.071095,74.0701869 100.287609,73.9215426 L152.520805,43.7889738 C168.863098,34.3743518 189.174256,35.2529043 204.642579,46.0434841 C220.110903,56.8340638 227.949269,75.5923959 224.757116,94.1804513 L224.757116,94.3850867 Z M88.0606409,139.097931 L66.2158076,126.512851 C65.9950399,126.379091 65.8450965,126.154176 65.8065367,125.898945 L65.8065367,65.684966 C65.8314495,46.8285367 76.7500605,29.6846032 93.8270852,21.6883055 C110.90411,13.6920079 131.063833,16.2835462 145.5632,28.338998 L144.028434,29.2086986 L92.3579852,59.0343142 C89.7419327,60.5687513 88.1282597,63.3683767 88.1117998,66.4011901 L88.0606409,139.097931 Z M99.9294965,113.5185 L128.06687,97.3011417 L156.255402,113.5185 L156.255402,145.953218 L128.169187,162.170577 L99.9806554,145.953218 L99.9294965,113.5185 Z",
  },
  {
    label: "VS Code",
    viewBox: "0 0 256 254",
    path: "M180.82764,252.605272 C184.843951,254.170159 189.42406,254.069552 193.478224,252.11917 L245.979142,226.856851 C251.495593,224.202221 255.003889,218.618034 255.003889,212.49296 L255.003889,41.1971845 C255.003889,35.0719113 251.495593,29.4886211 245.979142,26.8339907 L193.478224,1.57068551 C188.158006,-0.989256713 181.931329,-0.362230036 177.262566,3.0323459 C176.595173,3.51727166 175.959655,4.05869672 175.363982,4.65536598 L74.8565893,96.3498444 L31.0778002,63.1181557 C27.0024197,60.0246398 21.3020866,60.2780499 17.5170718,63.7211005 L3.47578059,76.4937075 C-1.15402423,80.7052561 -1.15933349,87.9889043 3.46431538,92.2072265 L41.430759,126.844525 L3.46431538,161.482221 C-1.15933349,165.700742 -1.15402423,172.984291 3.47578059,177.19584 L17.5170718,189.967949 C21.3020866,193.411497 27.0024197,193.664509 31.0778002,190.571591 L74.8565893,157.339404 L175.363982,249.034221 C176.953772,250.625007 178.82048,251.823326 180.82764,252.605272 Z M191.291764,68.9559518 L115.029663,126.844525 L191.291764,184.733396 L191.291764,68.9559518 Z",
  },
  {
    label: "Windsurf",
    viewBox: "0 0 24 24",
    path: "M23.55 5.067c-1.2038-.002-2.1806.973-2.1806 2.1765v4.8676c0 .972-.8035 1.7594-1.7597 1.7594-.568 0-1.1352-.286-1.4718-.7659l-4.9713-7.1003c-.4125-.5896-1.0837-.941-1.8103-.941-1.1334 0-2.1533.9635-2.1533 2.153v4.8957c0 .972-.7969 1.7594-1.7596 1.7594-.57 0-1.1363-.286-1.4728-.7658L.4076 5.1598C.2822 4.9798 0 5.0688 0 5.2882v4.2452c0 .2147.0656.4228.1884.599l5.4748 7.8183c.3234.462.8006.8052 1.3509.9298 1.3771.313 2.6446-.747 2.6446-2.0977v-4.893c0-.972.7875-1.7593 1.7596-1.7593h.003a1.798 1.798 0 0 1 1.4718.7658l4.9723 7.0994c.4135.5905 1.05.941 1.8093.941 1.1587 0 2.1515-.9645 2.1515-2.153v-4.8948c0-.972.7875-1.7594 1.7596-1.7594h.194a.22.22 0 0 0 .2204-.2202v-4.622a.22.22 0 0 0-.2203-.2203Z",
  },
  {
    label: "Cline",
    viewBox: "0 0 24 24",
    path: "m23.365 13.556-1.442-2.895V8.994c0-2.764-2.218-5.002-4.954-5.002h-2.464c.178-.367.276-.779.276-1.213A2.77 2.77 0 0 0 12.018 0a2.77 2.77 0 0 0-2.763 2.779c0 .434.098.846.276 1.213H7.067c-2.736 0-4.954 2.238-4.954 5.002v1.667L.64 13.549c-.149.29-.149.636 0 .927l1.472 2.855v1.667C2.113 21.762 4.33 24 7.067 24h9.902c2.736 0 4.954-2.238 4.954-5.002V17.33l1.44-2.865c.143-.286.143-.622.002-.91m-12.854 2.36a2.27 2.27 0 0 1-2.261 2.273 2.27 2.27 0 0 1-2.261-2.273v-4.042A2.27 2.27 0 0 1 8.249 9.6a2.267 2.267 0 0 1 2.262 2.274zm7.285 0a2.27 2.27 0 0 1-2.26 2.273 2.27 2.27 0 0 1-2.262-2.273v-4.042A2.267 2.267 0 0 1 15.535 9.6a2.267 2.267 0 0 1 2.261 2.274z",
  },
] as const;

export function McpInstallPanel() {
  const [secret, setSecret] = useState("");
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  // Read the cached token + active workspace on mount.
  useEffect(() => {
    setSecret(readStoredSecret());
    setWorkspaceId(getActiveWorkspaceId());
  }, []);

  const hasToken = secret.length > 0;

  // The snippet always renders the REAL config shape. When no token is cached
  // yet, the placeholder is an honest <YOUR_TOKEN> so nothing is faked — and the
  // "Generate token" CTA below mints one in-place and bakes it in.
  const snippet = useMemo(
    () => buildMcpJson(hasToken ? secret : "<YOUR_TOKEN>", workspaceId),
    [hasToken, secret, workspaceId],
  );

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setError("Could not copy to clipboard.");
    }
  }, [snippet]);

  const generateToken = useCallback(async () => {
    setGenerating(true);
    setError("");
    try {
      const token = await generateOssToken("mcp-install");
      setSecret(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate token");
    } finally {
      setGenerating(false);
    }
  }, []);

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-medium text-foreground">Agent install</h2>
        <p className="text-xs text-muted-foreground">
          Copy this into Claude Desktop, Cursor, VS Code, Windsurf, Cline, or any
          MCP client. {hasToken
            ? "Your key is already included."
            : "Create a key below to include it."}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Supported MCP clients">
        {MCP_CLIENTS.map((client) => (
          <div
            key={client.label}
            className="flex h-10 items-center gap-2 rounded-[var(--radius-ui)] bg-[var(--bg-2)] px-2.5 text-[12px] text-[var(--ink-soft)]"
          >
            <span className="grid size-6 shrink-0 place-items-center rounded-[var(--radius-ui)] bg-[var(--bg-card)] text-[var(--ink)] shadow-[0_0_0_1px_var(--border-soft)]">
              <svg
                viewBox={client.viewBox}
                aria-hidden="true"
                className="size-3.5 fill-current"
                focusable="false"
              >
                <path d={client.path} />
              </svg>
            </span>
            <span className="truncate font-medium">{client.label}</span>
          </div>
        ))}
      </div>

      {/* code block + copy */}
      <div className="relative">
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="absolute right-2.5 top-2.5 z-10 inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-button)] bg-[var(--bg-card)] px-2.5 text-[12px] font-medium text-[var(--ink-soft)] shadow-[0_1px_2px_hsl(0_0%_0%/.06),0_0_0_1px_var(--border-soft)] transition-colors hover:text-ink"
          aria-label={copied ? "Copied" : "Copy config"}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
        <pre className="overflow-x-auto rounded-[var(--radius-button)] bg-[var(--bg-2)] px-4 py-4 pr-20 font-mono text-[12.5px] leading-[1.7] text-[var(--ink-soft)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <code>{snippet}</code>
        </pre>
      </div>

      {/* token state */}
      {!hasToken && (
        <div className="flex items-center gap-2.5 rounded-[var(--radius-button)] bg-[var(--bg-2)] px-3 py-2.5">
          <p className="flex-1 text-[12px] leading-snug text-[var(--ink-mute)]">
            No key in this browser yet. Create one to include it in the config above.
          </p>
          <button
            type="button"
            onClick={() => void generateToken()}
            disabled={generating}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[var(--radius-button)] bg-[var(--primary)] px-3 text-[12px] font-medium text-[var(--primary-text)] transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <RefreshCw className={"size-3 " + (generating ? "animate-spin" : "")} />
            {generating ? "Generating" : "Create key"}
          </button>
        </div>
      )}

      {error && <p className="text-[12px] text-[var(--warning)]">{error}</p>}

      <p className="text-[12px] leading-relaxed text-[var(--ink-mute)]">
        Drop it into your client&apos;s MCP config and your workers show up as tools.
        The key scopes to{" "}
        <code className="font-mono text-[11.5px]">{getPublicApiHost()}</code>;
        rotate it anytime in Settings → Connect &amp; automate.
      </p>

      {/* Round-09 batch2: with the in-page Connections tab row gone, the full
          MCP page (register MCP servers your workers call) is reached from here
          — the popup is the canonical MCP entry, no duplicate sidebar nav. */}
      <Link
        href="/connections/mcp"
        className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--ink-soft)] transition-colors hover:text-ink"
      >
        Manage MCP servers
        <ArrowRight className="size-3" />
      </Link>
    </div>
  );
}
