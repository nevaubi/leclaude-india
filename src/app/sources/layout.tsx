import { LawHub } from "@/components/corpus/law-hub";

/** The official sources library sits in the Law area: the shared header with the area tabs and the hub search. */
export default function Layout({ children }: { children: React.ReactNode }) {
  return <LawHub>{children}</LawHub>;
}
