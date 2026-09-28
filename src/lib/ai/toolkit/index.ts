import "server-only";
import type { Tool } from "openai/resources/responses/responses";
import type { ToolDef } from "../tools";
import { fetchUrlTool, webSearchTool } from "./web";
import { LEGAL_TOOLS } from "./legal";
import { INTERNAL_TOOLS } from "./internal";
import { indiaResearchTools, INDIA_TOOLS } from "./india";

export interface ResearchToolsetOptions {
  web?: boolean; // OpenAI built-in web search + fetch_url
  /**
   * Legal research tools. LeClaude India: the Indian set — judgment corpus, India Code, criminal-code correspondence,
   * citing references, and Indian Kanoon only when the firm token is configured (capability registry; fail closed).
   */
  legal?: boolean;
  /** US tools (CourtListener / eCFR / Federal Register / GovInfo). Off unless asked for; kept compiling for the US fork. */
  us?: boolean;
  internal?: boolean; // library + e-discovery + matter context
  webContextSize?: "low" | "medium" | "high";
}

/** Assemble the research tools for an agent run. */
export function researchToolset(opts: ResearchToolsetOptions = {}): { tools: ToolDef<never, unknown>[]; builtinTools: Tool[] } {
  const tools: ToolDef<never, unknown>[] = [];
  const builtinTools: Tool[] = [];
  if (opts.web !== false) { tools.push(fetchUrlTool as ToolDef<never, unknown>); builtinTools.push(webSearchTool({ contextSize: opts.webContextSize })); }
  if (opts.legal !== false) tools.push(...(indiaResearchTools() as ToolDef<never, unknown>[]));
  if (opts.us === true) tools.push(...(LEGAL_TOOLS as ToolDef<never, unknown>[]));
  if (opts.internal !== false) tools.push(...(INTERNAL_TOOLS as ToolDef<never, unknown>[]));
  return { tools, builtinTools };
}

export { fetchUrlTool, webSearchTool, LEGAL_TOOLS, INTERNAL_TOOLS, INDIA_TOOLS };
export * from "./legal";
export * from "./internal";
export {
  indiaCapabilities, indiaResearchTools, INDIA_CORE_TOOLS, INDIAN_KANOON_TOOLS, searchJudgmentsTool, readJudgmentTool, citingReferencesTool, searchStatutesIndiaTool, readSectionTool, mapCriminalSectionTool,
  indianKanoonSearchTool, indianKanoonDocTool, judgmentSource, statuteSource, isIndianLegalFetchHost, INDIA_FETCH_ALLOWLIST,
} from "./india";
export type { IndiaCapabilities } from "./india";
export { runTool, toProviderToolSpec, boundToolResult, shapeToolError, ToolExecutionError, isToolErrorResult, truncationMarker, TOOL_DEFAULT_TIMEOUT_MS, TOOL_DEFAULT_MAX_RESULT_CHARS } from "../tools";
export type { ToolRunResult, ToolErrorShape, ToolErrorCode, EvidenceProvenance, ToolTrace } from "../tools";
