import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RoomHeader } from "./room-header";

describe("RoomHeader", () => {
  it("shows the event title, mapped room-status label, and audience count", () => {
    render(
      <RoomHeader eventTitle="Late Night Debate" roomStatus="live" participantCount={42} connectionStatus="connected" />,
    );
    expect(screen.getByRole("heading", { name: "Late Night Debate" })).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("maps each room status to its label", () => {
    const { rerender } = render(
      <RoomHeader eventTitle="E" roomStatus="waiting" participantCount={0} connectionStatus="connected" />,
    );
    expect(screen.getByText("Waiting for speakers")).toBeInTheDocument();

    rerender(<RoomHeader eventTitle="E" roomStatus="selecting" participantCount={0} connectionStatus="connected" />);
    expect(screen.getByText("Selecting next speaker")).toBeInTheDocument();
  });

  it("surfaces this viewer's own degraded connection alongside the room status", () => {
    render(
      <RoomHeader eventTitle="E" roomStatus="live" participantCount={10} connectionStatus="reconnecting" />,
    );
    expect(screen.getByText(/Live/)).toHaveTextContent("Reconnecting");
  });

  it("says nothing extra about the connection when it's healthy", () => {
    render(<RoomHeader eventTitle="E" roomStatus="live" participantCount={10} connectionStatus="connected" />);
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.queryByText(/Connecting|Reconnecting|Connection lost/)).not.toBeInTheDocument();
  });

  it("explicitly names an unavailable LiveKit connection, rather than staying silent (issue #15 real-device follow-up)", () => {
    render(<RoomHeader eventTitle="E" roomStatus="waiting" participantCount={0} connectionStatus="unavailable" />);
    expect(screen.getByText(/Live video isn't configured for this room/)).toBeInTheDocument();
  });

  it("appends the countdown to the room status rather than replacing it, once one is provided (issue #17)", () => {
    render(
      <RoomHeader
        eventTitle="E"
        roomStatus="waiting"
        countdownText="Live in 2h 15m"
        participantCount={0}
        connectionStatus="connected"
      />,
    );
    const status = screen.getByText(/Waiting for speakers/);
    expect(status).toHaveTextContent("Waiting for speakers");
    expect(status).toHaveTextContent("Live in 2h 15m");
  });

  it("shows nothing extra when there's no countdown to show", () => {
    render(
      <RoomHeader eventTitle="E" roomStatus="live" countdownText={null} participantCount={2} connectionStatus="connected" />,
    );
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  describe("compact mode (real-device finding: mobile landscape has little vertical room to spare)", () => {
    it("shrinks the title/status text without removing any of the information", () => {
      render(
        <RoomHeader
          eventTitle="Late Night Debate"
          roomStatus="live"
          participantCount={42}
          connectionStatus="reconnecting"
          compact
        />,
      );
      expect(screen.getByRole("heading", { name: "Late Night Debate" }).className).toMatch(/\btext-sm\b/);
      expect(screen.getByText(/Live/)).toHaveTextContent("Reconnecting");
      expect(screen.getByText("42")).toBeInTheDocument();
    });

    it("defaults to the full (non-compact) size when the prop is omitted", () => {
      render(<RoomHeader eventTitle="E" roomStatus="live" participantCount={0} connectionStatus="connected" />);
      expect(screen.getByRole("heading", { name: "E" }).className).toMatch(/\btext-base\b/);
    });
  });
});
