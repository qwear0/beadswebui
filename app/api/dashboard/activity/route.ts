import { dashboardActivity } from "@/lib/dashboard-activity";
import { AgentReadError } from "@/lib/agent-projection";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const cursor = params.get("cursor");
    if (params.getAll("cursor").length > 1 || cursor !== null && (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor))) return Response.json({ error: "Invalid cursor" }, { status: 400 });
    return Response.json(await dashboardActivity(cursor), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AgentReadError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
    return fail(error);
  }
}
