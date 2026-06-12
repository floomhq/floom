import Link from "next/link";
import Image from "next/image";
import { V3Shell } from "@/app/v3/V3Shell";

export const metadata = {
  title: "Not found — Floom",
};

export default function NotFound() {
  return (
    <V3Shell>
      <main className="mx-auto flex min-h-[60vh] max-w-md items-center justify-center text-center">
        <div>
          <Image src="/floom-mark.svg" alt="" width={38} height={38} className="mx-auto" />
          <div className="mt-8 text-[11px] font-medium uppercase tracking-[0.18em]" style={{ color: "var(--v3-accent)" }}>
            404
          </div>
          <h1 className="mt-3 text-balance text-[36px] font-semibold leading-[1.05] tracking-[-0.025em] text-foreground sm:text-[44px]">
            Nothing here.
          </h1>
          <p className="mx-auto mt-4 max-w-sm text-[15px] text-muted-foreground">
            The page you tried does not exist. Head back home and describe the worker you need.
          </p>
          <div className="mt-8 flex items-center justify-center gap-2">
            <Link
              href="/"
              className="inline-flex h-10 items-center rounded-[10px] px-4 text-[13px] font-medium text-white transition hover:-translate-y-px"
              style={{ background: "var(--v3-accent)" }}
            >
              Back home
            </Link>
            <Link
              href="/templates"
              className="inline-flex h-10 items-center rounded-[10px] bg-secondary px-4 text-[13px] font-medium text-foreground transition hover:bg-[var(--bg-3)]"
            >
              Browse templates
            </Link>
          </div>
        </div>
      </main>
    </V3Shell>
  );
}
