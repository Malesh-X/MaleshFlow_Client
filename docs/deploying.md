# Deploying

A push to `master` is the production deploy. Vercel runs
`npx convex deploy --cmd 'npm run build'`, so the **Convex backend changes
first** and the new frontend goes live a few minutes later, when Vercel
promotes the build.

So at every deploy, for a while, three things talk to the new backend:

- tabs opened earlier, still running an older bundle (until they reload);
- tabs opened during the build, which still get the old frontend;
- reloads during the build, which also get the old frontend.

## Rule: never remove a public Convex function in one step

Removing, renaming or changing the kind (query/mutation/action) of a public
function breaks every tab that still calls it. Do it in three steps:

1. **Remove the client usage first** and deploy.
2. **Keep a backend stub for at least a week.** Move the function to
   `convex/lib/retiredStubs.ts`: add an entry to `RETIRED_PUBLIC_FUNCTIONS`
   (with `deleteAfter`) and register it under its old name in its old module,
   e.g. `export const validateOwnerKey = query(retiredNullQuery);`. The stub
   must be harmless for everyone: return the same constant whatever the
   arguments, read nothing, and never reveal whether an owner key is valid.
   Pick a return value an old tab handles without crashing (look at how the
   old client used the result).
3. **Delete the stub** after its date: its registration, its entry and its
   line in `tests/publicFunctions.snapshot.json`.

Argument changes follow the same idea: accept the old arguments (make new
fields optional) until old tabs are gone.

`tests/publicFunctions.test.ts` compares the public functions with
`tests/publicFunctions.snapshot.json`. It fails when one disappears, and when
a new one isn't in the snapshot yet. Update the snapshot with:

```bash
UPDATE_PUBLIC_FUNCTIONS_SNAPSHOT=1 npm run -s test:unit
```

## What an old tab does

- Workspace queries go through `useWorkspaceQuery`
  (`components/useWorkspaceQuery.ts`), which never throws: a failing
  subscription keeps its last value and reports to one shared state
  (`lib/domain/convexHealth.ts`).
- That state shows a small "Flow was updated · Reload" banner, and the tab
  checks `/api/version` every 15 seconds. Once the new frontend is live it
  reloads by itself, as soon as no write is in flight and no editor holds
  unsaved text (`components/appUpdate.tsx`).
- A failed write from an old tab shows a toast; the editor keeps its text.
- The full "Workspace Error" screen is only for render bugs.

Use `useWorkspaceQuery`, not `useQuery` from `convex/react`, in app
components.
