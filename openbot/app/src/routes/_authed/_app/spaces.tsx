import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { SpacesScreen } from "@/components/shell/spaces-screen";

/** Spaces: the person's spaces, invitations, directs and a search for public ones. */
export const Route = createFileRoute("/_authed/_app/spaces")({
  component: SpacesRoute,
});

function SpacesRoute() {
  // Detail routes are children of this layout; keep the list only on the tab itself.
  const atList =
    (useRouterState({ select: (state) => state.location.pathname }).replace(
      /\/+$/,
      "",
    ) || "/") === "/spaces";
  return (
    <>
      {atList ? <SpacesScreen /> : null}
      <Outlet />
    </>
  );
}
