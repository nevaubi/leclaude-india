/**
 * Indian law tool routing for agents that hold the Indian toolkit (chat, the legal personas). Client-safe, byte-stable
 * text (cacheable prefix). The research engine's lanes have their own routing block (engine/prompts.ts) because their
 * tools wrap these.
 *
 * Tool families and the ids each accepts (an id is passed only to the family that returned it):
 * - full text:   search_judgment_text → read_judgment_text (sc:… / hc:… ids, neutral citations, CNR@YYYY-MM-DD)
 * - metadata:    search_judgment_index (identifies a judgment; same ids; read with read_judgment_text when text: full)
 * - statutes:    search_law / list_law_instruments → read_law_section (act_id + section)
 * - local store: search_judgments → read_judgment (ijdg_…); search_statutes → read_section (<enactmentId>:<section>)
 */

/** Names of the Indian law tools the routing block refers to (tests pin that each exists in the toolkit). */
export const ROUTED_INDIA_TOOLS = [
  "search_law", "read_law_section", "list_law_instruments", "search_judgment_text", "read_judgment_text", "search_judgment_index",
  "citing_references", "citator_check", "get_forum_info", "map_criminal_section", "search_judgments", "read_judgment", "search_statutes", "read_section",
] as const;

export const INDIAN_LAW_TOOL_ROUTING = `Indian law tool routing (choose by the job; chain search → read → cite):
- Statute question (what a provision says, its ingredients, punishment, status): search_law → read_law_section (act_id + section). Know the Act but not the section: list_law_instruments → read_law_section. Without search_law: search_statutes → read_section.
- Doctrine, holding, test or how courts applied a provision: search_judgment_text → read_judgment_text (the result's id, with the page of the passage) → cite that page.
- Identify a case by neutral citation, CNR, case number, party or judge: search_judgment_index. If the result says text: full, read it with read_judgment_text (same id); otherwise it is metadata only — cite the record, never a holding.
- Later judgments citing a judgment: citing_references with its sc:/hc: id or neutral citation; the results MENTION the citation (text match), they are not treatment until you read the passage. citator_check (same ids) adds exact-citation matches with text cues ("overruled", "distinguished") and a negative-signal summary; a cue is not a verified treatment and nothing establishes good law.
- Courts, local Acts (rent, stamp, court fees) and filing links for a city or forum: get_forum_info.
- IPC↔BNS, CrPC↔BNSS, Evidence Act↔BSA: map_criminal_section; report its status (requires_review, split, unmapped) as returned.
- search_judgments / read_judgment are the local store (ijdg_… ids): judgments ingested into this workspace or linked to a matter.
- Pass an id only to the tool family that returned it (ijdg_… → read_judgment; sc:/hc:/neutral citation/CNR@date → read_judgment_text; act_id → read_law_section). Never build an id from memory.
- Never cite a judgment or provision you did not read with a read tool in this conversation; a search hit, snippet or metadata record supports only what it literally shows. If nothing is found, say the sources searched do not establish it.
Citation format: judgments "Title, 2024 INSC 735, p. 6" (add the reporter after " : " when the tool gives one); High Court text without a neutral citation "Title, CNR KAHC010219082014, decided 9 September 2014, p. 6"; statutes "Section 303, Bharatiya Nyaya Sanhita, 2023" (the citation read_law_section returns).`;

/** The routing block when any of `toolNames` is an Indian law tool ("" otherwise). */
export function indiaRoutingFor(toolNames: Iterable<string>): string {
  const names = new Set(toolNames);
  return ROUTED_INDIA_TOOLS.some((t) => names.has(t)) ? INDIAN_LAW_TOOL_ROUTING : "";
}
