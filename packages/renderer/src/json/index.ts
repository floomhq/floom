import { pickOutputShape, type OutputShape, type RenderProps } from '../contract/index.js';

export type UIElement =
  | { type: 'loading'; loading: true; inputs?: Record<string, unknown> }
  | { type: 'error'; message: string; code?: string; details?: unknown }
  | { type: 'text'; content: string }
  | { type: 'markdown'; content: string }
  | { type: 'code'; content: string; language?: string }
  | { type: 'table'; columns: string[]; rows: Record<string, unknown>[] }
  | { type: 'object'; data: unknown }
  | { type: 'image'; src: string; alt?: string }
  | { type: 'pdf'; src: string }
  | { type: 'audio'; src: string }
  | { type: 'stream'; data: unknown }
  | { type: 'unknown'; data: unknown };

function toRows(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.every((r) => r && typeof r === 'object' && !Array.isArray(r))
      ? (data as Record<string, unknown>[])
      : data.map((v, i) => ({ _index: i, value: v }));
  }
  if (data && typeof data === 'object') return [data as Record<string, unknown>];
  return [];
}

function inferColumns(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) for (const k of Object.keys(row)) seen.add(k);
  return Array.from(seen);
}

function coerceSrc(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (typeof obj.url === 'string') return obj.url;
    if (typeof obj.src === 'string') return obj.src;
  }
  return '';
}

/**
 * Transforms RenderProps into a pure, framework-agnostic JSON UI element.
 * This allows non-React clients (Vue, iOS, etc.) to predictably render outputs.
 */
export function emitJsonUI(props: RenderProps): UIElement {
  if (props.state === 'input-available' || props.loading) {
    return { type: 'loading', loading: true, inputs: props.inputs };
  }

  if (props.state === 'output-error') {
    return {
      type: 'error',
      message: props.error?.message || 'Unknown error',
      code: props.error?.code,
      details: props.error?.details,
    };
  }

  const shape: OutputShape = pickOutputShape(props.schema);
  const data = props.data;

  switch (shape) {
    case 'text':
      return { type: 'text', content: typeof data === 'string' ? data : JSON.stringify(data) };
    case 'markdown':
      return { type: 'markdown', content: typeof data === 'string' ? data : JSON.stringify(data) };
    case 'code':
      return { type: 'code', content: typeof data === 'string' ? data : JSON.stringify(data, null, 2) };
    case 'table':
      const rows = toRows(data);
      return { type: 'table', columns: inferColumns(rows), rows };
    case 'object':
      return { type: 'object', data };
    case 'image':
      return { type: 'image', src: coerceSrc(data) };
    case 'pdf':
      return { type: 'pdf', src: coerceSrc(data) };
    case 'audio':
      return { type: 'audio', src: coerceSrc(data) };
    case 'stream':
      return { type: 'stream', data };
    default:
      return { type: 'unknown', data };
  }
}
