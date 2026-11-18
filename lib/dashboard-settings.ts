import "server-only";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DEFAULT_DASHBOARD_SETTINGS, defaultDashboardPeerModel, type DashboardSettings } from "./dashboard-types";

const modelSchema = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_.:/-]+$/);
export const dashboardSettingsSchema = z.object({
  model: modelSchema,
  peerModel: modelSchema.nullable().optional(),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]),
  prompt: z.string().trim().min(20).max(16000),
}).strict().transform(settings => ({
  ...settings,
  peerModel: settings.peerModel === undefined ? defaultDashboardPeerModel(settings.model) : settings.peerModel,
})).refine(settings => settings.peerModel === null || settings.peerModel !== settings.model, {
  message: "Peer model must be distinct from the primary model",
  path: ["peerModel"],
});

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

function providerName(model: string) {
  return /^([A-Za-z0-9_.-]+)\/.+/.exec(model)?.[1].toLowerCase();
}

// Older persisted selections are still readable; validate new selections.
const dashboardSettingsWriteSchema = dashboardSettingsSchema.refine(settings => {
  const provider = providerName(settings.model);
  return !provider || !settings.peerModel || providerName(settings.peerModel) !== provider;
}, { message: "Peer model must use a distinct provider", path: ["peerModel"] });

export async function saveDashboardSettings(value: unknown) {
  const settings = dashboardSettingsWriteSchema.parse(value);
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
