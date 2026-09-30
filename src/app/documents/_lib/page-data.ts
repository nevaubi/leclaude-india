import "server-only";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { resolvePrincipal } from "@/lib/auth/principal";
import { accessibleMatterIds } from "@/lib/auth/scope";
import type { Principal } from "@/lib/auth/types";
import type { MatterChoice } from "@/modules/documents/components/sets-page";

/** The request's principal (null when it cannot be resolved; the client then gets 401s from the API and shows them). */
export async function pagePrincipal(path: string): Promise<Principal | null> {
  try {
    return await resolvePrincipal(new Request(`http://localhost${path}`, { headers: new Headers(await headers()) }));
  } catch {
    return null;
  }
}

/** Matters the principal may see, for the set's matter label and the "New set" matter picker. */
export function visibleMatters(principal: Principal | null): MatterChoice[] {
  if (!principal) return [];
  return accessibleMatterIds(principal)
    .map((id) => db().matters.get(id))
    .filter((m): m is NonNullable<typeof m> => !!m)
    .map((m) => ({ id: m.id, shortName: m.shortName || m.name, name: m.name }))
    .sort((a, b) => a.shortName.localeCompare(b.shortName));
}
