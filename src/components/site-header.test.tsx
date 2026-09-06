import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SiteHeader } from "./site-header";

const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser } })),
}));

const { getOwnProfile } = vi.hoisted(() => ({ getOwnProfile: vi.fn() }));
vi.mock("@/lib/repositories/profiles", () => ({ getOwnProfile }));

/**
 * Responsive/accessibility polish pass: real-device feedback found
 * "VIRTUAL STAGE"/"Log in" wrapping onto two lines at narrow phone
 * widths (~375-390px). jsdom doesn't lay out CSS, so this can't assert
 * actual wrapped-vs-not-wrapped pixels — it asserts the structural
 * contract that prevents it (`whitespace-nowrap` on the wordmark and
 * both guest buttons, `shrink-0` so flexbox can't compress them below
 * their content width instead), which is the actual mechanism a
 * regression would remove. Real-browser confirmation at 375/390/430px
 * is the stronger check — see SESSION_LOG.md.
 */
describe("SiteHeader", () => {
  it("guest header: VIRTUAL STAGE and both buttons never wrap (whitespace-nowrap present)", async () => {
    getUser.mockResolvedValueOnce({ data: { user: null } });
    render(await SiteHeader());

    expect(screen.getByRole("link", { name: "VIRTUAL STAGE" })).toHaveClass("whitespace-nowrap");
    expect(screen.getByRole("link", { name: "Log in" })).toHaveClass("whitespace-nowrap");
    expect(screen.getByRole("link", { name: "Sign up" })).toHaveClass("whitespace-nowrap");
  });

  it("guest header: Events remains present and usable", async () => {
    getUser.mockResolvedValueOnce({ data: { user: null } });
    render(await SiteHeader());
    expect(screen.getByRole("link", { name: "Events" })).toHaveAttribute("href", "/events");
  });

  it("guest header: no account menu/avatar rendered for a guest", async () => {
    getUser.mockResolvedValueOnce({ data: { user: null } });
    render(await SiteHeader());
    expect(screen.queryByTestId("home-account-menu")).not.toBeInTheDocument();
  });

  it("authenticated header is unaffected by the guest-header spacing fix — still renders the single avatar menu", async () => {
    getUser.mockResolvedValueOnce({ data: { user: { id: "u1" } } });
    getOwnProfile.mockResolvedValueOnce({
      id: "u1",
      username: "jamier",
      display_name: "Jamie Rivera",
      avatar_url: null,
      bio: null,
      social_links: {},
      created_at: new Date().toISOString(),
    });
    render(await SiteHeader());

    expect(screen.getByTestId("home-account-menu")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Log in" })).not.toBeInTheDocument();
  });
});
