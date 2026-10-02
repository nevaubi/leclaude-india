import { LawHub } from "@/components/corpus/law-hub";

/** The Law area (Case law · Statutes · Courts · Judges): shared header with the area tabs and the hub search. */
export default function Layout({ children }: { children: React.ReactNode }) {
  return <LawHub>{children}</LawHub>;
}
