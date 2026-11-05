"use client";

import { ReactNode, useMemo } from "react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { StaleTabWatcher } from "@/components/appUpdate";
import { api } from "@/convex/_generated/api";
import { convexHealth } from "@/lib/domain/convexHealth";
import { reportGuardRefusal } from "@/lib/domain/guardRefusal";

// Every mutation and action goes through client.mutation / client.action
// (useMutation and useAction included). A failure because this bundle is out
// of date marks the shared health state, so the app shows "Flow was updated"
// and reloads when safe. A write the server guards refused shows a short
// "Not saved" notice and is reported to guardViolations:reportRefusal (the
// refused mutation can't log itself). The error still reaches the caller.
function reportWriteFailures(client: ConvexReactClient) {
  const mutation = client.mutation.bind(client);
  const action = client.action.bind(client);
  const callMutation = mutation as (...rest: unknown[]) => Promise<unknown>;
  client.mutation = (async (...args: unknown[]) => {
    try {
      return await callMutation(...args);
    } catch (error) {
      convexHealth.reportWriteError(error);
      if (convexHealth.reportGuardRefusal(error)) {
        const ownerKey = (args[1] as { ownerKey?: unknown } | undefined)?.ownerKey;
        if (typeof ownerKey === "string") {
          void reportGuardRefusal(error, "app", (report) =>
            callMutation(api.guardViolations.reportRefusal, { ownerKey, ...report }),
          );
        }
      }
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

    return reportWriteFailures(new ConvexReactClient(convexUrl));
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
