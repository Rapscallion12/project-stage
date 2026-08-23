import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuestNameEditor } from "./guest-name-editor";

const { setGuestName } = vi.hoisted(() => ({
  setGuestName: vi.fn(),
}));

vi.mock("@/app/events/[id]/lobby/actions", () => ({ setGuestName }));

describe("GuestNameEditor (real-device fix, 2026-08-22: commits on blur, not just on explicit Save)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("tapping 'change name' enters edit mode", () => {
    render(<GuestNameEditor initialName="Guest123" />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /change name/i }));

    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("Guest123");
  });

  it("blurring the input (tapping outside) commits and exits editing mode — no Save click required", async () => {
    setGuestName.mockResolvedValue({});
    render(<GuestNameEditor initialName="Guest123" />);
    fireEvent.click(screen.getByRole("button", { name: /change name/i }));

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Jamie" } });
    fireEvent.blur(input);

    await waitFor(() => expect(setGuestName).toHaveBeenCalledWith("Jamie"));
    await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());
  });

  it("pressing Return/Done (form submit) commits and exits editing mode via the same path as blur", async () => {
    setGuestName.mockResolvedValue({});
    render(<GuestNameEditor initialName="Guest123" />);
    fireEvent.click(screen.getByRole("button", { name: /change name/i }));

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Riley" } });
    fireEvent.submit(screen.getByTestId("guest-name-form"));

    await waitFor(() => expect(setGuestName).toHaveBeenCalledWith("Riley"));
    await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());
  });

  it("the displayed name updates to the committed value after exiting", async () => {
    setGuestName.mockResolvedValue({});
    render(<GuestNameEditor initialName="Guest123" />);
    fireEvent.click(screen.getByRole("button", { name: /change name/i }));

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Jamie" } });
    fireEvent.blur(screen.getByRole("textbox"));

    await waitFor(() => expect(screen.getByText("Jamie")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /change name/i })).toHaveTextContent("You're Jamie — change name");
  });

  it("an invalid (empty) name does not commit or exit — existing validation is preserved", async () => {
    setGuestName.mockResolvedValue({ error: "Name can't be empty." });
    render(<GuestNameEditor initialName="Guest123" />);
    fireEvent.click(screen.getByRole("button", { name: /change name/i }));

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);

    await waitFor(() => expect(setGuestName).toHaveBeenCalledWith(""));
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("tapping 'change name' itself is never treated as an outside interaction on the not-yet-mounted editor", () => {
    render(<GuestNameEditor initialName="Guest123" />);
    const toggle = screen.getByRole("button", { name: /change name/i });

    fireEvent.click(toggle);

    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(setGuestName).not.toHaveBeenCalled();
  });

  describe("variant='chip' (issue #21, 05 interaction model: compact top-chrome presentation, same state machine)", () => {
    it("renders the compact avatar+name chip instead of the 'You're X — change name' sentence", () => {
      render(<GuestNameEditor initialName="Guest123" variant="chip" />);
      expect(screen.queryByText(/you're/i)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Guest123" })).toBeInTheDocument();
    });

    it("tapping the chip enters edit mode, same as the inline variant", () => {
      render(<GuestNameEditor initialName="Guest123" variant="chip" />);
      fireEvent.click(screen.getByRole("button", { name: "Guest123" }));
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    it("still commits on blur with no Save button rendered", async () => {
      setGuestName.mockResolvedValue({});
      render(<GuestNameEditor initialName="Guest123" variant="chip" />);
      fireEvent.click(screen.getByRole("button", { name: "Guest123" }));

      expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();

      const input = screen.getByRole("textbox");
      fireEvent.change(input, { target: { value: "Jamie" } });
      fireEvent.blur(input);

      await waitFor(() => expect(setGuestName).toHaveBeenCalledWith("Jamie"));
      await waitFor(() => expect(screen.getByRole("button", { name: "Jamie" })).toBeInTheDocument());
    });
  });
});
