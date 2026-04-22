import type { AppDetail, CreatorRun, PickResult, RunRecord } from './types';

const SAMPLE_STARTED_AT = '2026-04-22T00:00:00.000Z';
const SAMPLE_FINISHED_AT = '2026-04-22T00:00:01.240Z';

export function buildRendererPreviewPick(app: AppDetail): PickResult {
  return {
    slug: app.slug,
    name: app.name,
    description: app.description,
    category: app.category,
    icon: app.icon,
    confidence: 1,
  };
}

export function creatorRunToPreviewRun(
  app: AppDetail,
  run: CreatorRun,
): RunRecord {
  return {
    id: run.id,
    app_id: app.slug,
    thread_id: null,
    action: run.action,
    inputs: run.inputs,
    outputs: run.outputs,
    status: run.status,
    error: run.error,
    error_type: run.error_type,
    upstream_status: run.upstream_status ?? null,
    duration_ms: run.duration_ms,
    started_at: run.started_at,
    finished_at: run.finished_at,
    logs: '',
    app_slug: app.slug,
  };
}

export function buildRendererPreviewRun(
  app: AppDetail,
  outputShape: string,
): RunRecord {
  return {
    id: 'studio-renderer-preview',
    app_id: app.slug,
    thread_id: null,
    action: derivePreviewAction(app),
    inputs: { prompt: 'Preview sample' },
    outputs: buildRendererPreviewOutput(outputShape, app.name),
    status: 'success',
    error: null,
    error_type: null,
    upstream_status: null,
    duration_ms: 1240,
    started_at: SAMPLE_STARTED_AT,
    finished_at: SAMPLE_FINISHED_AT,
    logs: '',
    app_slug: app.slug,
  };
}

export function buildRendererPreviewOutput(
  outputShape: string,
  appName = 'Floom app',
): unknown {
  switch (outputShape) {
    case 'text':
      return `${appName} preview ready`;
    case 'markdown':
      return {
        markdown: `## ${appName} preview\n\nThis is a deterministic sample payload for the Studio renderer preview.`,
      };
    case 'code':
      return {
        code: [
          'const preview = {',
          '  status: "ok",',
          '  score: 91,',
          '  app: "floom",',
          '};',
          '',
          'console.log(preview);',
        ].join('\n'),
        language: 'javascript',
      };
    case 'table':
      return [
        { company: 'Acme', score: 91, fit: 'Strong ICP match' },
        { company: 'Globex', score: 76, fit: 'Mid-market potential' },
      ];
    case 'image':
      return {
        preview: [
          '<div style="padding:20px;border:1px solid #e5e5de;border-radius:14px;background:#fff;">',
          '<div style="font:600 13px system-ui;color:#2f312b;margin-bottom:10px;">Image preview sample</div>',
          '<div style="height:160px;border-radius:12px;background:linear-gradient(135deg,#f6efe2,#dfe8ff);display:flex;align-items:center;justify-content:center;color:#4b5563;font:500 13px system-ui;">Generated image output</div>',
          '</div>',
        ].join(''),
      };
    case 'pdf':
      return {
        preview: [
          '<div style="padding:18px;border:1px solid #e5e5de;border-radius:14px;background:#fff;">',
          '<div style="font:600 13px system-ui;color:#2f312b;margin-bottom:12px;">Quarterly plan.pdf</div>',
          '<div style="border:1px solid #ecece6;border-radius:10px;padding:18px;background:#fafaf8;">',
          '<h2 style="margin:0 0 8px;font:600 18px system-ui;color:#1f2937;">Renderer preview sample</h2>',
          '<p style="margin:0;font:400 13px/1.5 system-ui;color:#4b5563;">This mirrors the inline preview card a user would see before downloading the final PDF.</p>',
          '</div>',
          '</div>',
        ].join(''),
        filename: 'quarterly-plan.pdf',
      };
    case 'audio':
      return {
        preview: [
          '<div style="padding:18px;border:1px solid #e5e5de;border-radius:14px;background:#fff;">',
          '<div style="font:600 13px system-ui;color:#2f312b;margin-bottom:12px;">Audio preview sample</div>',
          '<div style="display:flex;align-items:center;gap:12px;">',
          '<div style="width:44px;height:44px;border-radius:999px;background:#111827;color:#fff;display:flex;align-items:center;justify-content:center;font:700 12px system-ui;">▶</div>',
          '<div style="flex:1;height:8px;border-radius:999px;background:#e5e7eb;overflow:hidden;"><div style="width:42%;height:100%;background:#111827;"></div></div>',
          '<div style="font:500 12px system-ui;color:#6b7280;">0:18</div>',
          '</div>',
          '</div>',
        ].join(''),
      };
    case 'object':
    default:
      return {
        headline: `${appName} preview`,
        status: 'ready',
        score: 91,
        message: 'Deterministic sample output for renderer iteration.',
      };
  }
}

function derivePreviewAction(app: AppDetail): string {
  const actions = Object.keys(app.manifest.actions || {});
  const primary = app.manifest.primary_action;
  if (primary && actions.includes(primary)) return primary;
  return actions[0] || 'run';
}
