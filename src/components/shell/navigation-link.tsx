"use client";
import * as React from "react";
import NextLink, { useLinkStatus } from "next/link";

function NavigationFeedback() {
  const { pending } = useLinkStatus();
  return pending ? <span role="status" aria-label="Loading page" className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5 animate-pulse bg-primary motion-reduce:animate-none" /> : null;
}

/** Keep cheap shell prefetching; load full destinations only on hover/focus intent. */
export const NavigationLink = React.forwardRef<HTMLAnchorElement, React.ComponentPropsWithoutRef<typeof NextLink>>(function NavigationLink({ children, prefetch, onMouseEnter, onMouseLeave, onFocus, ...props }, ref) {
  const [intent, setIntent] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  const prepare = () => {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (prefetch === false || connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType ?? "")) return;
    setIntent(true);
  };
  React.useEffect(() => { setIntent(false); return cancel; }, [props.href]);
  return <NextLink {...props} ref={ref} prefetch={prefetch ?? (intent ? true : null)}
    onMouseEnter={e => { onMouseEnter?.(e); if (!e.defaultPrevented) { cancel(); timer.current = setTimeout(prepare, 80); } }}
    onMouseLeave={e => { cancel(); onMouseLeave?.(e); }}
    onFocus={e => { onFocus?.(e); if (!e.defaultPrevented) prepare(); }}>
    {children}<NavigationFeedback />
  </NextLink>;
});
