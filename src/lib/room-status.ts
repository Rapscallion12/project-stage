/**
 * Purely a function of how many seats are currently occupied — see
 * DECISIONS.md's issue #3 entry for why the room's status is derived from
 * `event_speakers` (the authoritative occupancy record), never from
 * LiveKit's own participant/track state. A speaker muting their mic or
 * losing camera permission doesn't change how many seats are occupied, so
 * it doesn't change this.
 */
export type RoomStatus = "waiting" | "selecting" | "live";

export function getRoomStatus(activeSpeakerCount: number): RoomStatus {
  if (activeSpeakerCount >= 2) return "live";
  if (activeSpeakerCount === 1) return "selecting";
  return "waiting";
}

export const ROOM_STATUS_LABEL: Record<RoomStatus, string> = {
  waiting: "Waiting for speakers",
  selecting: "Selecting next speaker",
  live: "Live",
};
