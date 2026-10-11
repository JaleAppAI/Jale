/**
 * capability-flags.ts -- the capability-flag settings a session can set, and a
 * way to set every one of them at once.
 *
 * Some policies and definers open a narrow door when a session setting holds
 * a particular value (a feature flag set to 'on', or the id of the row a
 * definer path is about to touch). Those settings are listed in the catalog
 * snapshot's guc_refs (infra/db/access/catalog-snapshot.json), next to the two
 * identity settings every request sets. A test that proves a login cannot
 * reach someone else's rows sets every flag first, each to the value that
 * would open its door for the victim, and checks that nothing opens.
 */
import * as path from 'node:path';
import type { ClientBase } from 'pg';
import { loadSnapshot } from '../../../../db/access/snapshot';

/** The settings that identify the caller; every request path sets them. */
export const IDENTITY_SETTINGS: readonly string[] = Object.freeze(['app.current_user_id', 'app.current_internal_user_id']);

/** Every capability flag the catalog references, sorted. */
export function capabilityFlags(): string[] {
  const snapshot = loadSnapshot(path.join(__dirname, '..', '..', '..', '..', 'db', 'access', 'catalog-snapshot.json'));
  return snapshot.guc_refs.filter((name) => !IDENTITY_SETTINGS.includes(name)).sort();
}

/** Who a flag would open a door for. */
export interface FlagVictim {
  /** The victim's users.id (an employer or a worker). */
  userId: string;
  /** The victim's Cognito sub. */
  sub: string;
  /** The victim's phone number, for the reconcile path. */
  phone?: string;
  /** A conversation id, for the onboarding bind path. */
  conversationId?: string;
}

/** The value that would open `flag`'s door for `victim`. */
export function flagValue(flag: string, victim: FlagVictim): string {
  if (/_conversation_id$/.test(flag)) return victim.conversationId ?? victim.userId;
  if (/_id$/.test(flag)) return victim.userId;
  if (/_sub$/.test(flag)) return victim.sub;
  if (/_phone$/.test(flag)) return victim.phone ?? '+15550000000';
  return 'on';
}

/** Sets every capability flag, transaction-locally, to the value that would open it for `victim`. */
export async function setEveryCapabilityFlag(client: ClientBase, victim: FlagVictim): Promise<void> {
  for (const flag of capabilityFlags()) {
    await client.query('SELECT pg_catalog.set_config($1, $2, true)', [flag, flagValue(flag, victim)]);
  }
}
