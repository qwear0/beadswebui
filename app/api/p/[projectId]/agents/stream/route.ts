import { agentsStream } from "@/lib/agent-api";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  return agentsStream(request, (await params).projectId);
}
