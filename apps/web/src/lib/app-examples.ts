// Per-slug seeded example inputs for the 3 hero launch demo apps on
// floom.dev (public store allowlist — see apps/web/src/lib/hub-filter.ts
// and apps/server/src/services/launch-demos.ts). Launch-hardening
// 2026-04-23 for the 2026-04-27 launch.
//
// Rationale: the default samplePrefill helper (lib/onboarding.ts) only
// knows about generic names (url, query, prompt, …) and fills exactly
// one input. The 3 hero apps have multi-field forms AND a required file
// upload, which is a deer-in-headlights moment if the visitor lands on
// /p/<slug> without context. Every field the visitor can reasonably
// inspect should already have a realistic value.
//
// File inputs: we bundle the exact same sample files that ship under
// examples/<slug>/ into apps/web/public/examples/<slug>/ so the bundle
// stays self-contained (no live network fetch to a third-party domain
// and no extra round-trip to the API). `loadSampleFile(slug, inputName)`
// returns a real `File` the FileInputControl can consume via onChange —
// same codepath as a user dropping a local file.
//
// Non-hero apps: `getLaunchDemoExampleTextInputs` returns null so the
// generic samplePrefill fallback keeps working for them.

/**
 * Map of InputSpec.name → the literal string to pre-fill. Covers every
 * text/textarea/url input on the app. File inputs are surfaced via
 * the separate `files` map below so the UI layer can render a
 * per-control "Load example" button.
 */
export type DemoTextPrefill = Record<string, string>;

export interface DemoFilePrefill {
  /** Public asset path served by the Vite dev server + production build. */
  publicPath: string;
  /** Original filename surfaced to the user when the File is attached. */
  filename: string;
  /** MIME type the FileEnvelope carries on the wire. */
  mimeType: string;
  /** Short user-facing label for the "Load example" button. */
  buttonLabel: string;
}

interface DemoExample {
  /** Map of InputSpec.name → literal string value. */
  text: DemoTextPrefill;
  /** Optional file-input prefills keyed by InputSpec.name. */
  files?: Record<string, DemoFilePrefill>;
}

/**
 * Registry: slug → example. Only slugs listed here are considered
 * launch demos; every other slug falls through to the generic
 * samplePrefill helper. Keep this list in sync with
 * apps/server/src/lib/byok-gate.ts::BYOK_GATED_SLUGS.
 */
const LAUNCH_DEMO_EXAMPLES: Record<string, DemoExample> = {
  'lead-scorer': {
    text: {
      icp:
        'B2B SaaS CFOs at 100-500 employee fintechs in EU. Looking for finance leaders '
        + 'at growth-stage companies with recent funding or hiring signals.',
    } as DemoTextPrefill,
    files: {
      data: {
        publicPath: '/examples/lead-scorer/sample-leads.csv',
        filename: 'sample-leads.csv',
        mimeType: 'text/csv',
        buttonLabel: 'Load 8-row sample CSV',
      },
    },
  },
  'competitor-analyzer': {
    text: {
      urls: 'https://linear.app\nhttps://notion.so\nhttps://asana.com',
      your_product:
        'We sell B2B sales automation software to EU mid-market teams. ' +
        'AI-native, usage-based pricing, integrates with Salesforce and HubSpot.',
    },
  },
  'resume-screener': {
    text: {
      job_description:
        'Senior Backend Engineer (Remote EU). 5+ years building production Python services.\n' +
        'Responsibilities: own the ingestion pipeline, design the scoring model, mentor two\n' +
        'engineers. Stack: Python 3.12, FastAPI, Postgres, Redis, AWS. Nice-to-have: past\n' +
        'experience with LLM products or high-throughput ETL.',
      must_haves:
        '5+ years Python\nProduction Postgres experience\nRemote-friendly timezone (UTC-3 to UTC+3)',
    },
    files: {
      cvs_zip: {
        publicPath: '/examples/resume-screener/sample-cvs.zip',
        filename: 'sample-cvs.zip',
        mimeType: 'application/zip',
        buttonLabel: 'Load 3 sample CVs (.zip)',
      },
    },
  },
};

/**
 * Return the text-input prefills for a launch-demo slug, or null if the
 * slug isn't one of the 3 hero apps. Consumed by AppPermalinkPage to
 * build `initialInputs` without clobbering the generic samplePrefill
 * path for every other app.
 */
export function getLaunchDemoExampleTextInputs(
  slug: string,
): Record<string, string> | null {
  const demo = LAUNCH_DEMO_EXAMPLES[slug];
  if (!demo) return null;
  return { ...demo.text };
}

/**
 * Return the file-input metadata for a launch-demo slug, keyed by
 * InputSpec.name, or null if no file examples are configured. The UI
 * layer uses this to render a "Load example" button next to the file
 * drop zone on the 3 hero apps.
 */
export function getLaunchDemoFilePrefills(
  slug: string,
): Record<string, DemoFilePrefill> | null {
  const demo = LAUNCH_DEMO_EXAMPLES[slug];
  if (!demo?.files) return null;
  return { ...demo.files };
}

/**
 * Fetch a bundled sample file from the web public dir and return it as
 * a real `File` the FileInputControl can consume via onChange. Throws
 * (so callers can surface an error toast) when the fetch fails.
 */
export async function loadSampleFile(
  slug: string,
  inputName: string,
): Promise<File> {
  const demo = LAUNCH_DEMO_EXAMPLES[slug];
  const meta = demo?.files?.[inputName];
  if (!meta) {
    throw new Error(`No sample file registered for ${slug}.${inputName}`);
  }
  const resp = await fetch(meta.publicPath, { cache: 'force-cache' });
  if (!resp.ok) {
    throw new Error(
      `Failed to load sample file (${resp.status} ${resp.statusText})`,
    );
  }
  const blob = await resp.blob();
  // Preserve the declared MIME type so the Python handler sees a clean
  // Content-Type on the materialized file. Some servers (and the blob
  // from fetch()) occasionally return "application/octet-stream" for
  // static assets; we always want the logical type here.
  return new File([blob], meta.filename, { type: meta.mimeType });
}

/** True when the slug is one of the 3 hero launch demos. */
export function isLaunchDemoSlug(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(LAUNCH_DEMO_EXAMPLES, slug);
}
