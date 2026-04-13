// Floom AI parser. Takes a natural-language prompt and an app's input schema,
// returns structured inputs via GPT-4o-mini. Falls back to an identity mapper
// (empty inputs) when OPENAI_API_KEY is missing.
import type { ActionSpec } from '../types.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PARSER_MODEL = process.env.PARSER_MODEL || 'gpt-4o-mini';

export interface ParseResult {
  inputs: Record<string, unknown>;
  confidence: number;
  reasoning: string;
}

const SYSTEM_PROMPT = `You are a tool input parser for the Floom runtime.

Given a user's natural-language request and a structured input schema for a
specific tool, return a JSON object with values mapped to the schema.

Rules:
- Use reasonable defaults for missing fields (e.g. "next week" -> today + 7
  days in ISO format).
- If a field cannot be confidently filled, return null for it.
- Strings stay strings, numbers stay numbers, booleans stay booleans.
- For enums, pick the closest matching option.
- Respond with ONLY a JSON object in this shape:
  { "inputs": { ... }, "confidence": 0.0 - 1.0, "reasoning": "..." }
- confidence reflects how well the prompt covers the required fields.
- reasoning is one short sentence explaining your mapping.`;

function schemaToPlain(action: ActionSpec): Array<Record<string, unknown>> {
  return action.inputs.map((inp) => ({
    name: inp.name,
    type: inp.type,
    label: inp.label,
    required: inp.required ?? false,
    ...(inp.description && { description: inp.description }),
    ...(inp.options && { options: inp.options }),
    ...(inp.placeholder && { placeholder: inp.placeholder }),
  }));
}

/**
 * Parse a natural-language prompt into structured inputs for the given action.
 */
export async function parsePrompt(
  prompt: string,
  appName: string,
  action: ActionSpec,
): Promise<ParseResult> {
  if (!OPENAI_API_KEY) {
    return {
      inputs: {},
      confidence: 0,
      reasoning: 'Parser unavailable (OPENAI_API_KEY not set)',
    };
  }

  const userMessage = [
    `Tool: ${appName}`,
    `Action: ${action.label}`,
    `Schema:`,
    JSON.stringify(schemaToPlain(action), null, 2),
    ``,
    `User request: ${prompt}`,
  ].join('\n');

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: PARSER_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI ${res.status}: ${body}`);
    }
    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = data.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response');
    }
    const parsed = JSON.parse(content) as Partial<ParseResult>;
    return {
      inputs: parsed.inputs && typeof parsed.inputs === 'object' ? parsed.inputs : {},
      confidence:
        typeof parsed.confidence === 'number'
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    };
  } catch (err) {
    const e = err as Error;
    console.error('[parser] failed:', e.message);
    return { inputs: {}, confidence: 0, reasoning: `Parser error: ${e.message}` };
  }
}
