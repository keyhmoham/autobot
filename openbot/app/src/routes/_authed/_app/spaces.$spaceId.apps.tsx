import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { Row, Tile } from "@/components/duet/kit";
import { PageShell } from "@/components/layout/page-shell";
import { launchAppMutationOptions } from "@/lib/apps/mutations";
import { appsListQueryOptions } from "@/lib/apps/queries";
import { spaceQueryOptions } from "@/lib/spaces/queries";

/** Web apps this space's Bots built and run in the space computer. */
export const Route = createFileRoute("/_authed/_app/spaces/$spaceId/apps")({
  component: SpaceAppsRoute,
});

function SpaceAppsRoute() {
  const { spaceId } = Route.useParams();
  const path =
    useRouterState({ select: (state) => state.location.pathname }).replace(
      /\/+$/,
      "",
    ) || "/";
  const atList = path === `/spaces/${spaceId}/apps`;
  return (
    <>
      {atList ? <SpaceAppsPage spaceId={spaceId} /> : null}
      <Outlet />
    </>
  );
}

function SpaceAppsPage({ spaceId }: { spaceId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const space = useQuery(spaceQueryOptions(spaceId));
  const apps = useQuery(appsListQueryOptions(spaceId));
  const launch = useMutation(launchAppMutationOptions(queryClient));

  return (
    <PageShell
      backButton={{
        linkProps: { to: "/spaces/$spaceId", params: { spaceId } },
        label: space.data?.name ?? "Space",
      }}
      description="Web apps this space's Bots built."
      title="Apps"
    >
      {apps.isPending ? null : apps.error ? (
        <p className="type-sub text-duet-red" role="alert">
          {apps.error.message}
        </p>
      ) : !apps.data?.length ? (
        <p className="type-sub text-duet-ink-2">
          No apps in this space yet. A Bot can build one in the space computer.
        </p>
      ) : (
        <ul className="space-y-1">
          {apps.data.map((app) => (
            <li key={app.id}>
              <Row
                leading={<Tile icon="bolt" tone={app.status === "running" ? "green" : "neutral"} />}
                title={app.name}
                detail={app.description || app.status}
                trailing={
                  <div className="flex items-center gap-2">
                    <Link
                      className="type-sub font-medium text-duet-ink-2"
                      params={{ spaceId, appId: app.id }}
                      to="/spaces/$spaceId/apps/$appId"
                    >
                      Open
                    </Link>
                    <button
                      className="type-sub font-medium text-duet-accent disabled:opacity-50"
                      disabled={launch.isPending}
                      onClick={() =>
                        launch.mutate(app.id, {
                          onSuccess: (result) => {
                            if (result.url)
                              window.open(result.url, "_blank", "noopener,noreferrer");
                            else
                              void navigate({
                                to: "/spaces/$spaceId/apps/$appId",
                                params: { spaceId, appId: app.id },
                              });
                          },
                        })
                      }
                      type="button"
                    >
                      Launch
                    </button>
                  </div>
                }
              />
            </li>
          ))}
        </ul>
      )}
      {launch.error ? (
        <p className="type-sub mt-3 text-duet-red" role="alert">
          {launch.error.message}
        </p>
      ) : null}
    </PageShell>
  );
}
