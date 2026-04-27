#!/usr/bin/env node
// Launch Scorecards — proxied-mode HTTP server for launch-focused app MVPs.
//
// Exposes:
//   GET  /health
//   GET  /openapi.json
//   GET  /linkedin-roaster/openapi.json
//   GET  /yc-pitch-deck-critic/openapi.json
//   POST /linkedin-roaster/score
//   POST /yc-pitch-deck-critic/score
//
// Pure Node.js, no external dependencies. LinkedIn URL scraping uses APIFY_API_KEY
// when configured, with pasted profile text as a deterministic fallback.
//
// Run: node examples/launch-scorecards/server.mjs
// Env: PORT=4120 (default)

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 4120);
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const APIFY_BASE_URL = 'https://api.apify.com/v2';
const LINKEDIN_ACTOR_ID =
  process.env.APIFY_LINKEDIN_ACTOR_ID || 'harvestapi~linkedin-profile-scraper';
const APIFY_TIMEOUT_MS = Number(process.env.APIFY_LINKEDIN_TIMEOUT_MS || 45_000);
const APIFY_POLL_MS = Number(process.env.APIFY_LINKEDIN_POLL_MS || 2_500);

function appSpec({ title, description, path, operationId, inputProperties, required }) {
  return {
    openapi: '3.0.0',
    info: {
      title,
      version: '0.1.0',
      description,
    },
    servers: [{ url: `http://localhost:${PORT}` }],
    paths: {
      [path]: {
        post: {
          operationId,
          summary: title,
          description,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required,
                  properties: inputProperties,
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Deterministic scorecard result',
              content: {
                'application/json': {
                  schema: scorecardSchema(),
                },
              },
            },
            400: {
              description: 'Invalid request body',
            },
          },
        },
      },
    },
  };
}

function scorecardSchema() {
  return {
    type: 'object',
    required: [
      'score',
      'verdict',
      'diagnosis',
      'top_issues',
      'rewrite',
      'suggestions',
      'next_steps',
      'share_card',
    ],
    properties: {
      score: { type: 'number', minimum: 0, maximum: 100 },
      verdict: { type: 'string' },
      diagnosis: { type: 'string' },
      top_issues: { type: 'array', items: { type: 'string' } },
      rewrite: { type: 'string' },
      suggestions: { type: 'array', items: { type: 'string' } },
      next_steps: { type: 'array', items: { type: 'string' } },
      share_card: {
        type: 'object',
        required: ['title', 'subtitle', 'score_label', 'bullets'],
        properties: {
          title: { type: 'string' },
          subtitle: { type: 'string' },
          score_label: { type: 'string' },
          bullets: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  };
}

const linkedinSpec = appSpec({
  title: 'LinkedIn Roaster',
  description:
    'Paste a LinkedIn profile URL. The app fetches the public profile, then scores positioning clarity, specificity, credibility, and conversion intent.',
  path: '/linkedin-roaster/score',
  operationId: 'scoreLinkedinProfile',
  required: ['linkedin_url'],
  inputProperties: {
    linkedin_url: {
      type: 'string',
      format: 'uri',
      description:
        'Public LinkedIn profile URL, for example https://www.linkedin.com/in/federicodeponte/.',
    },
    profile_text: {
      type: 'string',
      description:
        'Optional fallback text if the profile cannot be fetched. Include headline, About, experience, or featured summary.',
    },
    audience: {
      type: 'string',
      description: 'Target audience the profile needs to convince.',
      default: 'startup founders',
    },
    goal: {
      type: 'string',
      description: 'Desired profile outcome.',
      default: 'drive relevant inbound messages',
    },
  },
});

const deckSpec = appSpec({
  title: 'YC Pitch Deck Critic',
  description:
    'Upload an early-stage deck outline or text export and score it for YC-style clarity, urgency, insight, market, traction, and ask.',
  path: '/yc-pitch-deck-critic/score',
  operationId: 'scorePitchDeck',
  required: ['deck_file'],
  inputProperties: {
    deck_file: {
      type: 'string',
      format: 'binary',
      description:
        'Deck text export, Markdown outline, or slide transcript selected from your machine.',
    },
    deck: {
      type: 'string',
      description:
        'Optional pasted deck fallback. Slide headings improve the diagnosis.',
    },
    company: {
      type: 'string',
      description: 'Company or product name.',
      default: 'Startup',
    },
    stage: {
      type: 'string',
      description: 'Company stage.',
      default: 'pre-seed',
    },
  },
});

const combinedSpec = {
  openapi: '3.0.0',
  info: {
    title: 'Launch Scorecards',
    version: '0.1.0',
    description: 'Deterministic launch scorecards for LinkedIn profiles and YC-style pitch decks.',
  },
  servers: [{ url: `http://localhost:${PORT}` }],
  paths: {
    ...linkedinSpec.paths,
    ...deckSpec.paths,
  },
};

function clampScore(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function hasAny(text, terms) {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

function countMatches(text, pattern) {
  return (text.match(pattern) || []).length;
}

function wordCount(text) {
  const words = String(text || '').trim().match(/\b[\w'-]+\b/g);
  return words ? words.length : 0;
}

function sentenceCount(text) {
  const sentences = String(text || '').split(/[.!?]+/).filter((s) => s.trim().length > 0);
  return Math.max(1, sentences.length);
}

function scoreBand(score) {
  if (score >= 85) return 'Launch-ready';
  if (score >= 70) return 'Promising, needs tightening';
  if (score >= 50) return 'Clear enough to revise';
  return 'Needs a sharper core';
}

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function normalizeLinkedinUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';

  let candidate = raw;
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = candidate.includes('linkedin.com/')
      ? `https://${candidate}`
      : `https://www.linkedin.com/in/${candidate.replace(/^@/, '')}`;
  }

  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw httpError(400, 'linkedin_url must be a valid LinkedIn profile URL or handle');
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'linkedin.com' || !url.pathname.toLowerCase().startsWith('/in/')) {
    throw httpError(400, 'linkedin_url must point to a public linkedin.com/in/... profile');
  }

  url.protocol = 'https:';
  url.hostname = 'www.linkedin.com';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function apifyToken() {
  return process.env.APIFY_API_KEY || process.env.APIFY_TOKEN || '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apifyJson(url, options = {}) {
  const token = apifyToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 500) };
    }
  }
  if (!res.ok) {
    throw httpError(res.status, `Apify returned HTTP ${res.status}`);
  }
  return json;
}

async function fetchLinkedinProfile(linkedinUrl) {
  if (!apifyToken()) {
    throw httpError(
      503,
      'LinkedIn URL fetch is not configured. Set APIFY_API_KEY or provide profile_text as fallback.',
    );
  }

  const started = await apifyJson(
    `${APIFY_BASE_URL}/acts/${encodeURIComponent(LINKEDIN_ACTOR_ID)}/runs`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ urls: [linkedinUrl] }),
    },
  );
  const runId = started?.data?.id;
  if (!runId) throw httpError(502, 'Apify did not return an actor run id');

  const deadline = Date.now() + APIFY_TIMEOUT_MS;
  let run = started.data;
  while (Date.now() < deadline) {
    if (['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(run.status)) break;
    await sleep(APIFY_POLL_MS);
    const polled = await apifyJson(`${APIFY_BASE_URL}/actor-runs/${runId}`);
    run = polled.data || run;
  }

  if (run.status !== 'SUCCEEDED') {
    throw httpError(504, `LinkedIn profile fetch did not complete in time (${run.status || 'pending'})`);
  }

  const items = await apifyJson(`${APIFY_BASE_URL}/actor-runs/${runId}/dataset/items`);
  const profile = Array.isArray(items) ? items[0] : null;
  if (!profile || typeof profile !== 'object') {
    throw httpError(502, 'LinkedIn profile fetch returned no profile data');
  }
  return profile;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function summarizeExperience(profile) {
  const experience = profile.experience || profile.positions || profile.jobs || [];
  if (!Array.isArray(experience)) return '';
  return experience
    .slice(0, 5)
    .map((job) => {
      if (!job || typeof job !== 'object') return '';
      const title = firstString(job.title, job.position, job.role);
      const company = firstString(job.companyName, job.company, job.organization);
      const description = firstString(job.description, job.summary);
      return [title, company, description].filter(Boolean).join(' — ');
    })
    .filter(Boolean)
    .join('\n');
}

function profileToText(profile, linkedinUrl) {
  const fullName = firstString(profile.fullName, profile.name, profile.firstName);
  const headline = firstString(profile.headline, profile.occupation, profile.title);
  const about = firstString(profile.about, profile.summary, profile.description, profile.bio);
  const location = firstString(profile.location, profile.addressWithoutCountry, profile.geoLocationName);
  const currentCompany = firstString(
    profile.currentCompany,
    profile.currentCompanyName,
    profile.companyName,
  );
  const experiences = summarizeExperience(profile);
  return [
    fullName && `Name: ${fullName}`,
    headline && `Headline: ${headline}`,
    location && `Location: ${location}`,
    currentCompany && `Current company: ${currentCompany}`,
    about && `About:\n${about}`,
    experiences && `Experience:\n${experiences}`,
    `LinkedIn: ${linkedinUrl}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function resolveLinkedinProfileText(body) {
  const fallback = String(body.profile_text || '').trim();
  const linkedinUrl = normalizeLinkedinUrl(body.linkedin_url);
  if (!linkedinUrl && fallback) {
    return {
      profile: fallback,
      linkedinUrl: '',
      source: 'pasted_profile_text',
      scrapeStatus: 'not_requested',
    };
  }
  if (!linkedinUrl) throw httpError(400, 'linkedin_url is required');

  try {
    const scraped = await fetchLinkedinProfile(linkedinUrl);
    return {
      profile: profileToText(scraped, linkedinUrl),
      linkedinUrl,
      source: 'apify_linkedin_profile',
      scrapeStatus: 'succeeded',
    };
  } catch (error) {
    if (fallback) {
      return {
        profile: fallback,
        linkedinUrl,
        source: 'pasted_profile_text',
        scrapeStatus: `fallback_after_${error.statusCode || 'fetch'}_error`,
      };
    }
    throw error;
  }
}

async function scoreLinkedinProfile(body) {
  const resolved = await resolveLinkedinProfileText(body);
  const profile = resolved.profile;
  if (!profile) throw httpError(400, 'linkedin_url or profile_text is required');

  const audience = String(body.audience || 'startup founders').trim();
  const goal = String(body.goal || 'drive relevant inbound messages').trim();
  const words = wordCount(profile);
  const sentences = sentenceCount(profile);
  const avgSentence = words / sentences;
  const firstLine = profile.split(/\r?\n/).find((line) => line.trim()) || '';
  const hasSpecificHeadline =
    firstLine.length >= 20 &&
    firstLine.length <= 180 &&
    hasAny(firstLine, ['for ', 'help', 'building', 'founder', 'operator', 'ai', 'b2b', 'saas']);
  const hasProof = hasAny(profile, [
    '%',
    '$',
    'revenue',
    'users',
    'customers',
    'clients',
    'waitlist',
    'retention',
    'growth',
    'launched',
    'shipped',
    'built',
    'raised',
    'ex-',
  ]);
  const hasSpecificAudience = hasAny(profile, [
    'founder',
    'operator',
    'sales',
    'marketing',
    'engineer',
    'designer',
    'team',
    'startup',
    'buyer',
  ]);
  const hasClearOffer = hasAny(profile, [
    'help',
    'build',
    'building',
    'turn',
    'fix',
    'automate',
    'grow',
    'reduce',
    'increase',
    'ship',
  ]);
  const hasCta = hasAny(profile, [
    'dm',
    'message',
    'book',
    'work with',
    'contact',
    'try',
    'join',
    'subscribe',
  ]);
  const hasStructure = countMatches(profile, /\n/g) >= 3 || countMatches(profile, /[-•*]\s+/g) >= 2;
  const buzzwordCount = countMatches(
    profile.toLowerCase(),
    /\b(revolutionary|game-changing|disrupt|synergy|leverage|seamless|cutting-edge|innovative|world-class)\b/g,
  );

  let score = 40;
  if (words >= 80 && words <= 450) score += 10;
  if (words > 0 && words < 80) score += 3;
  if (words > 650) score -= Math.min(14, Math.ceil((words - 650) / 50));
  if (hasSpecificHeadline) score += 14;
  if (hasProof) score += 14;
  if (hasSpecificAudience) score += 10;
  if (hasClearOffer) score += 10;
  if (hasCta) score += 8;
  if (hasStructure) score += 8;
  if (avgSentence <= 26) score += 6;
  score -= buzzwordCount * 5;

  const topIssues = [];
  if (!hasSpecificHeadline) topIssues.push('The headline reads like a role label, not a sharp positioning sentence.');
  if (!hasProof) topIssues.push('The profile lacks proof such as numbers, customer facts, shipped work, or credible background.');
  if (!hasSpecificAudience) topIssues.push('The target reader is too broad; name the person with the painful problem.');
  if (!hasClearOffer) topIssues.push('The profile does not make the concrete offer obvious.');
  if (!hasCta) topIssues.push('The profile gives interested people no clear next step.');
  if (words > 650) topIssues.push('The profile is long; trim resume history and keep the current edge.');
  if (buzzwordCount > 0) topIssues.push('Buzzwords dilute the claim; replace them with specific outcomes.');
  if (!topIssues.length) topIssues.push('The profile has the right bones; the biggest gain is sharper proof and a more memorable headline.');

  const headlineRewrite = `Helping ${audience} ${goal} with specific, shipped AI workflows.`;
  const aboutRewrite = [
    `I build practical AI workflows for ${audience}.`,
    '',
    'The work is simple: turn messy, repeated expert work into small tools people can actually use.',
    '',
    'What I focus on:',
    '- clear input and output',
    '- visible proof instead of broad claims',
    '- workflows that ship as web apps, APIs, and agent-callable tools',
    '',
    'If you have a local script, internal workflow, or AI prototype that people cannot use yet, send it over.',
  ].join('\n');

  const finalScore = clampScore(score);
  return {
    linkedin_url: resolved.linkedinUrl || undefined,
    profile_source: resolved.source,
    scrape_status: resolved.scrapeStatus,
    score: finalScore,
    verdict: scoreBand(finalScore),
    diagnosis:
      finalScore >= 70
        ? 'The profile has enough clarity to drive relevant attention after tightening proof and the next step.'
        : 'The profile needs a clearer reader, sharper current edge, and more concrete evidence before it creates inbound pull.',
    top_issues: topIssues.slice(0, 5),
    rewrite: `Headline:\n${headlineRewrite}\n\nAbout:\n${aboutRewrite}`,
    suggestions: [
      'Turn the headline into a promise for a specific reader.',
      'Move old resume detail below current proof and current offer.',
      'Add one measurable proof point, named project, or concrete shipped artifact.',
      'End the About section with a low-friction next step.',
    ],
    next_steps: [
      'Rewrite the headline in one sentence using audience + outcome + proof.',
      'Add one proof line to the top third of the About section.',
      'Cut any line that only describes a past title without explaining current edge.',
      'Add one post idea that demonstrates the new positioning.',
    ],
    post_ideas: [
      `The mistake ${audience} make when they describe what they do.`,
      'A before/after teardown of a workflow that moved from localhost to a real app.',
      'The smallest proof point that makes a profile more credible than adjectives.',
    ],
    share_card: {
      title: 'LinkedIn Positioning Score',
      subtitle: scoreBand(finalScore),
      score_label: `${finalScore}/100`,
      bullets: topIssues.slice(0, 3),
    },
  };
}

function decodeUploadedText(value, fieldName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  if (value.__file !== true || typeof value.content_b64 !== 'string') return '';
  const name = typeof value.name === 'string' ? value.name.toLowerCase() : '';
  const mime = typeof value.mime_type === 'string' ? value.mime_type.toLowerCase() : '';
  if (name.endsWith('.pdf') || name.endsWith('.pptx') || mime.includes('pdf') || mime.includes('presentation')) {
    throw httpError(
      400,
      `${fieldName} needs a text export, Markdown outline, or slide transcript for this deterministic launch app.`,
    );
  }
  try {
    return Buffer.from(value.content_b64, 'base64').toString('utf-8');
  } catch {
    throw httpError(400, `could not decode uploaded ${fieldName}`);
  }
}

function resolveDeckText(body) {
  const uploaded = decodeUploadedText(body.deck_file, 'deck_file');
  const pasted = typeof body.deck === 'string' ? body.deck : '';
  const deck = (uploaded || pasted).trim();
  if (!deck) throw httpError(400, "missing required field 'deck_file' or pasted deck");
  return deck;
}

function scorePitchDeck(body) {
  const deck = resolveDeckText(body);

  const company = String(body.company || 'Startup').trim();
  const stage = String(body.stage || 'pre-seed').trim();
  const words = wordCount(deck);
  const lower = deck.toLowerCase();
  const slideLikeSections = countMatches(deck, /(^|\n)\s*(slide\s+\d+|\d+\.|#+)\s+/gi);
  const hasProblem = hasAny(lower, ['problem', 'pain', 'broken', 'manual', 'expensive', 'slow']);
  const hasCustomer = hasAny(lower, ['customer', 'user', 'buyer', 'founder', 'team', 'operator', 'persona']);
  const hasSolution = hasAny(lower, ['solution', 'product', 'platform', 'workflow', 'tool', 'app']);
  const hasMarket = hasAny(lower, ['market', 'tam', 'sam', 'som', 'billion', '$', 'industry']);
  const hasTraction = hasAny(lower, ['traction', 'revenue', 'mrr', 'arr', 'pilot', 'waitlist', 'customer', 'growth']);
  const hasInsight = hasAny(lower, ['insight', 'why now', 'because', 'wedge', 'unique', 'advantage']);
  const hasAsk = hasAny(lower, ['raise', 'raising', 'ask', 'use of funds', 'round', 'runway']);
  const hasCompetition = hasAny(lower, ['competitor', 'alternative', 'compete', 'incumbent', 'versus', 'vs.']);
  const hasTeam = hasAny(lower, ['team', 'founder', 'built', 'ex-', 'experience', 'background']);
  const vagueClaims = countMatches(
    lower,
    /\b(ai-powered|revolutionary|all-in-one|next-generation|democratize|transform|seamless|massive opportunity)\b/g,
  );

  let score = 28;
  if (words >= 250 && words <= 1600) score += 8;
  if (slideLikeSections >= 6) score += 8;
  if (hasProblem) score += 10;
  if (hasCustomer) score += 8;
  if (hasSolution) score += 8;
  if (hasMarket) score += 8;
  if (hasTraction) score += 12;
  if (hasInsight) score += 10;
  if (hasAsk) score += 6;
  if (hasCompetition) score += 5;
  if (hasTeam) score += 5;
  score -= vagueClaims * 4;
  if (words > 1800) score -= Math.min(15, Math.ceil((words - 1800) / 100));

  const topIssues = [];
  if (!hasProblem) topIssues.push('The deck does not state the painful problem in plain language.');
  if (!hasCustomer) topIssues.push('The buyer or user is not specific enough.');
  if (!hasTraction) topIssues.push('Traction is missing or not quantified.');
  if (!hasInsight) topIssues.push('The narrative needs a stronger earned insight or why-now wedge.');
  if (!hasMarket) topIssues.push('Market size or expansion path is underdeveloped.');
  if (!hasAsk) topIssues.push('The fundraising ask and use of funds are unclear.');
  if (vagueClaims > 0) topIssues.push('Generic startup language is replacing specific evidence.');
  if (!topIssues.length) topIssues.push('The core story is credible; tighten slide order and make traction more visual.');

  const finalScore = clampScore(score);
  return {
    score: finalScore,
    verdict: scoreBand(finalScore),
    diagnosis:
      finalScore >= 70
        ? `${company} has a coherent ${stage} fundraising story with enough signal for a focused rewrite.`
        : `${company} needs a simpler problem, sharper wedge, and stronger proof before this reads like a YC-grade deck.`,
    top_issues: topIssues.slice(0, 5),
    rewrite: [
      'Slide 1: One-line company description with customer, pain, and outcome.',
      'Slide 2: Problem with one concrete example and the cost of inaction.',
      'Slide 3: Insight or why now; explain what changed in the market.',
      'Slide 4: Product wedge with the smallest workflow that wins adoption.',
      'Slide 5: Traction using numbers, customer names, pilots, or usage momentum.',
      'Slide 6: Ask, milestone, and why this round changes the slope.',
    ].join('\n'),
    suggestions: [
      'Replace category claims with a specific customer workflow.',
      'Lead with urgency before product mechanics.',
      'Show traction as deltas over time, not isolated totals.',
      'Add a competitor or alternative slide that proves founder insight.',
    ],
    next_steps: [
      'Write the one-sentence pitch in the format: We help X do Y because Z changed.',
      'Add one slide with quantified traction or a credible manual pilot result.',
      'Cut slides that do not answer problem, insight, product, market, traction, team, or ask.',
    ],
    share_card: {
      title: 'YC Deck Score',
      subtitle: scoreBand(finalScore),
      score_label: `${finalScore}/100`,
      bullets: topIssues.slice(0, 3),
    },
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body exceeds 256KB'));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('request body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/health') {
    sendJson(res, 200, { ok: true, apps: ['linkedin-roaster', 'yc-pitch-deck-critic'] });
    return;
  }

  if (req.method === 'GET' && pathname === '/openapi.json') {
    sendJson(res, 200, combinedSpec);
    return;
  }

  if (req.method === 'GET' && pathname === '/linkedin-roaster/openapi.json') {
    sendJson(res, 200, linkedinSpec);
    return;
  }

  if (req.method === 'GET' && pathname === '/yc-pitch-deck-critic/openapi.json') {
    sendJson(res, 200, deckSpec);
    return;
  }

  if (req.method === 'POST' && pathname === '/linkedin-roaster/score') {
    try {
      sendJson(res, 200, await scoreLinkedinProfile(await readJson(req)));
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/yc-pitch-deck-critic/score') {
    try {
      sendJson(res, 200, scorePitchDeck(await readJson(req)));
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

createServer((req, res) => {
  route(req, res).catch((error) => {
    sendJson(res, 500, { error: error.message || 'internal error' });
  });
}).listen(PORT, () => {
  console.log(`Launch Scorecards listening on http://localhost:${PORT}`);
});
