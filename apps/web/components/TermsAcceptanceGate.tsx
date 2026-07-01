"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { safeStorageGet, safeStorageSet } from "@/lib/safe-storage";

const TERMS_ACCEPTED_KEY_PREFIX = "floom.terms.accepted.v1";
const TERMS_PREVIEW_KEY = "floom.terms.previewGate";

type TermsAwareUser = Awaited<ReturnType<typeof api.me>> & {
  terms_required?: boolean;
  requires_terms_acceptance?: boolean;
  terms_accepted?: boolean;
  accepted_terms?: boolean;
  terms_accepted_at?: string | null;
};

function userNeedsTerms(user: TermsAwareUser | null): boolean {
  if (!user) return false;
  if (user.terms_required === true || user.requires_terms_acceptance === true) {
    return user.terms_accepted !== true && user.accepted_terms !== true && !user.terms_accepted_at;
  }
  if (user.terms_accepted === false || user.accepted_terms === false) return true;
  return false;
}

function termsAcceptedKey(user: TermsAwareUser): string {
  return `${TERMS_ACCEPTED_KEY_PREFIX}:${user.workspace_id ?? "default"}:${user.user_id}`;
}

export function TermsAcceptanceGate() {
  const [open, setOpen] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [acceptedKey, setAcceptedKey] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const previewGate = safeStorageGet("local", TERMS_PREVIEW_KEY) === "1";
    if (previewGate) setOpen(true);

    void api.me()
      .then((user) => {
        if (!alive) return;
        const typedUser = user as TermsAwareUser;
        const storageKey = termsAcceptedKey(typedUser);
        setAcceptedKey(storageKey);
        if (safeStorageGet("local", storageKey) === "1") {
          setAccepted(true);
          setOpen(false);
          return;
        }
        if (userNeedsTerms(typedUser)) setOpen(true);
      })
      .catch(() => {
        if (alive && previewGate) setOpen(true);
      });

    return () => {
      alive = false;
    };
  }, []);

  function acceptTerms() {
    if (acceptedKey) safeStorageSet("local", acceptedKey, "1");
    setAccepted(true);
    setOpen(false);
  }

  if (accepted) return null;

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => accepted && setOpen(nextOpen)}>
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Accept Floom terms</DialogTitle>
          <DialogDescription>
            Review the terms and privacy notice before continuing with connected accounts, worker runs, and workspace data.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-[var(--radius-card)] bg-[var(--bg-2)] px-4 py-3 text-sm leading-6 text-[var(--muted-text)]">
          Floom runs workers against tools and data you connect. Keep access limited to accounts and workspaces you are authorized to use.
        </div>
        <div className="flex flex-wrap gap-3 text-sm">
          <Link className="text-[var(--ink)] underline-offset-4 hover:underline" href="/terms" target="_blank" rel="noreferrer">
            Terms
          </Link>
          <Link className="text-[var(--ink)] underline-offset-4 hover:underline" href="/privacy" target="_blank" rel="noreferrer">
            Privacy
          </Link>
          <a
            className="text-[var(--ink)] underline-offset-4 hover:underline"
            href="https://github.com/floomhq/floom/security/policy"
            target="_blank"
            rel="noreferrer"
          >
            Security
          </a>
        </div>
        <DialogFooter>
          <Button type="button" onClick={acceptTerms}>
            Accept and continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
