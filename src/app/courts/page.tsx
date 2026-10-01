import type { Metadata } from "next";
import { cityById, findCity } from "@/lib/india/forums";
import { CourtsBrowser } from "@/modules/courts/components/courts-page";

export const metadata: Metadata = { title: "Courts & forums" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** /courts?city=<id> — courts, tribunals and local law by city (static sourced data; local law resolved via the API). */
export default async function CourtsPage({ searchParams }: Props) {
  const sp = await searchParams;
  const raw = typeof sp.city === "string" ? sp.city.trim() : "";
  // An id, name or alias resolves exactly; anything else is reported, never mapped to the nearest city.
  const city = cityById(raw) ?? findCity(raw);
  return <CourtsBrowser initialCity={city?.id ?? null} unknownCity={raw && !city ? raw : null} />;
}
