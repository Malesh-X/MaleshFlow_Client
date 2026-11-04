"use client";

import { ReactNode, useMemo } from "react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { StaleTabWatcher } from "@/components/appUpdate";
import { convexHealth } from "@/lib/domain/convexHealth";

// Every mutation and action goes through client.mutation / client.action
// (useMutation and useAction included). A failure because this bundle is out
// of date marks the shared health state, so the app shows "Flow was updated"
// and reloads when safe. The error still reaches the caller.
function reportOutdatedWrites(client: ConvexReactClient) {
  const mutation = client.mutation.bind(client);
  const action = client.action.bind(client);
  client.mutation = (async (...args: unknown[]) => {
    try {
      return await (mutation as (...rest: unknown[]) => Promise<unknown>)(...args);
    } catch (error) {
      convexHealth.reportWriteError(error);
      throw error;
    }
  }) as typeof client.mutation;
  client.action = (async (...args: unknown[]) => {
    try {
      return await (action as (...rest: unknown[]) => Promise<unknown>)(...args);
    } catch (error) {
      convexHealth.reportWriteError(error);
      throw error;
    }
  }) as typeof client.action;
  return client;
}

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

    return reportOutdatedWrites(new ConvexReactClient(convexUrl));
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
