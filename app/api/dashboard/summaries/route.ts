import { ZodError } from "zod";
import { dashboardSummaryAction, DashboardSummaryUnavailable } from "@/lib/dashboard-summaries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const MAX_BODY_BYTES = 64 * 1024;
const noStore = { "Cache-Control": "no-store" };

async function readBody(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length && Number(length) > MAX_BODY_BYTES) throw new RangeError();
  if (!request.body) throw new SyntaxError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RangeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new SyntaxError(); }
}

export async function POST(request: Request) {
  try {
    const result = await dashboardSummaryAction(await readBody(request));
    return Response.json("ok" in result ? { ok: result.ok } : { items: result.items }, { status: result.status, headers: noStore });
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError || error instanceof RangeError) {
      return Response.json({ error: "Invalid input", code: "invalid_input" }, { status: 400, headers: noStore });
    }
    if (error instanceof DashboardSummaryUnavailable) {
      return Response.json({ error: "Dashboard summary service is temporarily unavailable", code: "service_unavailable", retryAfterMs: 5000 }, { status: 503, headers: { ...noStore, "Retry-After": "5" } });
    }
    return Response.json({ error: "Dashboard summary service is temporarily unavailable", code: "service_unavailable", retryAfterMs: 5000 }, { status: 503, headers: { ...noStore, "Retry-After": "5" } });
  }
}
