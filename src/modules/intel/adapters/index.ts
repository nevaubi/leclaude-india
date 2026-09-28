import "server-only";
import type { IntelAdapterId, IntelAdapterInfo, IntelProviderStatus } from "../types";
import type { IntelAdapter } from "./types";
import { courtListenerOpinionsAdapter } from "./courtlistener-opinions";
import { courtListenerDocketsAdapter } from "./courtlistener-dockets";
import { courtListenerJudgesAdapter } from "./courtlistener-judges";
import { ecfrAdapter } from "./ecfr";
import { federalRegisterAdapter } from "./federal-register";
import { govInfoAdapter } from "./govinfo";
import { openFdaRecallsAdapter } from "./openfda-recalls";
import { jpmlMdlsAdapter } from "./jpml-mdls";
import { courtRulesAdapter } from "./court-rules";
import { newsAdapter } from "./news";
import { localCorpusAdapter } from "./local-corpus";
import { webListAdapter } from "./web-list";
import { sciOpenDataAdapter } from "./sci-open-data";
import { hcOpenDataAdapter } from "./hc-open-data";
import { indianKanoonAdapter } from "./indian-kanoon";
import { indiaCodeAdapter } from "./india-code";
import { manupatraAdapter, sccOnlineAdapter } from "./licensed";

type AnyAdapter = IntelAdapter<Record<string, unknown>>;

const BUILT_IN: AnyAdapter[] = [
  // LeClaude India sources (defaults for this fork).
  sciOpenDataAdapter,
  hcOpenDataAdapter,
  indianKanoonAdapter,
  indiaCodeAdapter,
  sccOnlineAdapter,
  manupatraAdapter,
  // US sources from the upstream platform: kept compiling and registered, but out of the default source catalog.
  courtListenerOpinionsAdapter,
  courtListenerDocketsAdapter,
  courtListenerJudgesAdapter,
  ecfrAdapter,
  federalRegisterAdapter,
  govInfoAdapter,
  openFdaRecallsAdapter,
  jpmlMdlsAdapter,
  courtRulesAdapter,
  newsAdapter,
  localCorpusAdapter,
  webListAdapter,
] as unknown as AnyAdapter[];

type G = typeof globalThis & { __leclaudeIntelAdapters?: Map<string, AnyAdapter> };

function registry(): Map<string, AnyAdapter> {
  const g = globalThis as G;
  if (!g.__leclaudeIntelAdapters) g.__leclaudeIntelAdapters = new Map(BUILT_IN.map((a) => [a.id, a]));
  return g.__leclaudeIntelAdapters;
}

export const ADAPTER_IDS: IntelAdapterId[] = BUILT_IN.map((a) => a.id);

export function getAdapter(id: string): AnyAdapter | null {
  return registry().get(id) ?? null;
}

export function listAdapters(): AnyAdapter[] {
  return Array.from(registry().values());
}

/** Register or replace an adapter (tests, plugins). */
export function registerAdapter(adapter: IntelAdapter<never> | AnyAdapter) {
  registry().set(adapter.id, adapter as AnyAdapter);
}

export function adapterInfos(statuses: IntelProviderStatus[]): IntelAdapterInfo[] {
  const ok = new Map(statuses.map((s) => [s.id, s.configured]));
  return listAdapters().map((a) => ({ id: a.id, name: a.name, description: a.description, kinds: a.kinds, requires: a.requires, configured: a.requires.every((r) => ok.get(r) !== false), defaults: a.defaults }));
}

export { defineAdapter, errorFrom, emptyResult, BudgetExhausted } from "./types";
export type { IntelAdapter, AdapterContext, AdapterLogger, IngestInput, ConfigSchema } from "./types";
