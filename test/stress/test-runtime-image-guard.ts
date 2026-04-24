#!/usr/bin/env node
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const testDir = join(__dirname, '..', '..', '.test-runtime-image-guard');

rmSync(testDir, { recursive: true, force: true });
mkdirSync(join(testDir, 'apps'), { recursive: true });
process.env.DATA_DIR = testDir;

async function main(): Promise<void> {
  const { db, DEFAULT_WORKSPACE_ID } = await import('../../apps/server/src/db.ts');
  const { ensureRuntimeImageReady } = await import(
    '../../apps/server/src/services/runner.ts'
  );

  let passed = 0;
  let failed = 0;

  function log(label: string, ok: boolean, detail?: string): void {
    if (ok) {
      passed++;
      console.log(`  PASS  ${label}`);
    } else {
      failed++;
      console.log(`  FAIL  ${label}${detail ? ' -- ' + detail : ''}`);
    }
  }

  function insertApp(args: {
    id: string;
    slug: string;
    dockerImage: string;
    codePath?: string;
  }) {
    db.prepare(
      `INSERT INTO apps
        (id, slug, name, description, manifest, status, docker_image, code_path,
         category, author, app_type, workspace_id, publish_status)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL, 'floom', 'docker', ?, 'published')`,
    ).run(
      args.id,
      args.slug,
      args.slug,
      `${args.slug} desc`,
      JSON.stringify({
        name: args.slug,
        description: args.slug,
        runtime: 'python',
        python_dependencies: [],
        node_dependencies: {},
        secrets_needed: [],
        manifest_version: '2.0',
        actions: {
          run: {
            label: 'Run',
            inputs: [],
            outputs: [],
          },
        },
      }),
      args.dockerImage,
      args.codePath ?? `/tmp/${args.slug}`,
      DEFAULT_WORKSPACE_ID,
    );
    return db.prepare('SELECT * FROM apps WHERE id = ?').get(args.id) as {
      id: string;
      slug: string;
      status: string;
      docker_image: string;
      code_path: string;
    };
  }

  console.log('runtime image guard');

  {
    const app = insertApp({
      id: 'app-happy',
      slug: 'happy-demo',
      dockerImage: 'floom-demo-happy:ctx-present',
    });
    let resolveCalls = 0;
    const result = await ensureRuntimeImageReady(app as never, {
      docker: {} as never,
      imageExists: async (_docker, tag) => tag === 'floom-demo-happy:ctx-present',
      resolveDemoImageTag: async () => {
        resolveCalls++;
        return { status: 'missing' };
      },
      rewriteAppImage: () => {
        throw new Error('rewriteAppImage must stay unused on happy path');
      },
      markAppInactive: () => {
        throw new Error('markAppInactive must stay unused on happy path');
      },
      fatalLog: () => {
        throw new Error('fatalLog must stay unused on happy path');
      },
    });
    const row = db.prepare('SELECT docker_image, status FROM apps WHERE id = ?').get(app.id) as {
      docker_image: string;
      status: string;
    };
    log('happy path returns ready', result.kind === 'ready');
    log(
      'happy path keeps same image',
      result.kind === 'ready' && result.image === app.docker_image,
    );
    log('happy path skips rebuild helper', resolveCalls === 0, `calls=${resolveCalls}`);
    log('happy path leaves app active', row.status === 'active', `status=${row.status}`);
  }

  {
    const app = insertApp({
      id: 'app-rebuild',
      slug: 'lead-scorer',
      dockerImage: 'floom-demo-lead-scorer:ctx-missing',
      codePath: 'reused:launch-demo:lead-scorer:ctx-missing',
    });
    const result = await ensureRuntimeImageReady(app as never, {
      docker: {} as never,
      imageExists: async () => false,
      resolveDemoImageTag: async () => ({
        status: 'ready',
        imageTag: 'floom-demo-lead-scorer:ctx-rebuilt',
      }),
      rewriteAppImage: (targetApp, imageTag) => {
        db.prepare(
          `UPDATE apps SET docker_image = ?, updated_at = datetime('now') WHERE id = ?`,
        ).run(imageTag, targetApp.id);
        targetApp.docker_image = imageTag;
      },
      markAppInactive: () => {
        throw new Error('markAppInactive must stay unused on rebuild success');
      },
      fatalLog: () => {
        throw new Error('fatalLog must stay unused on rebuild success');
      },
    });
    const row = db.prepare('SELECT docker_image, status FROM apps WHERE id = ?').get(app.id) as {
      docker_image: string;
      status: string;
    };
    log('rebuild success returns ready', result.kind === 'ready');
    log(
      'rebuild success rewrites docker_image',
      row.docker_image === 'floom-demo-lead-scorer:ctx-rebuilt',
      `docker_image=${row.docker_image}`,
    );
    log('rebuild success keeps app active', row.status === 'active', `status=${row.status}`);
  }

  {
    const app = insertApp({
      id: 'app-previous',
      slug: 'lead-scorer-previous',
      dockerImage: 'floom-demo-lead-scorer:ctx-new',
      codePath: 'reused:launch-demo:lead-scorer:ctx-new',
    });
    const result = await ensureRuntimeImageReady(app as never, {
      docker: {} as never,
      imageExists: async () => false,
      resolveDemoImageTag: async () => ({
        status: 'keep_previous',
        imageTag: 'floom-demo-lead-scorer:ctx-prev',
      }),
      rewriteAppImage: (targetApp, imageTag) => {
        db.prepare(
          `UPDATE apps SET docker_image = ?, updated_at = datetime('now') WHERE id = ?`,
        ).run(imageTag, targetApp.id);
        targetApp.docker_image = imageTag;
      },
      markAppInactive: () => {
        throw new Error('markAppInactive must stay unused on keep_previous');
      },
      fatalLog: () => {
        throw new Error('fatalLog must stay unused on keep_previous');
      },
    });
    const row = db.prepare('SELECT docker_image, status FROM apps WHERE id = ?').get(app.id) as {
      docker_image: string;
      status: string;
    };
    log('keep_previous returns ready', result.kind === 'ready');
    log(
      'keep_previous rewrites docker_image to prior tag',
      row.docker_image === 'floom-demo-lead-scorer:ctx-prev',
      `docker_image=${row.docker_image}`,
    );
    log('keep_previous keeps app active', row.status === 'active', `status=${row.status}`);
  }

  {
    const app = insertApp({
      id: 'app-missing',
      slug: 'lead-scorer-missing',
      dockerImage: 'floom-demo-lead-scorer:ctx-gone',
      codePath: 'reused:launch-demo:lead-scorer:ctx-gone',
    });
    let fatalLine = '';
    const result = await ensureRuntimeImageReady(app as never, {
      docker: {} as never,
      imageExists: async () => false,
      resolveDemoImageTag: async () => ({ status: 'missing' }),
      rewriteAppImage: () => {
        throw new Error('rewriteAppImage must stay unused on full miss');
      },
      markAppInactive: (targetApp) => {
        db.prepare(
          `UPDATE apps SET status = 'inactive', updated_at = datetime('now') WHERE id = ?`,
        ).run(targetApp.id);
        targetApp.status = 'inactive';
      },
      fatalLog: (line) => {
        fatalLine = line;
      },
    });
    const row = db.prepare('SELECT docker_image, status FROM apps WHERE id = ?').get(app.id) as {
      docker_image: string;
      status: string;
    };
    log('full miss returns app_unavailable', result.kind === 'app_unavailable');
    log(
      'full miss exposes app_image_missing payload',
      result.kind === 'app_unavailable' && result.payload.error_type === 'app_image_missing',
      result.kind === 'app_unavailable' ? result.payload.error_type : `kind=${result.kind}`,
    );
    log('full miss marks app inactive', row.status === 'inactive', `status=${row.status}`);
    log(
      'full miss preserves missing docker_image tag for diagnosis',
      row.docker_image === 'floom-demo-lead-scorer:ctx-gone',
      `docker_image=${row.docker_image}`,
    );
    log('full miss emits FATAL log line', fatalLine.includes('FATAL app_image_missing'), fatalLine);
  }

  db.close();
  rmSync(testDir, { recursive: true, force: true });

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
