import "server-only";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DEFAULT_DASHBOARD_SETTINGS, type DashboardSettings } from "./dashboard-types";

export const dashboardSettingsSchema = z.object({
  model: z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9_.:/-]+$/),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]),
  prompt: z.string().trim().min(20).max(16000),
}).strict();

export function dashboardConfigDir() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "bead-me-up-scotty");
}

export async function getDashboardSettings(): Promise<DashboardSettings> {
  try {
    return dashboardSettingsSchema.parse(JSON.parse(await fs.readFile(path.join(dashboardConfigDir(), "dashboard.json"), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_DASHBOARD_SETTINGS };
    throw new Error("Dashboard settings cannot be read or are invalid");
  }
}

export async function saveDashboardSettings(value: unknown) {
  const settings = dashboardSettingsSchema.parse(value);
  const dir = dashboardConfigDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = path.join(dir, `.dashboard-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(settings, null, 2), { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, path.join(dir, "dashboard.json"));
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return settings;
}

/** Credentials are server-only, never part of the editable settings DTO. */
export async function neuroGateConnection() {
  const base = (process.env.NEURO_GATE_URL || "http://127.0.0.1:8080/v1").replace(/\/$/, "");
  let token = process.env.NEURO_GATE_TOKEN?.trim();
  if (!token) {
    try {
      token = (await fs.readFile(process.env.NEURO_GATE_TOKEN_FILE || path.join(dashboardConfigDir(), "neuro-gate-token"), "utf8")).trim();
    } catch { throw new Error("Neuro-gate consumer credential is not configured on the server"); }
  }
  if (!token) throw new Error("Neuro-gate consumer credential is empty");
  return { base, token };
}
