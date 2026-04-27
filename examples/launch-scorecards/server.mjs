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
// Pure Node.js, no external dependencies, no API keys.
//
// Run: node examples/launch-scorecards/server.mjs
// Env: PORT=4120 (default)

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 4120);
const MAX_BODY_BYTES = 256 * 1024;

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
    'Score a founder or operator LinkedIn profile for positioning clarity, specificity, credibility, and conversion intent.',
  path: '/linkedin-roaster/score',
  operationId: 'scoreLinkedinProfile',
  required: ['profile_text'],
  inputProperties: {
    profile_text: {
      type: 'string',
      description: 'Pasted LinkedIn profile text, including headline, About section, experience, or featured summary.',
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
    'Score an early-stage pitch deck narrative for YC-style clarity, urgency, insight, market, traction, and ask.',
  path: '/yc-pitch-deck-critic/score',
  operationId: 'scorePitchDeck',
  required: ['deck'],
  inputProperties: {
    deck: {
      type: 'string',
      description:
        'Pitch deck text, slide outline, or pasted narrative. Slide headings improve the diagnosis.',
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

function scoreLinkedinProfile(body) {
  const profile = String(body.profile_text || '').trim();
  if (!profile) throw new Error('profile_text is required');

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

function scorePitchDeck(body) {
  const deck = String(body.deck || '').trim();
  if (!deck) throw new Error('deck is required');

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
      sendJson(res, 200, scoreLinkedinProfile(await readJson(req)));
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/yc-pitch-deck-critic/score') {
    try {
      sendJson(res, 200, scorePitchDeck(await readJson(req)));
    } catch (error) {
      sendJson(res, 400, { error: error.message });
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
