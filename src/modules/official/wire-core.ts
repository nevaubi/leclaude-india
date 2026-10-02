import "server-only";
import { listOfficialDocuments } from "./list";
import { readOfficialDocument } from "./read";
import { searchOfficial } from "./search";
import { registerOfficialImpl } from "./service";
import { officialStatus } from "./status";

/**
 * Register the official-core implementations behind the service facade (./service.ts): search, read, list, status.
 * Idempotent. Called once at integration (from the facade's wiring module); all four are function declarations, so
 * calling this from the bottom of service.ts is safe even though these modules import service.ts for its error class.
 */
export function wireOfficialCore(): void {
  registerOfficialImpl({
    searchOfficial: (q, store) => searchOfficial(q, store),
    readOfficialDocument: (id, opts, store) => readOfficialDocument(id, opts, store),
    listOfficialDocuments: (q, store) => listOfficialDocuments(q, store),
    officialStatus: (store) => officialStatus(store),
  });
}
