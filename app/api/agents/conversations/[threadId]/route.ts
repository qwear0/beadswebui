import { agentsHistory } from "@/lib/agent-api";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ threadId: string }> }) {
  return agentsHistory(request, undefined, (await params).threadId);
}
