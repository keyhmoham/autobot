import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Segmented } from "@/components/duet/kit";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { resolveReportMutationOptions } from "@/lib/social/mutations";
import { reportsQueryOptions } from "@/lib/social/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/reports")({
  component: ReportsPage,
});

type StatusFilter = "open" | "resolved" | "dismissed";

const STATUS_OPTIONS: readonly { value: StatusFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
  { value: "dismissed", label: "Dismissed" },
];

/**
 * Posts people flagged: resolve, dismiss, or remove the post.
 */
function ReportsPage() {
  const [status, setStatus] = useState<StatusFilter>("open");
  const reports = useQuery(reportsQueryOptions(status));
  const resolve = useMutation(resolveReportMutationOptions(queryClient));
  const [error, setError] = useState<string | null>(null);

  return (
    <PageShell
      description="Posts people flagged. Resolve when you have acted, dismiss when nothing needs doing, or remove the post."
      title="Reports"
    >
      <div className="mb-4">
        <Segmented
          label="Report status"
          onChange={setStatus}
          options={STATUS_OPTIONS}
          value={status}
        />
      </div>

      {error ? (
        <p className="mb-4 text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <PageSection title={status === "open" ? "Open reports" : "Reports"}>
        {reports.isPending ? null : reports.error ? (
          <p className="text-destructive text-sm" role="alert">
            {reports.error.message}
          </p>
        ) : reports.data.length === 0 ? (
          <PageEmpty>
            {status === "open"
              ? "Nothing open. Reports from the Feed land here."
              : "None in this list."}
          </PageEmpty>
        ) : (
          <PageRows>
            {reports.data.map((report, index) => (
              <div key={report.id}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle>
                      {report.reason}
                      {report.post.author.handle
                        ? ` · @${report.post.author.handle}`
                        : ""}
                    </ItemTitle>
                    <ItemDescription>
                      Reported by @{report.reporter.handle} ·{" "}
                      {new Date(report.createdAt).toLocaleString()}
                      {report.note ? ` · ${report.note}` : ""}
                    </ItemDescription>
                    {report.post.body ? (
                      <p className="mt-2 line-clamp-3 text-sm">
                        {report.post.body}
                      </p>
                    ) : (
                      <p className="mt-2 text-muted-foreground text-sm">
                        Post removed or unavailable.
                      </p>
                    )}
                  </ItemContent>
                  {status === "open" ? (
                    <ItemActions className="flex-col items-stretch gap-1 sm:flex-row">
                      <Button
                        disabled={resolve.isPending}
                        onClick={() =>
                          resolve.mutate(
                            { id: report.id, action: "resolve" },
                            {
                              onError: (thrown) => setError(thrown.message),
                            },
                          )
                        }
                        size="sm"
                        variant="secondary"
                      >
                        Resolve
                      </Button>
                      <Button
                        disabled={resolve.isPending}
                        onClick={() =>
                          resolve.mutate(
                            { id: report.id, action: "dismiss" },
                            {
                              onError: (thrown) => setError(thrown.message),
                            },
                          )
                        }
                        size="sm"
                        variant="ghost"
                      >
                        Dismiss
                      </Button>
                      <Button
                        disabled={resolve.isPending || !report.post.id}
                        onClick={() =>
                          resolve.mutate(
                            { id: report.id, action: "remove" },
                            {
                              onError: (thrown) => setError(thrown.message),
                            },
                          )
                        }
                        size="sm"
                        variant="ghost"
                      >
                        Remove post
                      </Button>
                    </ItemActions>
                  ) : (
                    <ItemActions>
                      <Button
                        disabled={resolve.isPending}
                        onClick={() =>
                          resolve.mutate(
                            { id: report.id, action: "reopen" },
                            {
                              onError: (thrown) => setError(thrown.message),
                            },
                          )
                        }
                        size="sm"
                        variant="ghost"
                      >
                        Reopen
                      </Button>
                    </ItemActions>
                  )}
                </Item>
              </div>
            ))}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}
