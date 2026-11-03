import { agentsHistory } from "@/lib/agent-api";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ projectId: string; threadId: string }> }) {
  const { projectId, threadId } = await params;
  return agentsHistory(request, projectId, threadId);
}
