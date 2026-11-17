import { getDashboardSettings, saveDashboardSettings } from "@/lib/dashboard-settings";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export async function GET() {
  try { return Response.json(await getDashboardSettings(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return fail(error); }
}
export async function PUT(request: Request) {
  try { return Response.json(await saveDashboardSettings(await request.json())); }
  catch (error) { return fail(error); }
}
