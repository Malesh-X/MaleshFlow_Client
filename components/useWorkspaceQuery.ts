"use client";

// useQuery that never throws into React. A failing subscription (for example
// a function a deploy removed while this tab still runs the old bundle) keeps
// returning its last good value for the same arguments, or undefined
// (loading) when it has none, and reports the error to the shared health
// state, which shows the "Flow was updated · Reload" banner.

import { useEffect, useId, useMemo } from "react";
import { useQueries, type OptionalRestArgsOrSkip, type RequestForQueries } from "convex/react";
import {
  getFunctionName,
  makeFunctionReference,
  type FunctionReference,
  type FunctionReturnType,
} from "convex/server";
import { convexToJson, jsonToConvex, type Value } from "convex/values";
import { convexHealth } from "@/lib/domain/convexHealth";

// Each hook's last good result (by useId), written after commit. Kept outside
// React state so remembering it never re-renders the (large) workspace.
const lastGoodByHook = new Map<string, { key: string; value: unknown }>();

export function useWorkspaceQuery<Query extends FunctionReference<"query">>(
  query: Query,
  ...args: OptionalRestArgsOrSkip<Query>
): FunctionReturnType<Query> | undefined {
  const id = useId();
  const name = getFunctionName(query);
  const argsOrSkip = (args[0] ?? {}) as Record<string, Value> | "skip";
  const skip = argsOrSkip === "skip";
  const argsKey = skip ? null : JSON.stringify(convexToJson(argsOrSkip));
  const queries = useMemo(() => {
    const request: RequestForQueries = {};
    if (argsKey !== null) {
      request.result = {
        query: makeFunctionReference<"query">(name),
        args: jsonToConvex(JSON.parse(argsKey)) as Record<string, Value>,
      };
    }
    return request;
  }, [argsKey, name]);
  const raw = useQueries(queries).result as unknown;
  const error = raw instanceof Error ? raw : null;
  const subscriptionKey = argsKey === null ? null : `${name}:${argsKey}`;

  let value: unknown = undefined;
  if (subscriptionKey !== null) {
    const lastGood = lastGoodByHook.get(id);
    if (!error && raw !== undefined) {
      value = raw;
    } else if (error && lastGood?.key === subscriptionKey) {
      value = lastGood.value;
    }
  }

  useEffect(() => {
    if (subscriptionKey !== null && !error && raw !== undefined) {
      lastGoodByHook.set(id, { key: subscriptionKey, value: raw });
    }
  }, [error, id, raw, subscriptionKey]);

  const errorMessage = error ? error.message || String(error) : null;
  useEffect(() => {
    if (errorMessage === null || subscriptionKey === null) {
      convexHealth.clearQueryError(id);
      return;
    }
    convexHealth.reportQueryError(id, name, new Error(errorMessage));
  }, [errorMessage, id, name, subscriptionKey]);
  useEffect(
    () => () => {
      convexHealth.clearQueryError(id);
      lastGoodByHook.delete(id);
    },
    [id],
  );

  return value as FunctionReturnType<Query> | undefined;
}
