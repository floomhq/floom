"use client";

import { LegalDoc, MailLink, type LegalSection } from "../_legal/LegalDoc";

const SECTIONS: LegalSection[] = [
  {
    id: "what-floom-is",
    title: "What Floom is",
    body: (
      <>
        Floom lets you describe a job and runs an AI worker that does it on a
        schedule, a webhook, or with your approval. You stay in control of every
        run and every connected tool.
      </>
    ),
  },
  {
    id: "your-account",
    title: "Your account",
    body: (
      <>
        You are responsible for keeping your sign-in credentials safe and for the
        workers you create in your workspace. You can hire, edit, and retire any
        worker at any time.
      </>
    ),
  },
  {
    id: "acceptable-use",
    title: "Acceptable use",
    body: (
      <>
        Floom is for legitimate work. No spam, no harassment, no fraud, no abuse
        of the tools you connect, no attempts to reverse-engineer or disrupt the
        service.
      </>
    ),
  },
  {
    id: "worker-outputs",
    title: "Worker outputs",
    body: (
      <>
        You own the worker outputs your workspace produces. You are responsible
        for reviewing them before they leave the platform, which is why workers
        ask for approval on anything that ships externally.
      </>
    ),
  },
  {
    id: "availability",
    title: "Service availability",
    body: (
      <>
        We work hard to keep Floom up and running. The service is provided as-is;
        we do not guarantee uninterrupted availability and we are not liable for
        losses that result from downtime, third-party tool outages, or worker
        behavior beyond a refund of fees paid for the affected period.
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes",
    body: (
      <>
        We may update these terms as the product grows. Material changes are
        flagged in-product and by email.
      </>
    ),
  },
];

export function TermsBody() {
  return (
    <LegalDoc
      eyebrow="Terms of service"
      headline={["The rules of the ", "."]}
      highlight="road"
      lastUpdated="2026-06-06"
      intro={
        <>
          By using Floom you agree to the terms below. Reach out at <MailLink />{" "}
          with questions.
        </>
      }
      sections={SECTIONS}
      crossLink={{ href: "/privacy", label: "Privacy" }}
    />
  );
}
