import { z } from "zod";
import { fail } from "@/lib/api";
import { summarizeDashboardEvents } from "@/lib/dashboard-summaries";

export const dynamic = "force-dynamic";
const input = z.object({ events: z.array(z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), id: z.string().min(1).max(1024) }).strict()).min(1).max(4) }).strict();
export async function POST(request: Request) {
  try {
    const { events } = input.parse(await request.json());
    const unique = [...new Map(events.map(event => [event.key, event])).values()];
    return Response.json(await summarizeDashboardEvents(unique), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return fail(error); }
}
