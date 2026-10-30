import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { FeedScreen } from "@/components/shell/feed-screen";

/** Feed: posts from people you follow, everybody, or your spaces. */
export const Route = createFileRoute("/_authed/_app/feed")({
  component: FeedRoute,
});

function FeedRoute() {
  const atList =
    (useRouterState({ select: (state) => state.location.pathname }).replace(
      /\/+$/,
      "",
    ) || "/") === "/feed";
  return (
    <>
      {atList ? <FeedScreen /> : null}
      <Outlet />
    </>
  );
}
