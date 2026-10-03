import { describe, expect, it } from "vitest";
import { ensureMediaSchema } from "@/modules/media/store";
import type { RemoteStore } from "@/lib/db/remote";
describe("image schema startup", () => {
  it("coalesces concurrent image requests into one schema transaction", async () => {
    let queries=0, transactions=0;
    const store:RemoteStore={query:async()=>{queries++; await Promise.resolve(); return[];},transaction:async qs=>{transactions++; await Promise.resolve();return qs.map(()=>[]);}};
    await Promise.all([ensureMediaSchema(store),ensureMediaSchema(store),ensureMediaSchema(store)]);
    expect(transactions).toBe(1);expect(queries).toBe(0);
    await ensureMediaSchema(store);expect(transactions).toBe(1);
  });
});
