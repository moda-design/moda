/**
 * Credential resolution (cli-repo-plan §2.7): `MODA_API_KEY` env (headless/CI; also satisfies
 * MODA_SERVICE_CREDENTIAL semantics for the prototype) > keychain > fallback file. No verb ever
 * prints a credential; output passes through `output/redact.ts`.
 */
import { CliError } from '../cliError.ts';
import { readAccountIndex } from '../config/state.ts';
import { keychainAccount, selectKeychainBackend, type KeychainBackend, type StoredCredential } from './keychain.ts';

export type CredentialSource = 'env' | 'keychain' | 'file' | 'none';

export interface ResolvedCredential {
  key: string;
  source: CredentialSource;
  org?: string;
  scopes?: string[];
  account?: string;
  backendName?: KeychainBackend['name'];
}

export interface CredentialQuery {
  apiBase: string;
  /** Org from the effective context, when set. */
  org?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the credential for (apiBase, org). When org is unset, a single stored account for the
 * host is used; multiple accounts require `moda org use`.
 */
export async function resolveCredential(query: CredentialQuery): Promise<ResolvedCredential | undefined> {
  const env = query.env ?? process.env;
  const envKey = env.MODA_API_KEY ?? env.MODA_SERVICE_CREDENTIAL;
  if (envKey !== undefined && envKey !== '') {
    return { key: envKey, source: 'env' };
  }

  const backend = await selectKeychainBackend(env);
  const host = new URL(query.apiBase).host;

  const account = await findAccount(query.org, host, env);
  if (account === undefined) return undefined;

  const stored = await backend.read(account);
  if (stored === undefined) return undefined;
  return {
    key: stored.key,
    source: backend.name === 'file' ? 'file' : 'keychain',
    org: stored.org,
    scopes: stored.scopes,
    account,
    backendName: backend.name,
  };
}

async function findAccount(
  org: string | undefined,
  host: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (org !== undefined) return `${host}/${org}`;
  const forHost = readAccountIndex(env).filter((e) => e.host === host);
  if (forHost.length === 1) return `${forHost[0]!.host}/${forHost[0]!.org}`;
  if (forHost.length > 1) {
    throw CliError.auth(
      `Multiple credentials stored for ${host}; no org selected.`,
      'Run `moda org use <org>` or pass --org.',
    );
  }
  return undefined;
}

/** Resolve-or-throw variant used by every authenticated verb. */
export async function requireCredential(query: CredentialQuery): Promise<ResolvedCredential> {
  const resolved = await resolveCredential(query);
  if (resolved === undefined) {
    throw CliError.auth(
      'No credentials found.',
      'Run `moda auth login`, or set MODA_API_KEY for headless use.',
    );
  }
  return resolved;
}

export async function storeCredential(
  apiBase: string,
  secret: StoredCredential,
  env: NodeJS.ProcessEnv = process.env,
): Promise<KeychainBackend['name']> {
  const backend = await selectKeychainBackend(env);
  await backend.store(keychainAccount(apiBase, secret.org), secret);
  return backend.name;
}

export async function deleteCredential(
  apiBase: string,
  org: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const backend = await selectKeychainBackend(env);
  return backend.delete(keychainAccount(apiBase, org));
}
