import { LawHub } from "@/components/corpus/law-hub";

/** Practice tools sit in the Law area: the shared header with the area tabs and the hub search. */
export default function Layout({ children }: { children: React.ReactNode }) {
  return <LawHub>{children}</LawHub>;
}
