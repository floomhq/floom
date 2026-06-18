"use client";

import { LegalDoc, MailLink, type LegalSection } from "../_legal/LegalDoc";

const SECTIONS: LegalSection[] = [
  {
    id: "what-we-store",
    title: "What we store",
    body: (
      <>
        The prompts you write, the workers you create, the runs they produce,
        and the connections you authorize. We store enough to show every run on
        the record so you can audit what a worker did on your behalf.
      </>
    ),
  },
  {
    id: "connected-tools",
    title: "Your connected tools",
    body: (
      <>
        When you connect Gmail, Slack, HubSpot, Notion, or any of the 1,000+
        tools we support via Composio, Floom holds the OAuth token and uses it
        only to run the workers you build. Revoking access in the source tool
        stops every worker that depends on it.
      </>
    ),
  },
  {
    id: "who-can-see",
    title: "Who can see your data",
    body: (
      <>
        Your workspace and its members. Floom support reviews data only when you
        ask us to debug a run. We do not sell data, we do not train shared models
        on your worker outputs, and we do not share your data with third parties
        beyond the tools you connect.
      </>
    ),
  },
  {
    id: "deleting",
    title: "Deleting your data",
    body: (
      <>
        Workspace owners can delete a workspace from settings. Deletion removes
        worker definitions, run history, connection tokens, and uploaded company
        brain documents from primary storage within 7 days and from backups
        within 30.
      </>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <>
        Questions about your data, a request to delete it, or a security report:{" "}
        <MailLink />.
      </>
    ),
  },
];

export function PrivacyBody() {
  return (
    <LegalDoc
      eyebrow="Privacy"
      headline={["How Floom handles your ", "."]}
      highlight="data"
      lastUpdated="2026-06-06"
      intro={
        <>
          This is the short version; reach out at <MailLink /> for the long one.
        </>
      }
      sections={SECTIONS}
      crossLink={{ href: "/terms", label: "Terms" }}
    />
  );
}
