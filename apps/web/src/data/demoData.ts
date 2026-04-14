// Real outputs captured from the live preview.floom.dev API on 2026-04-14.
// These are NOT mocks. They are the actual response shapes the apps return,
// frozen so the homepage renders evidence without making a paid API call on
// every page load. Re-capture by running the curl commands below.
//
//   curl -s -X POST https://preview.floom.dev/api/run \
//     -H 'content-type: application/json' \
//     -d '{"app_slug":"flyfast","inputs":{"prompt":"Cheap flight from Berlin to Lisbon first week of May"}}'
//
//   curl -s -X POST https://preview.floom.dev/api/run \
//     -H 'content-type: application/json' \
//     -d '{"app_slug":"blast-radius","action":"analyze","inputs":{"repo_url":"https://github.com/floomhq/floom-monorepo"}}'

export interface FlightLeg {
  airline: string;
  flight_number: string;
  from: string;
  to: string;
  departs: string;
  arrives: string;
  duration_minutes: number;
}

export interface FlightResult {
  price: number;
  currency: string;
  duration_minutes: number;
  stops: number;
  route: string;
  legs: FlightLeg[];
  origin: string;
  destination: string;
  date: string;
  booking_url: string;
  booking_label: string;
}

export const FLYFAST_DEMO = {
  app_slug: 'flyfast',
  prompt: 'Cheap flight from Berlin to Lisbon first week of May',
  duration_ms: 8200,
  flights: [
    {
      price: 117,
      currency: 'EUR',
      duration_minutes: 225,
      stops: 0,
      route: 'BER -> LIS',
      legs: [
        {
          airline: 'FR',
          flight_number: '1142',
          from: 'BER',
          to: 'LIS',
          departs: '2026-05-07T06:45:00',
          arrives: '2026-05-07T09:30:00',
          duration_minutes: 225,
        },
      ],
      origin: 'BER',
      destination: 'LIS',
      date: '2026-05-07',
      booking_url:
        'https://www.skyscanner.net/transport/flights/ber/lis/260507/?adultsv2=1&cabinclass=economy&currency=EUR&sortby=cheapest&preferDirects=false',
      booking_label: 'Search on Skyscanner',
    },
    {
      price: 133,
      currency: 'EUR',
      duration_minutes: 690,
      stops: 1,
      route: 'BER -> BCN -> LIS',
      legs: [
        {
          airline: 'VY',
          flight_number: '1887',
          from: 'BER',
          to: 'BCN',
          departs: '2026-05-05T22:00:00',
          arrives: '2026-05-06T00:45:00',
          duration_minutes: 165,
        },
        {
          airline: 'VY',
          flight_number: '8460',
          from: 'BCN',
          to: 'LIS',
          departs: '2026-05-06T07:20:00',
          arrives: '2026-05-06T08:30:00',
          duration_minutes: 130,
        },
      ],
      origin: 'BER',
      destination: 'LIS',
      date: '2026-05-05',
      booking_url:
        'https://www.skyscanner.net/transport/flights/ber/lis/260505/?adultsv2=1&cabinclass=economy&currency=EUR&sortby=cheapest&preferDirects=false',
      booking_label: 'Search on Skyscanner',
    },
    {
      price: 142,
      currency: 'EUR',
      duration_minutes: 240,
      stops: 0,
      route: 'BER -> LIS',
      legs: [
        {
          airline: 'TP',
          flight_number: '533',
          from: 'BER',
          to: 'LIS',
          departs: '2026-05-04T11:25:00',
          arrives: '2026-05-04T14:25:00',
          duration_minutes: 240,
        },
      ],
      origin: 'BER',
      destination: 'LIS',
      date: '2026-05-04',
      booking_url:
        'https://www.skyscanner.net/transport/flights/ber/lis/260504/?adultsv2=1&cabinclass=economy&currency=EUR&sortby=cheapest&preferDirects=false',
      booking_label: 'Search on Skyscanner',
    },
  ] as FlightResult[],
  total_results: 20,
};

export interface BlastRadiusOutput {
  summary: string;
  changed: string[];
  affected: string[];
  tests: string[];
}

export const BLAST_RADIUS_DEMO = {
  app_slug: 'blast-radius',
  repo_url: 'https://github.com/floomhq/floom-monorepo',
  base_branch: 'HEAD~5',
  duration_ms: 4100,
  output: {
    summary: '15 changed, 7 affected, 2 test files',
    changed: [
      'apps/server/src/routes/run.ts',
      'apps/server/src/services/proxied-runner.ts',
      'apps/server/src/services/runner.ts',
      'apps/web/src/components/IconSprite.tsx',
      'apps/web/src/components/Logo.tsx',
      'apps/web/src/components/TopBar.tsx',
      'apps/web/src/components/chat/OutputPanel.tsx',
      'apps/web/src/lib/detectImageFormat.ts',
      'apps/web/src/lib/output-downloads.ts',
      'apps/web/src/pages/AboutPage.tsx',
      'apps/web/src/pages/AppPermalinkPage.tsx',
      'apps/web/src/pages/AppsDirectoryPage.tsx',
      'apps/web/src/pages/CreatorHeroPage.tsx',
      'apps/web/src/pages/ProtocolPage.tsx',
      'examples/tier4/ui-audit/app.py',
    ],
    affected: [
      'apps/server/src/index.ts',
      'apps/server/src/routes/mcp.ts',
      'apps/web/src/components/AppIcon.tsx',
      'apps/web/src/components/FloomApp.tsx',
      'apps/web/src/main.tsx',
      'apps/web/src/pages/BrowsePage.tsx',
      'apps/web/src/pages/NotFoundPage.tsx',
    ],
    tests: [
      'packages/runtime/tests/runtime/executor.test.ts',
      'packages/runtime/tests/runtime/manifest.test.ts',
    ],
  } as BlastRadiusOutput,
};

// The 15 launch apps shown live at preview.floom.dev/api/hub on 2026-04-14.
// Used to populate the "what's running right now" strip without an API call.
export const LAUNCH_APPS = [
  { slug: 'flyfast', name: 'FlyFast', category: 'travel', tagline: 'Search 100 flight combinations from one prompt.' },
  { slug: 'openpaper', name: 'OpenPaper', category: 'research', tagline: 'Generate fully cited academic papers.' },
  { slug: 'opendraft', name: 'OpenDraft', category: 'writing', tagline: 'Draft posts in your voice with citations.' },
  { slug: 'openblog', name: 'OpenBlog', category: 'writing', tagline: 'Long-form blog posts from a topic and outline.' },
  { slug: 'openslides', name: 'OpenSlides', category: 'design', tagline: 'Pitch decks from a single brief.' },
  { slug: 'opengtm', name: 'OpenGTM', category: 'marketing', tagline: 'Go-to-market plan generator.' },
  { slug: 'opencontext', name: 'OpenContext', category: 'marketing', tagline: 'Pull buyer context from public signals.' },
  { slug: 'openkeyword', name: 'OpenKeyword', category: 'seo', tagline: 'SEO keyword discovery without a SaaS.' },
  { slug: 'openanalytics', name: 'OpenAnalytics', category: 'analytics', tagline: 'Drop-in analytics for any site.' },
  { slug: 'session-recall', name: 'Session Recall', category: 'productivity', tagline: 'Search every Claude session ever.' },
  { slug: 'claude-wrapped', name: 'Claude Wrapped', category: 'productivity', tagline: 'Spotify Wrapped for Claude Code.' },
  { slug: 'hook-stats', name: 'Hook Stats', category: 'productivity', tagline: 'Stats on your Claude Code hook usage.' },
  { slug: 'bouncer', name: 'Bouncer', category: 'productivity', tagline: 'Independent quality gate for AI output.' },
  { slug: 'blast-radius', name: 'Blast Radius', category: 'developer-tools', tagline: 'Find every file affected by a diff.' },
  { slug: 'dep-check', name: 'Dep Check', category: 'developer-tools', tagline: 'Audit dependencies for known issues.' },
];
