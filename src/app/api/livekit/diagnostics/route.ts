import { NextResponse } from "next/server";
import { getClient } from "@/lib/livekit/permissions";

/**
 * TEMPORARY — issue #15 real-device diagnosis (see DECISIONS.md). Proves
 * whether LIVEKIT_API_KEY/LIVEKIT_API_SECRET/NEXT_PUBLIC_LIVEKIT_URL are
 * not just *present* but actually *valid* against the real LiveKit Cloud
 * project, by making a genuine authenticated REST call
 * (RoomServiceClient.listRooms()) — token minting alone can't prove this,
 * since JWT signing never contacts LiveKit's servers at all. Reports only
 * success/failure and a generic error name/message, never the credentials
 * themselves. Remove once the real-device root cause is confirmed fixed.
 */
export async function GET() {
  let client: ReturnType<typeof getClient>;
  try {
    client = getClient();
  } catch (error) {
    return NextResponse.json({
      credentialsConfigured: false,
      reachable: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const rooms = await client.listRooms();
    return NextResponse.json({
      credentialsConfigured: true,
      reachable: true,
      roomCount: rooms.length,
    });
  } catch (error) {
    return NextResponse.json({
      credentialsConfigured: true,
      reachable: false,
      errorName: error instanceof Error ? error.name : "unknown",
      errorMessage: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    });
  }
}
