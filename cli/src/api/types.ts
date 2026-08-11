/**
 * Response-shape helpers. Tolerant by design: the server evolves additively and the CLI must
 * ignore unknown keys; these helpers pull the fields the CLI relies on and pass bodies through
 * otherwise. (Later: generated from the published Canvas Actions schemas.)
 */

export type JsonObject = Record<string, unknown>;

export function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

export function str(obj: JsonObject, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

export function num(obj: JsonObject, key: string): number | undefined {
  const v = obj[key];
  return typeof v === 'number' ? v : undefined;
}

export function strArray(obj: JsonObject, key: string): string[] {
  const v = obj[key];
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

/**
 * GET /v1/whoami shape (backend/app/api/public/routers/canvas_actions.py::whoami):
 * `{user: {id, email}, team: {id, uuid, name}, organization: {id, uuid} | null,
 *   plan, scopes, api_key_id, entitlements}`.
 */
export interface Whoami {
  userId?: string;
  email?: string;
  orgId?: string;
  orgName?: string;
  plan?: string;
  scopes: string[];
  raw: JsonObject;
}

export function parseWhoami(body: unknown): Whoami {
  const root = asObject(body);
  const user = asObject(root.user);
  const team = asObject(root.team);
  const organization = asObject(root.organization);
  return {
    userId: str(user, 'id') ?? str(root, 'user_id'),
    email: str(user, 'email') ?? str(root, 'email'),
    orgId: str(organization, 'id') ?? str(team, 'id') ?? str(root, 'org_id'),
    // The org record carries no display name on this endpoint; the team name is the human label.
    orgName: str(team, 'name') ?? str(root, 'org_name'),
    plan: str(root, 'plan'),
    scopes: strArray(root, 'scopes'),
    raw: root,
  };
}

/** Normalize list responses that may arrive as an array, `{data: []}`, or `{<key>: []}`. */
export function listItems(body: unknown, key: string): JsonObject[] {
  if (Array.isArray(body)) return body.map(asObject);
  const root = asObject(body);
  const keyed = root[key];
  if (Array.isArray(keyed)) return keyed.map(asObject);
  const data = root.data;
  if (Array.isArray(data)) return data.map(asObject);
  return [];
}
