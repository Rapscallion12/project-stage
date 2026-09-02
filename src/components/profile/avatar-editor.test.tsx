import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AvatarEditor } from "./avatar-editor";

const { uploadAvatar, deleteAvatarFile, saveAvatarUrl, removeAvatar } = vi.hoisted(() => ({
  uploadAvatar: vi.fn(),
  deleteAvatarFile: vi.fn(async () => {}),
  saveAvatarUrl: vi.fn(async () => null),
  removeAvatar: vi.fn(async () => null),
}));

vi.mock("@/lib/avatar-upload", () => ({ uploadAvatar, deleteAvatarFile }));
vi.mock("@/app/profile/actions", () => ({ saveAvatarUrl, removeAvatar }));

function makeFile(name = "photo.jpg", type = "image/jpeg") {
  return new File(["fake-image-bytes"], name, { type });
}

/**
 * Issue #29, profile UX polish pass, Sections 5-8/13: the avatar circle
 * itself is now the picker trigger — this suite covers that it uses the
 * exact same existing upload/remove pipeline (never a second
 * implementation), the correct accessible label in both states, keyboard
 * activation, and that Remove Photo survives the button/badge redesign.
 */
describe("AvatarEditor", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("labels the trigger 'Add profile photo' when no avatar exists yet", () => {
    render(<AvatarEditor userId="u1" displayName="Jamie Rivera" initialAvatarUrl={null} />);
    expect(screen.getByRole("button", { name: "Add profile photo" })).toBeInTheDocument();
  });

  it("labels the trigger 'Change profile photo' once an avatar exists", () => {
    render(<AvatarEditor userId="u1" displayName="Jamie Rivera" initialAvatarUrl="https://example.com/a.jpg" />);
    expect(screen.getByRole("button", { name: "Change profile photo" })).toBeInTheDocument();
  });

  it("renders the shared fallback avatar inside the trigger when there's no photo yet", () => {
    render(<AvatarEditor userId="u1" displayName="Jamie Rivera" initialAvatarUrl={null} />);
    expect(screen.getByTestId("participant-avatar-initials")).toHaveTextContent("JA");
  });

  it("clicking the avatar trigger (with no existing photo) opens the file picker", () => {
    render(<AvatarEditor userId="u1" displayName="Jamie Rivera" initialAvatarUrl={null} />);
    const input = screen.getByTestId("avatar-file-input") as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click");
    fireEvent.click(screen.getByTestId("avatar-picker-trigger"));
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("clicking the avatar trigger with an EXISTING photo also opens the file picker, to replace it", () => {
    render(<AvatarEditor userId="u1" displayName="Jamie Rivera" initialAvatarUrl="https://example.com/a.jpg" />);
    const input = screen.getByTestId("avatar-file-input") as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click");
    fireEvent.click(screen.getByTestId("avatar-picker-trigger"));
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("is keyboard-activatable — a real <button>, not a div with a click handler", () => {
    render(<AvatarEditor userId="u1" displayName="Jamie Rivera" initialAvatarUrl={null} />);
    expect(screen.getByTestId("avatar-picker-trigger").tagName).toBe("BUTTON");
  });

  it("selecting a file runs it through the existing uploadAvatar -> saveAvatarUrl pipeline, unchanged", async () => {
    uploadAvatar.mockResolvedValueOnce({ url: "https://example.com/new.jpg" });
    render(<AvatarEditor userId="u1" displayName="Jamie Rivera" initialAvatarUrl={null} />);
    const input = screen.getByTestId("avatar-file-input") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeFile()] } });

    await waitFor(() => expect(uploadAvatar).toHaveBeenCalledWith("u1", expect.any(File)));
    await waitFor(() => expect(saveAvatarUrl).toHaveBeenCalledWith("https://example.com/new.jpg"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Change profile photo" })).toBeInTheDocument());
  });

  it("shows the upload's own error message inline on failure, without calling saveAvatarUrl", async () => {
    uploadAvatar.mockResolvedValueOnce({ error: "That image is too large — please choose one under 5MB." });
    render(<AvatarEditor userId="u1" displayName="Jamie Rivera" initialAvatarUrl={null} />);
    fireEvent.change(screen.getByTestId("avatar-file-input"), { target: { files: [makeFile()] } });

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/too large/));
    expect(saveAvatarUrl).not.toHaveBeenCalled();
  });

  it("Remove photo calls the existing deleteAvatarFile + removeAvatar pipeline and reverts to the fallback avatar", async () => {
    render(<AvatarEditor userId="u1" displayName="Jamie Rivera" initialAvatarUrl="https://example.com/a.jpg" />);
    fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));

    await waitFor(() => expect(deleteAvatarFile).toHaveBeenCalledWith("u1"));
    expect(removeAvatar).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Add profile photo" })).toBeInTheDocument());
  });

  it("does not show a Remove photo control when there's no avatar to remove", () => {
    render(<AvatarEditor userId="u1" displayName="Jamie Rivera" initialAvatarUrl={null} />);
    expect(screen.queryByRole("button", { name: "Remove photo" })).not.toBeInTheDocument();
  });

  it("no longer shows a separate large 'Add photo'/'Change photo' text button — the avatar itself is the only trigger", () => {
    render(<AvatarEditor userId="u1" displayName="Jamie Rivera" initialAvatarUrl={null} />);
    expect(screen.queryByRole("button", { name: "Add photo" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change photo" })).not.toBeInTheDocument();
  });
});
