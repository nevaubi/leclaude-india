/**
 * Visual library contract (shared by client and server; no server imports).
 *
 * Images that make the Indian law pages recognisable: photographs of court buildings and city landmarks from
 * Wikimedia Commons (free licences, attribution kept), and logos of regulators that publish rules (RBI, SEBI, ...)
 * taken from their official websites. Every image is stored in our media store (`media_assets`, served at
 * /api/media/<sha256>), validated by its bytes, and passed through a vision check before it is shown.
 *
 * Policy (enforced server-side, never by the UI):
 * - No image that shows the State Emblem of India (the Lion Capital of Ashoka) is shown: its use is restricted by the
 *   State Emblem of India (Prohibition of Improper Use) Act, 2005. The vision check flags it and such images are hidden.
 * - Photographs must carry a free licence (CC0, PD, CC BY, CC BY-SA) with author and licence recorded; anything else is
 *   skipped. The credit line is shown wherever the image is shown.
 * - Logos are shown only beside the publisher they identify (nominative use), never as decoration.
 *
 * API:
 *   GET /api/india/visuals → VisualsResponse (public, cached; empty maps when the store is not configured)
 *   POST /api/india/enrichment/run { target: "visuals", kinds?: VisualKind[], keys?: string[] } → enrichment report
 */

export type VisualKind = "court_building" | "city" | "regulator_logo";

export interface VisualCredit {
  /** Author as given by the source ("Jane Doe", "Government of India"). */
  author: string | null;
  /** Short licence name ("CC BY-SA 4.0", "Public domain") or, for logos, "Logo of <publisher>". */
  license: string;
  licenseUrl: string | null;
  /** Page the image came from (Commons file page or the publisher's site). */
  sourceUrl: string;
  sourceName: string; // "Wikimedia Commons", "Reserve Bank of India"
}

export interface Visual {
  kind: VisualKind;
  /** Registry key: court id ("sci", "hc-bombay"), city id ("mumbai"), or regulator key ("RBI", "SEBI"). */
  key: string;
  /** Our media URL (/api/media/<sha256>). */
  url: string;
  width: number | null;
  height: number | null;
  /** Alt text: what the image shows ("Bombay High Court building, Fort, Mumbai"). */
  alt: string;
  credit: VisualCredit;
  /** Dominant colour as #rrggbb, for placeholders while the image loads; null when unknown. */
  dominant: string | null;
}

export interface VisualsResponse {
  courts: Record<string, Visual>;
  cities: Record<string, Visual>;
  regulators: Record<string, Visual>;
  updatedAt: string | null;
}

/** The credit line shown under or beside an image. */
export function creditLine(v: Pick<Visual, "credit">): string {
  const c = v.credit;
  return [c.author, c.license, c.sourceName].filter(Boolean).join(" · ");
}
