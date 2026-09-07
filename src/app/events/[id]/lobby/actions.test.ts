import { afterEach, describe, expect, it, vi } from "vitest";

const { resolveIdentity, hasSentMessageRecently, insertMessage, isPreviewOrDevBuild } = vi.hoisted(() => ({
  resolveIdentity: vi.fn(async (): Promise<{ type: "profile" | "guest"; id: string; displayName: string; username?: string | null }> => ({
    type: "guest",
    id: "guest-1",
    displayName: "Cheerful Raven",
  })),
  hasSentMessageRecently: vi.fn(async () => false),
  insertMessage: vi.fn(
    async (): Promise<{ ok: boolean; error?: { message: string; code: string | undefined } }> => ({ ok: true }),
  ),
  isPreviewOrDevBuild: vi.fn(() => false),
}));

vi.mock("@/lib/identity", () => ({ resolveIdentity }));
vi.mock("@/lib/repositories/chat", () => ({ hasSentMessageRecently, insertMessage, insertReaction: vi.fn() }));
vi.mock("@/lib/preview-mode", () => ({ isPreviewOrDevBuild }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ set: vi.fn() })) }));

import { sendMessage } from "./actions";

function formData(body: string): FormData {
  const fd = new FormData();
  fd.set("body", body);
  return fd;
}

describe("sendMessage (real-device report: commenting was reported broken)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    resolveIdentity.mockResolvedValue({ type: "guest", id: "guest-1", displayName: "Cheerful Raven" });
    hasSentMessageRecently.mockResolvedValue(false);
    insertMessage.mockResolvedValue({ ok: true });
    isPreviewOrDevBuild.mockReturnValue(false);
  });

  describe("every combination of role x account status can comment — this action never gates on speaker status at all", () => {
    it("guest viewer can submit a comment", async () => {
      resolveIdentity.mockResolvedValue({ type: "guest", id: "guest-1", displayName: "Cheerful Raven" });
      const result = await sendMessage("e1", undefined, formData("hello"));
      expect(result).toBeUndefined(); // no error
      expect(insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: "e1", identity: { type: "guest", id: "guest-1", displayName: "Cheerful Raven" }, body: "hello" }),
      );
    });

    it("registered viewer can submit a comment", async () => {
      resolveIdentity.mockResolvedValue({ type: "profile", id: "user-1", displayName: "Jamie", username: "jamie" });
      const result = await sendMessage("e1", undefined, formData("hello"));
      expect(result).toBeUndefined();
      expect(insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({ identity: expect.objectContaining({ type: "profile", id: "user-1" }) }),
      );
    });

    // `sendMessage` has no seat/role lookup anywhere in its own body — it
    // only ever resolves identity and inserts. These two tests exist to
    // prove that stays true: a guest/account holder who happens to be an
    // active speaker is handed the *exact same* code path as an ordinary
    // viewer, never a different or blocked one.
    it("guest speaker can submit a comment — identical path to a guest viewer, no seat lookup involved", async () => {
      resolveIdentity.mockResolvedValue({ type: "guest", id: "guest-speaker-1", displayName: "Bold Otter" });
      const result = await sendMessage("e1", undefined, formData("speaking and commenting"));
      expect(result).toBeUndefined();
      expect(insertMessage).toHaveBeenCalled();
    });

    it("registered speaker can submit a comment — identical path to a registered viewer, no seat lookup involved", async () => {
      resolveIdentity.mockResolvedValue({ type: "profile", id: "speaker-account-1", displayName: "Dana", username: "dana" });
      const result = await sendMessage("e1", undefined, formData("speaking and commenting"));
      expect(result).toBeUndefined();
      expect(insertMessage).toHaveBeenCalled();
    });
  });

  it("a successful submission returns no error — the intended live path (Realtime delivers the new row to every subscriber, this action's own job ends at the insert)", async () => {
    const result = await sendMessage("e1", undefined, formData("a normal comment"));
    expect(result).toBeUndefined();
  });

  describe("real root cause this session traced: insertMessage's error was previously discarded outright", () => {
    it("a failed insert returns a diagnosable error, never silently succeeds", async () => {
      insertMessage.mockResolvedValue({ ok: false, error: { message: "new row violates row-level security policy", code: "42501" } });
      const result = await sendMessage("e1", undefined, formData("this will fail"));
      expect(result?.error).toBeTruthy();
    });

    it("logs the real error server-side unconditionally, regardless of environment", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      insertMessage.mockResolvedValue({ ok: false, error: { message: "some real postgres error", code: "23503" } });
      await sendMessage("e1", undefined, formData("this will fail"));
      expect(consoleError).toHaveBeenCalledWith("[sendMessage] insertMessage failed", expect.objectContaining({ eventId: "e1" }));
      consoleError.mockRestore();
    });

    it("includes the real Postgres error detail on a non-production build (internal/dev observability)", async () => {
      isPreviewOrDevBuild.mockReturnValue(true);
      insertMessage.mockResolvedValue({ ok: false, error: { message: "new row violates row-level security policy", code: "42501" } });
      const result = await sendMessage("e1", undefined, formData("this will fail"));
      expect(result?.error).toContain("42501");
      expect(result?.error).toContain("row-level security");
    });

    it("never leaks raw Postgres error detail on a production build — generic message only", async () => {
      isPreviewOrDevBuild.mockReturnValue(false);
      insertMessage.mockResolvedValue({ ok: false, error: { message: "new row violates row-level security policy", code: "42501" } });
      const result = await sendMessage("e1", undefined, formData("this will fail"));
      expect(result?.error).not.toContain("42501");
      expect(result?.error).not.toContain("row-level security");
      expect(result?.error).toContain("Couldn't send your message");
    });
  });

  describe("validation happens before ever touching the database — the draft itself is never at risk from these", () => {
    it("rejects an empty message without calling insertMessage at all", async () => {
      const result = await sendMessage("e1", undefined, formData("   "));
      expect(result?.error).toBe("Message can't be empty.");
      expect(insertMessage).not.toHaveBeenCalled();
    });

    it("rejects a message over the length limit without calling insertMessage", async () => {
      const result = await sendMessage("e1", undefined, formData("x".repeat(501)));
      expect(result?.error).toContain("500 characters");
      expect(insertMessage).not.toHaveBeenCalled();
    });

    it("rejects a rapid resubmission (rate limit) without calling insertMessage", async () => {
      hasSentMessageRecently.mockResolvedValue(true);
      const result = await sendMessage("e1", undefined, formData("too fast"));
      expect(result?.error).toContain("too quickly");
      expect(insertMessage).not.toHaveBeenCalled();
    });
  });
});
