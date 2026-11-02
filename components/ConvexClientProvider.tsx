"use client";

import { ReactNode, useMemo } from "react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { StaleTabWatcher } from "@/components/appUpdate";

export default function ConvexClientProvider({
  children,
}: {
  children: ReactNode;
}) {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const client = useMemo(() => {
    if (!convexUrl) {
      return null;
    }

    return new ConvexReactClient(convexUrl);
  }, [convexUrl]);

  if (!client) {
    return (
      <>
        {children}
        <StaleTabWatcher client={null} />
      </>
    );
  }

  return (
    <ConvexProvider client={client}>
      {children}
      <StaleTabWatcher client={client} />
    </ConvexProvider>
  );
}
