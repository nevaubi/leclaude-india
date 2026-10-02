/** Practice tool ids, in display order (client- and server-safe). */
export const TOOL_IDS = ["limitation", "cheque", "arbitration", "codes", "fees"] as const;
export type ToolId = (typeof TOOL_IDS)[number];

/** `?tool=` value → a known tool; anything else opens the first tool. */
export function toolFromParam(v: string | string[] | undefined): ToolId {
  const s = typeof v === "string" ? v : undefined;
  return (TOOL_IDS as readonly string[]).includes(s ?? "") ? (s as ToolId) : TOOL_IDS[0];
}
