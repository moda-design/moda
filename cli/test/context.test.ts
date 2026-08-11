import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveContext, writeRepoContextKey } from '../src/config/context.ts';

function scaffold(): { home: string; repo: string; nested: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), 'moda-ctx-'));
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  const nested = join(repo, 'a', 'b');
  mkdirSync(join(home, 'moda'), { recursive: true });
  mkdirSync(nested, { recursive: true });
  const env: NodeJS.ProcessEnv = { MODA_CONFIG_DIR: join(home, 'moda') };
  return { home, repo, nested, env };
}

describe('context precedence (flag > env > context.local > context > config)', () => {
  test('all four layers plus env and flag, resolved from a nested cwd', () => {
    const { home, repo, nested, env } = scaffold();
    writeFileSync(join(home, 'moda', 'config.toml'), 'api_base = "https://cfg.test"\n[context]\norg = "org_config"\n');
    mkdirSync(join(repo, '.moda'), { recursive: true });
    writeFileSync(join(repo, '.moda', 'context.json'), JSON.stringify({ org: 'org_committed', brand: 'bk_committed' }));
    writeFileSync(join(repo, '.moda', 'context.local.json'), JSON.stringify({ org: 'org_local' }));

    // config only
    const cfgOnly = resolveContext({}, env, home);
    expect(cfgOnly.org).toEqual({ value: 'org_config', source: 'config' });
    expect(cfgOnly.apiBase).toEqual({ value: 'https://cfg.test', source: 'config' });

    // committed beats config; local beats committed — resolved by walking up from nested cwd
    const inRepo = resolveContext({}, env, nested);
    expect(inRepo.org).toEqual({ value: 'org_local', source: 'context.local' });
    expect(inRepo.brand).toEqual({ value: 'bk_committed', source: 'context' });
    expect(inRepo.repoRoot).toBe(repo);

    // env beats files
    const withEnv = resolveContext({}, { ...env, MODA_ORG: 'org_env', MODA_API_BASE: 'https://env.test' }, nested);
    expect(withEnv.org).toEqual({ value: 'org_env', source: 'env' });
    expect(withEnv.apiBase).toEqual({ value: 'https://env.test', source: 'env' });

    // flag beats env
    const withFlag = resolveContext(
      { org: 'org_flag', apiBase: 'https://flag.test' },
      { ...env, MODA_ORG: 'org_env' },
      nested,
    );
    expect(withFlag.org).toEqual({ value: 'org_flag', source: 'flag' });
    expect(withFlag.apiBase).toEqual({ value: 'https://flag.test', source: 'flag' });
  });

  test('default api_base when nothing configures it', () => {
    const { nested, env } = scaffold();
    const ctx = resolveContext({}, env, nested);
    expect(ctx.apiBase).toEqual({ value: 'https://api.moda.app', source: 'default' });
  });

  test('context set --local writes the local file and appends .gitignore once', () => {
    const { repo, env } = scaffold();
    mkdirSync(join(repo, '.moda'), { recursive: true });
    writeFileSync(join(repo, '.moda', 'context.json'), '{}');
    void env;
    writeRepoContextKey('brand', 'bk_x', { local: true }, repo);
    writeRepoContextKey('canvas', 'cvs_y', { local: true }, repo);
    const gitignore = readFileSync(join(repo, '.gitignore'), 'utf8');
    expect(gitignore.split('\n').filter((l) => l === '.moda/context.local.json')).toHaveLength(1);
    const local = JSON.parse(readFileSync(join(repo, '.moda', 'context.local.json'), 'utf8')) as Record<string, string>;
    expect(local.brand).toBe('bk_x');
    expect(local.canvas).toBe('cvs_y');
  });
});
