#!/usr/bin/env node
import { Command } from 'commander';
import { deployFromGithub } from '@floom/runtime';

const program = new Command();
program
  .name('floom')
  .description('Production layer for AI apps that do real work')
  .version('0.1.0');

program
  .command('deploy <repo>')
  .description('Deploy a public GitHub repo as a Floom app')
  .option('--branch <branch>', 'branch or tag', 'main')
  .action(async (repo: string, opts: { branch: string }) => {
    console.log(`Deploying ${repo}@${opts.branch}...`);
    const result = await deployFromGithub(repo, { branch: opts.branch });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('run <slug>')
  .description('Run a registered Floom app')
  .option('--input <key=value...>', 'inputs', [])
  .action(async (slug: string, opts: { input: string[] }) => {
    const inputs: Record<string, string> = {};
    for (const pair of opts.input || []) {
      const [k, v] = pair.split('=');
      if (k) inputs[k] = v ?? '';
    }
    console.log(`Running ${slug} with inputs:`, inputs);
    // Stub — real impl after runtime integration
  });

program.parseAsync();
