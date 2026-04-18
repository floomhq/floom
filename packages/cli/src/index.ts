#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();
program
  .name('floom')
  .description('Production layer for AI apps that do real work')
  .version('0.1.0');

program
  .command('deploy <repo>')
  .description('Deploy a public GitHub repo as a Floom app')
  .option('--branch <branch>', 'branch or tag', 'main')
  .action((repo: string, opts: { branch: string }) => {
    console.error(
      `floom deploy is not wired in the public beta. Use the web UI at `
        + `floom.dev/build or call POST /api/deploy-github directly.\n`
        + `(repo=${repo} branch=${opts.branch})`,
    );
    process.exit(1);
  });

program
  .command('run <slug>')
  .description('Run a registered Floom app')
  .option('--input <key=value...>', 'inputs', [])
  .action((slug: string) => {
    console.error(
      `floom run is not wired in the public beta. Invoke the HTTP endpoint `
        + `at POST /api/${slug}/run or use the MCP server at /mcp/app/${slug}.`,
    );
    process.exit(1);
  });

program.parseAsync();
