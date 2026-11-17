import { AgentReadError, canonicalStateRoot, readMessage, readRegistry } from "@/lib/agent-projection";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{ messageId: string }> }) {
  try {
    const { messageId } = await params;
    return Response.json(readMessage(canonicalStateRoot(), readRegistry(), messageId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AgentReadError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
    return fail(error);
  }
}
