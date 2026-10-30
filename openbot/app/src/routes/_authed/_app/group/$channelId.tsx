import { createFileRoute, redirect } from "@tanstack/react-router";

/** Groups now open as Spaces channels; keep the old path as a redirect. */
export const Route = createFileRoute("/_authed/_app/group/$channelId")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/spaces/channels/$channelId",
      params: { channelId: params.channelId },
      replace: true,
    });
  },
});
