import { APP_SANDBOX } from "@openbot/shared/apps";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { OutcomePill } from "@/components/duet/kit";
import { PageShell } from "@/components/layout/page-shell";
import { launchAppMutationOptions } from "@/lib/apps/mutations";
import { appQueryOptions } from "@/lib/apps/queries";
import { spaceQueryOptions } from "@/lib/spaces/queries";

/** One app: its detail and a sandboxed frame once launched. */
export const Route = createFileRoute(
  "/_authed/_app/spaces/$spaceId/apps/$appId",
)({
  component: SpaceAppPage,
});

function SpaceAppPage() {
  const { spaceId, appId } = Route.useParams();
  const queryClient = useQueryClient();
  const space = useQuery(spaceQueryOptions(spaceId));
  const app = useQuery(appQueryOptions(appId));
  const launch = useMutation(launchAppMutationOptions(queryClient));
  const [url, setUrl] = useState<string | null>(null);
  const started = useRef(false);

  // Open a launch link once when the page mounts, so the frame has somewhere to point.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    launch.mutate(appId, {
      onSuccess: (result) => {
        if (result.url) setUrl(result.url);
      },
    });
  }, [appId, launch]);

  const statusTone =
    app.data?.status === "running"
      ? "green"
      : app.data?.status === "failed"
        ? "red"
        : "neutral";

  return (
    <PageShell
      action={
        <button
          className="type-sub duet-touch font-medium text-duet-accent disabled:opacity-50"
          disabled={launch.isPending}
          onClick={() =>
            launch.mutate(appId, {
              onSuccess: (result) => {
                if (result.url) setUrl(result.url);
              },
            })
          }
          type="button"
        >
          Relaunch
        </button>
      }
      backButton={{
        linkProps: { to: "/spaces/$spaceId/apps", params: { spaceId } },
        label: "Apps",
      }}
      description={app.data?.description || space.data?.name}
      title={app.data?.name ?? "App"}
      width="wide"
    >
      {app.isPending ? null : app.error ? (
        <p className="type-sub text-duet-red" role="alert">
          {app.error.message}
        </p>
      ) : app.data ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <OutcomePill icon={null} tone={statusTone}>
            {app.data.status}
          </OutcomePill>
          {app.data.error ? (
            <p className="type-sub text-duet-red">{app.data.error}</p>
          ) : null}
        </div>
      ) : null}

      {launch.error ? (
        <p className="type-sub mb-3 text-duet-red" role="alert">
          {launch.error.message}
        </p>
      ) : null}

      {url ? (
        <iframe
          className="min-h-[70vh] w-full rounded-[var(--duet-radius-card)] border border-duet-hair-2 bg-duet-card"
          sandbox={APP_SANDBOX}
          src={url}
          title={app.data?.name ?? "App"}
        />
      ) : (
        <p className="type-sub text-duet-ink-2">
          {launch.isPending
            ? "Opening the app…"
            : "Launch the app to open it here."}
        </p>
      )}
    </PageShell>
  );
}
