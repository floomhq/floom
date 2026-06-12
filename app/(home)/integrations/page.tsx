import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { V3Shell } from "@/app/v3/V3Shell";
import {
  GCalLogo,
  GitHubSVG,
  GmailLogo,
  GranolaLogo,
  HubSpotLogo,
  LinkedInLogo,
  NotionLogo,
  SalesforceLogo,
  SheetsLogo,
  SlackLogo,
} from "@/components/landing-icons";

export const metadata: Metadata = {
  title: "Integrations — Floom",
  description:
    "Connect Floom to Slack, Gmail, Google Calendar, Drive, Sheets, Notion, Linear, GitHub, HubSpot, Salesforce, LinkedIn, Apollo, and more.",
};

type Logo = () => ReactNode;

function GoogleDriveLogo() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        fill="#1E8E3E"
        d="M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z"
      />
    </svg>
  );
}

function LinearLogo() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        fill="#5E6AD2"
        d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z"
      />
    </svg>
  );
}

function ApolloLogo() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        fill="#5C2D91"
        d="M12 0C5.372 0 0 5.373 0 12c0 6.628 5.372 12 12 12 6.627 0 12-5.372 12-12a12.014 12.014 0 0 0-.473-3.343.6.6 0 0 0-1.127.409h-.002c.265.943.402 1.928.402 2.934a10.73 10.73 0 0 1-3.163 7.637A10.729 10.729 0 0 1 12 22.8a10.73 10.73 0 0 1-7.637-3.163A10.728 10.728 0 0 1 1.2 12a10.73 10.73 0 0 1 3.163-7.637A10.728 10.728 0 0 1 12 1.2c2.576 0 5.013.896 6.958 2.54a1.466 1.466 0 1 0 .862-.84A11.953 11.953 0 0 0 12 0Zm-1.44 5.88-4.2 10.902h2.63l.687-1.848h3.969l-.719-2.042h-2.613l1.7-4.691 3.024 8.58h2.631L13.47 5.88Z"
      />
    </svg>
  );
}

function GoogleDocsLogo() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M14.727 6.727H14V0H4.91c-.905 0-1.637.732-1.637 1.636v20.728c0 .904.732 1.636 1.636 1.636h14.182c.904 0 1.636-.732 1.636-1.636V6.727h-6zm-.545 10.455H7.09v-1.364h7.09v1.364zm2.727-3.273H7.091v-1.364h9.818v1.364zm0-3.273H7.091V9.273h9.818v1.363zM14.727 6h6l-6-6v6z"
      />
    </svg>
  );
}

type Integration = {
  name: string;
  category: "Communication" | "Google Workspace" | "CRM" | "Knowledge" | "Product" | "Data";
  detail: string;
  Logo: Logo;
};

const CONNECTION_CATALOG: Integration[] = [
  { name: "Granola", category: "Knowledge", detail: "Meeting notes and call context", Logo: GranolaLogo },
  { name: "Gmail", category: "Google Workspace", detail: "Read, draft, and send email", Logo: GmailLogo },
  { name: "Google Calendar", category: "Google Workspace", detail: "Meetings, schedules, and prep", Logo: GCalLogo },
  { name: "Google Drive", category: "Google Workspace", detail: "Docs, files, and shared context", Logo: GoogleDriveLogo },
  { name: "Slack", category: "Communication", detail: "Ask, approve, and receive finished work", Logo: SlackLogo },
  { name: "Notion", category: "Knowledge", detail: "Pages, playbooks, and internal docs", Logo: NotionLogo },
  { name: "Linear", category: "Product", detail: "Issues, projects, and status updates", Logo: LinearLogo },
  { name: "GitHub", category: "Product", detail: "Repos, PRs, issues, and engineering reports", Logo: GitHubSVG },
  { name: "HubSpot", category: "CRM", detail: "Contacts, companies, deals, and notes", Logo: HubSpotLogo },
  { name: "Salesforce", category: "CRM", detail: "Accounts, opportunities, and CRM updates", Logo: SalesforceLogo },
  { name: "LinkedIn", category: "CRM", detail: "Prospect research and sales context", Logo: LinkedInLogo },
  { name: "Apollo", category: "Data", detail: "Lead enrichment and prospect lists", Logo: ApolloLogo },
];

const WORKSPACE_TOOLS: Integration[] = [
  { name: "Google Sheets", category: "Google Workspace", detail: "Reports, lists, and structured outputs", Logo: SheetsLogo },
  { name: "Google Docs", category: "Google Workspace", detail: "Briefs, drafts, and source documents", Logo: GoogleDocsLogo },
];

const ALL_INTEGRATIONS = [...CONNECTION_CATALOG, ...WORKSPACE_TOOLS];

export default function IntegrationsPage() {
  return (
    <V3Shell active="integrations">
      <section className="pb-12 pt-16 sm:pt-20">
        <div>
          <div className="max-w-2xl">
            <div className="mb-4 inline-flex items-center rounded-full bg-[var(--v3-sel)] px-3 py-1 text-[12px] font-medium text-[var(--v3-accent)]">
              Connects to your tools
            </div>
            <h1 className="text-balance text-[38px] font-semibold leading-[1.04] tracking-[-0.03em] sm:text-[58px]">
              Workers plug into the stack your team already uses.
            </h1>
            <p className="mt-5 max-w-xl text-[16px] leading-relaxed text-[var(--text-muted)]">
              Floom connects to communication, CRM, knowledge, and product systems so a worker can read the right context, produce the output, and ask for approval where your team already works.
            </p>
          </div>
        </div>
      </section>

      <section className="pb-20">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {ALL_INTEGRATIONS.map(({ name, category, detail, Logo }) => (
            <article
              key={name}
              className="flex min-h-[172px] flex-col rounded-[8px] bg-card p-5 transition-colors hover:bg-secondary/60"
            >
              <div className="flex items-center justify-between gap-4">
                <span className="flex h-10 w-10 items-center justify-center rounded-[8px] bg-background [&_svg]:h-6 [&_svg]:w-6">
                  <Logo />
                </span>
                <span className="rounded-full bg-secondary px-2.5 py-1 text-[10.5px] font-medium text-muted-foreground">
                  {category}
                </span>
              </div>
              <h2 className="mt-5 text-[16px] font-semibold tracking-[-0.012em]">{name}</h2>
              <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{detail}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="bg-card/60 py-14">
        <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-[24px] font-semibold tracking-[-0.02em]">Bring one job. Connect only what it needs.</h2>
            <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-muted-foreground">
              Each worker gets scoped tools and approval gates. You can expand access later from the connections page.
            </p>
          </div>
          <Link
            href="/templates"
            className="inline-flex h-11 w-fit items-center rounded-[10px] px-5 text-[14px] font-medium text-white transition hover:-translate-y-px"
            style={{ background: "var(--v3-accent)" }}
          >
            Browse workers
          </Link>
        </div>
      </section>
    </V3Shell>
  );
}
