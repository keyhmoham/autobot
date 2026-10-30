import {
  DIRECT_POLICIES,
  type DirectPolicy,
  MAX_BIO_LENGTH,
} from "@openbot/shared/social";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Segmented } from "@/components/duet/kit";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { updateProfileMutationOptions } from "@/lib/social/mutations";
import { myProfileQueryOptions } from "@/lib/social/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/settings/profile")({
  component: ProfilePage,
});

const DIRECT_OPTIONS: readonly { value: DirectPolicy; label: string }[] = [
  { value: "everyone", label: "Anyone" },
  { value: "following", label: "People I follow" },
  { value: "nobody", label: "Nobody" },
];

/** Confirm DIRECT_POLICIES stays the switch's source of truth. */
void DIRECT_POLICIES;

/**
 * How you appear on the Feed: handle, name, bio, and who may start a direct conversation with you.
 */
function ProfilePage() {
  const profile = useQuery(myProfileQueryOptions());
  const save = useMutation(updateProfileMutationOptions(queryClient));
  const [handle, setHandle] = useState("");
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [directs, setDirects] = useState<DirectPolicy>("everyone");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!profile.data) return;
    setHandle(profile.data.handle);
    setName(profile.data.name);
    setBio(profile.data.bio);
    setDirects(profile.data.directs);
  }, [profile.data]);

  return (
    <PageShell
      description="How you appear when you post, and who may message you directly."
      title="Profile"
    >
      {profile.isPending ? null : profile.error ? (
        <p className="text-destructive text-sm" role="alert">
          {profile.error.message}
        </p>
      ) : (
        <PageSection title="About you">
          <form
            className="mt-3 flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              setSaved(false);
              save.mutate(
                { handle, name, bio, directs },
                { onSuccess: () => setSaved(true) },
              );
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="profile-handle">Handle</Label>
              <Input
                autoComplete="username"
                id="profile-handle"
                maxLength={30}
                onChange={(event) =>
                  setHandle(event.target.value.toLowerCase())
                }
                spellCheck={false}
                value={handle}
              />
              <p className="text-muted-foreground text-xs">
                Lower-case letters, digits and underscores, 3–30 characters.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="profile-name">Name</Label>
              <Input
                autoComplete="nickname"
                id="profile-name"
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="profile-bio">Bio</Label>
              <Textarea
                id="profile-bio"
                maxLength={MAX_BIO_LENGTH}
                onChange={(event) => setBio(event.target.value)}
                rows={4}
                value={bio}
              />
              <p className="text-muted-foreground text-xs">
                {bio.length}/{MAX_BIO_LENGTH}
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <p className="font-medium text-xs">Who can message you</p>
              <Segmented
                label="Who can message you"
                onChange={setDirects}
                options={DIRECT_OPTIONS}
                value={directs}
              />
            </div>
            <div className="flex items-center gap-3">
              <Button disabled={save.isPending} type="submit">
                Save
              </Button>
              {saved && !save.isPending ? (
                <p className="text-muted-foreground text-sm">Saved.</p>
              ) : null}
            </div>
            {save.error ? (
              <p className="text-destructive text-sm" role="alert">
                {save.error.message}
              </p>
            ) : null}
          </form>
        </PageSection>
      )}
    </PageShell>
  );
}
