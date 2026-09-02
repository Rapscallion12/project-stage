// @vitest-environment node
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";
import { createServiceClient } from "@/lib/supabase/service";

const hasServiceCredentials = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/**
 * Issue #29 (first profile/social-identity pass): real-database
 * coverage for the profile/username/follow schema (migration
 * 00000000000044) — uniqueness, reserved names, the `public_profiles`
 * view's own column boundary, RLS ownership, and the follow
 * relationship's own constraints. Same `signInAs` real-session pattern
 * `stage-rounds.test.ts` already established, so RLS is actually
 * exercised as a real authenticated request would hit it, not just
 * asserted against the service client.
 */
describe.skipIf(!hasServiceCredentials)("profiles, usernames, and follows (issue #29)", () => {
  let service: ReturnType<typeof createServiceClient>;
  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  type Label = "a" | "b" | "c";
  const testUserIds: string[] = [];
  const profiles: Record<Label, { id: string; email: string; password: string }> = {} as never;

  async function createTestProfile(label: Label, username: string) {
    const email = `test-profile-${label}-${crypto.randomUUID()}@example.invalid`;
    const password = `Test-Passw0rd-${crypto.randomUUID()}`;
    const { data, error } = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: `Test Profile ${label}` },
    });
    if (error || !data.user) throw new Error(error?.message ?? `failed to create test profile ${label}`);
    testUserIds.push(data.user.id);
    profiles[label] = { id: data.user.id, email, password };
    // The signup trigger (migration 00000000000001) creates the row with
    // username=null; claim one directly here so every test in this file
    // starts from a known, already-usernamed state.
    await service.from("profiles").update({ username }).eq("id", data.user.id);
  }

  async function signInAs(label: Label) {
    const { email, password } = profiles[label];
    const anon = createSupabaseClient(anonUrl, anonKey);
    const { data, error } = await anon.auth.signInWithPassword({ email, password });
    if (error || !data.session) throw new Error(error?.message ?? `failed to sign in as ${label}`);
    return createSupabaseClient<Database>(anonUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
    });
  }

  beforeAll(async () => {
    service = createServiceClient();
    // Kept short: the migration's own `username_format` check caps
    // usernames at 20 chars, so a `Date.now()` suffix alone (13 digits)
    // leaves no room for a prefix — use a short random suffix instead.
    const suffix = () => Math.random().toString(36).slice(2, 8);
    await createTestProfile("a", `tpa${suffix()}`);
    await createTestProfile("b", `tpb${suffix()}`);
    await createTestProfile("c", `tpc${suffix()}`);
  }, 30_000);

  afterAll(async () => {
    for (const id of testUserIds) {
      await service.auth.admin.deleteUser(id);
    }
  }, 30_000);

  describe("username uniqueness and format", () => {
    it("rejects a second account claiming the same username, case-insensitively", async () => {
      const { data: aRow } = await service.from("profiles").select("username").eq("id", profiles.a.id).single();
      const aUsername = aRow!.username!;

      const { error: exactDup } = await service.from("profiles").update({ username: aUsername }).eq("id", profiles.b.id);
      expect(exactDup?.code).toBe("23505");

      const { error: caseDup } = await service.from("profiles").update({ username: aUsername.toUpperCase() }).eq("id", profiles.b.id);
      // Stored value is already lowercase at write time by convention
      // (see lib/username.ts) — a caller that bypasses that
      // normalization and writes uppercase directly hits the format
      // constraint instead (usernames must already be lowercase), not
      // silently succeeding as a "different" username.
      expect(caseDup?.code).toBe("23514");
    });

    it("rejects malformed usernames at the database layer", async () => {
      const tooShort = await service.from("profiles").update({ username: "ab" }).eq("id", profiles.c.id);
      expect(tooShort.error?.code).toBe("23514");

      const badChars = await service.from("profiles").update({ username: "not-valid!" }).eq("id", profiles.c.id);
      expect(badChars.error?.code).toBe("23514");

      const uppercase = await service.from("profiles").update({ username: "Uppercase" }).eq("id", profiles.c.id);
      expect(uppercase.error?.code).toBe("23514");
    });

    it("rejects reserved usernames at the database layer", async () => {
      const { error } = await service.from("profiles").update({ username: "admin" }).eq("id", profiles.c.id);
      expect(error?.code).toBe("23514");
    });

    it("rejects a bio longer than 160 characters", async () => {
      const { error } = await service.from("profiles").update({ bio: "x".repeat(161) }).eq("id", profiles.c.id);
      expect(error?.code).toBe("23514");
    });
  });

  describe("profile ownership (RLS)", () => {
    it("a user can update their own profile but not another user's", async () => {
      const asA = await signInAs("a");
      const { error: ownUpdate } = await asA.from("profiles").update({ display_name: "A Updated" }).eq("id", profiles.a.id);
      expect(ownUpdate).toBeNull();

      // RLS silently matches zero rows rather than raising — the
      // established Supabase RLS UPDATE behavior this project's own
      // other RLS tests already rely on.
      const { error: crossUpdate, count } = await asA
        .from("profiles")
        .update({ display_name: "Hijacked" }, { count: "exact" })
        .eq("id", profiles.b.id);
      expect(crossUpdate).toBeNull();
      expect(count).toBe(0);

      const { data: bRow } = await service.from("profiles").select("display_name").eq("id", profiles.b.id).single();
      expect(bRow!.display_name).not.toBe("Hijacked");
    });
  });

  describe("public_profiles view", () => {
    it("excludes internal columns (reliability_score, reputation_score) even though the underlying row has them", async () => {
      const { data } = await service.from("public_profiles").select("*").eq("id", profiles.a.id).single();
      expect(data).not.toHaveProperty("reliability_score");
      expect(data).not.toHaveProperty("reputation_score");
    });

    it("excludes a profile that has no username yet", async () => {
      const email = `test-profile-nouser-${crypto.randomUUID()}@example.invalid`;
      const { data: created, error } = await service.auth.admin.createUser({
        email,
        password: `Test-Passw0rd-${crypto.randomUUID()}`,
        email_confirm: true,
        user_metadata: { display_name: "No Username Yet" },
      });
      if (error || !created.user) throw new Error(error?.message ?? "failed to create no-username test profile");
      testUserIds.push(created.user.id);

      const { data: publicRow } = await service.from("public_profiles").select("id").eq("id", created.user.id).maybeSingle();
      expect(publicRow).toBeNull();

      const { data: baseRow } = await service.from("profiles").select("id").eq("id", created.user.id).maybeSingle();
      expect(baseRow).not.toBeNull(); // the account itself is completely unaffected
    });

    it("is readable by an unauthenticated (anon) client — guests can view public profiles", async () => {
      const anon = createSupabaseClient<Database>(anonUrl, anonKey);
      const { data: aRow } = await service.from("profiles").select("username").eq("id", profiles.a.id).single();
      const { data, error } = await anon.from("public_profiles").select("username, display_name").eq("username", aRow!.username!).maybeSingle();
      expect(error).toBeNull();
      expect(data?.display_name).toBeTruthy();
    });
  });

  describe("follows", () => {
    it("A follows B, then unfollows — counts reflect both transitions, and both are readable by an anon client", async () => {
      const asA = await signInAs("a");
      const anon = createSupabaseClient<Database>(anonUrl, anonKey);

      const { error: followError } = await asA.from("follows").insert({ follower_id: profiles.a.id, following_id: profiles.b.id });
      expect(followError).toBeNull();

      const { count: followerCount } = await anon
        .from("follows")
        .select("*", { count: "exact", head: true })
        .eq("following_id", profiles.b.id);
      expect(followerCount).toBe(1);

      const { error: unfollowError } = await asA.from("follows").delete().eq("follower_id", profiles.a.id).eq("following_id", profiles.b.id);
      expect(unfollowError).toBeNull();

      const { count: afterUnfollow } = await anon
        .from("follows")
        .select("*", { count: "exact", head: true })
        .eq("following_id", profiles.b.id);
      expect(afterUnfollow).toBe(0);
    });

    it("a duplicate follow is a harmless primary-key violation, not a second row", async () => {
      const asA = await signInAs("a");
      await asA.from("follows").insert({ follower_id: profiles.a.id, following_id: profiles.c.id });
      const { error: dup } = await asA.from("follows").insert({ follower_id: profiles.a.id, following_id: profiles.c.id });
      expect(dup?.code).toBe("23505");

      const { count } = await service.from("follows").select("*", { count: "exact", head: true }).eq("follower_id", profiles.a.id).eq("following_id", profiles.c.id);
      expect(count).toBe(1);

      await service.from("follows").delete().eq("follower_id", profiles.a.id).eq("following_id", profiles.c.id);
    });

    it("self-follow is rejected by the database's own check constraint", async () => {
      const asA = await signInAs("a");
      const { error } = await asA.from("follows").insert({ follower_id: profiles.a.id, following_id: profiles.a.id });
      expect(error?.code).toBe("23514");
    });

    it("a user cannot create a follow row claiming to be a different follower", async () => {
      const asA = await signInAs("a");
      // A tries to insert a follow row where B is the follower — RLS's
      // own `with check (follower_id = auth.uid())` must block this
      // regardless of who the target is.
      const { error, count } = await asA.from("follows").insert({ follower_id: profiles.b.id, following_id: profiles.c.id }, { count: "exact" });
      // Blocked either as an RLS policy violation (42501/new row
      // violates row-level security) or silently inserting zero rows,
      // depending on Postgres version behavior for a failed WITH CHECK —
      // either way, no row must exist afterward.
      void error;
      void count;
      const { count: actualCount } = await service.from("follows").select("*", { count: "exact", head: true }).eq("follower_id", profiles.b.id).eq("following_id", profiles.c.id);
      expect(actualCount).toBe(0);
    });

    it("a user cannot delete another user's follow row", async () => {
      const asA = await signInAs("a");
      const asB = await signInAs("b");
      await asB.from("follows").insert({ follower_id: profiles.b.id, following_id: profiles.c.id });

      const { count } = await asA.from("follows").delete({ count: "exact" }).eq("follower_id", profiles.b.id).eq("following_id", profiles.c.id);
      expect(count).toBe(0);

      const { data: stillThere } = await service.from("follows").select("follower_id").eq("follower_id", profiles.b.id).eq("following_id", profiles.c.id).maybeSingle();
      expect(stillThere).not.toBeNull();

      await service.from("follows").delete().eq("follower_id", profiles.b.id).eq("following_id", profiles.c.id);
    });
  });

  describe("avatar storage bucket", () => {
    it("the avatars bucket exists, is public, and enforces its own size/type limits", async () => {
      const { data, error } = await service.storage.getBucket("avatars");
      expect(error).toBeNull();
      expect(data?.public).toBe(true);
      expect(data?.file_size_limit).toBe(5242880);
      expect(data?.allowed_mime_types).toEqual(expect.arrayContaining(["image/jpeg", "image/png", "image/webp"]));
    });

    it("a user cannot upload into another user's avatar folder", async () => {
      const asA = await signInAs("a");
      const fakeImage = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/jpeg" });
      const { error } = await asA.storage.from("avatars").upload(`${profiles.b.id}/avatar.jpg`, fakeImage, { upsert: true });
      expect(error).not.toBeNull();
    });

    it("a user can upload into their own avatar folder", async () => {
      const asA = await signInAs("a");
      const fakeImage = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/jpeg" });
      const { error } = await asA.storage.from("avatars").upload(`${profiles.a.id}/avatar.jpg`, fakeImage, { upsert: true });
      expect(error).toBeNull();
      await service.storage.from("avatars").remove([`${profiles.a.id}/avatar.jpg`]);
    });
  });
});
