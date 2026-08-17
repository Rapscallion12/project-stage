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
});
