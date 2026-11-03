import { agentsSnapshot } from "@/lib/agent-api";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET() { return agentsSnapshot(); }
