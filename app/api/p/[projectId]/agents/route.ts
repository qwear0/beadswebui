import { agentsSnapshot } from "@/lib/agent-api";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(_request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  return agentsSnapshot((await params).projectId);
}
