import "server-only";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { promisify } from "node:util";
import {
  beadSchema,
  commentSchema,
  unwrapEnvelope,
  type Bead,
  type CreateInput,
  type UpdateInput,
  type DepType,
} from "./schema";
import type { BeadsStore, DoctorInfo } from "./store";

const pExecFile = promisify(execFile);
const BD_BIN = process.env.BD_BIN || "bd";

export class BdError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "BdError";
    this.code = code;
  }
}

/**
 * Run a bd command. Args are passed as an array (no shell) so titles and
 * descriptions are injection-safe. Always requests the JSON envelope.
 */
async function runBdBytes(
  args: string[],
  opts: { repoPath: string; actor?: string },
): Promise<Buffer> {
  try {
    const { stdout } = await pExecFile(BD_BIN, args, {
      cwd: opts.repoPath,
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        BD_JSON_ENVELOPE: "1",
        ...(opts.actor ? { BEADS_ACTOR: opts.actor } : {}),
      },
    });
    return stdout;
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer; message?: string };
    // bd emits a JSON error object to stderr with a `code` when --json is active.
    const stderr = e.stderr?.toString("utf8").trim() ?? "";
    try {
      const parsed = JSON.parse(stderr) as { error?: string; code?: string };
      if (parsed.error) throw new BdError(parsed.error, parsed.code);
    } catch (parseErr) {
      if (parseErr instanceof BdError) throw parseErr;
    }
    // bd emits the pending-migration block as PLAIN-TEXT stderr, not the JSON
    // envelope, so it would otherwise fall through uncoded and dump ~200 words
    // of raw text into a toast. Tag it here so the UI keys off a stable code
    // rather than string-matching in React. (gastownhall/beads#4259)
    if (/pending schema migration|BD_ALLOW_REMOTE_MIGRATE|#4259/i.test(stderr)) {
      throw new BdError(stderr, "schema_migration_required");
    }
    throw new BdError(stderr || e.message || "bd command failed");
  }
}

async function runBdRaw(args: string[], opts: { repoPath: string; actor?: string }): Promise<string> {
  return (await runBdBytes(args, opts)).toString("utf8");
}

async function runBdJson<T = unknown>(
  args: string[],
  opts: { repoPath: string; actor?: string },
): Promise<T> {
  const out = await runBdRaw([...args, "--json"], opts);
  return unwrapEnvelope(JSON.parse(out)) as T;
}

const dashboardComments = z.array(commentSchema.extend({
  author: z.string(),
  text: z.string(),
  created_at: z.string().refine(at => Number.isFinite(Date.parse(at))),
}));

/** Parse `bd export --json` JSONL output into validated beads. */
function parseExport(bytes: Buffer, strict = false, gatesOnly = false): Bead[] {
  const jsonl = strict ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : bytes.toString("utf8");
  const badExport = () => new BdError("Incomplete or invalid bd issue export", "parse_error");
  // bd writes a newline after each complete record (an empty export is valid).
  if (strict && jsonl && !jsonl.endsWith("\n")) throw badExport();
  const ids = new Set<string>();
  const beads: Bead[] = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      if (strict) throw badExport();
      continue;
    }
    const record = obj as Record<string, unknown> | null;
    // Inclusive exports also contain explicitly marked non-issue memories.
    if (record?._type === "memory" && typeof record.key === "string" && typeof record.value === "string" && !("issue_type" in record)) continue;
    if (!strict && gatesOnly && record?.issue_type !== "gate") continue;
    const parsed = beadSchema.safeParse(obj);
    if (parsed.success && parsed.data.issue_type) {
      const bead = parsed.data;
      if (strict && (!bead.id || !bead.status || ids.has(bead.id)
        || (bead.comment_count !== undefined && bead.comment_count !== bead.comments.length)
        || (record?.comments !== undefined && !dashboardComments.safeParse(record.comments).success))) throw badExport();
      if (strict) ids.add(bead.id);
      if (!gatesOnly || bead.issue_type === "gate") beads.push(bead);
    } else if (strict) throw badExport();
  }
  return beads;
}

// ---- bd serialization (embedded Dolt is single-writer *per database*) ----
// EVERY bd invocation — including read-only `export`/`show` — rewrites the
// embedded-Dolt store, so reads MUST serialize with writes too. Running them
// concurrently corrupts persists ("Unable to write SST file …") and collides on
// compaction ("Another write batch or compaction is already active").
// Keyed by repoPath so same-project bd calls serialize while different projects
// run in parallel.
const writeChains = new Map<string, Promise<unknown>>();
function serializeWrite<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(repoPath) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  writeChains.set(
    repoPath,
    next.catch(() => {}),
  );
  return next;
}

const availabilityCache = new Map<string, boolean>();

export async function isBdAvailable(repoPath: string): Promise<boolean> {
  const hit = availabilityCache.get(repoPath);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    await pExecFile(BD_BIN, ["--version"], { timeout: 5000 });
    ok = fs.existsSync(path.join(repoPath, ".beads"));
  } catch {
    ok = false;
  }
  availabilityCache.set(repoPath, ok);
  return ok;
}

// Share the active CLI read by exact registered path, while allowing Dashboard
// authority to reject malformed output that ordinary board reads tolerate.
const inflightExports = new Map<string, Promise<[Buffer, Buffer]>>();
async function listByPath(repoPath: string, strict = false): Promise<Bead[]> {
  let read = inflightExports.get(repoPath);
  if (!read) {
    read = serializeWrite(repoPath, async () => [
      await runBdBytes(["export", "--json"], { repoPath }),
      await runBdBytes(["export", "--all", "--json"], { repoPath }),
    ]);
    inflightExports.set(repoPath, read);
    const clear = () => { inflightExports.delete(repoPath); };
    void read.then(clear, clear);
  }
  const [regular, inclusive] = await read;
  const beads = parseExport(regular, strict);
  // Add gates hidden by infra filters, including closed dependency targets.
  const gates = parseExport(inclusive, strict, true);
  const byId = new Map(beads.map(bead => [bead.id, bead]));
  for (const gate of gates) byId.set(gate.id, gate);
  return [...byId.values()];
}

export function readDashboardBeads(repoPath: string): Promise<Bead[]> {
  if (!fs.statSync(path.join(repoPath, ".beads")).isDirectory()) throw new BdError("Missing project .beads directory");
  return listByPath(repoPath, true);
}

export function readDashboardBeadComments(repoPath: string, id: string) {
  return serializeWrite(repoPath, async () => {
    const data = await runBdBytes(["comments", "--json", "--", id], { repoPath });
    return dashboardComments.parse(
      unwrapEnvelope(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data))),
    );
  });
}

export function createBdStore(repoPath: string): BeadsStore {
  const ro = { repoPath };
  const rw = (actor: string) => ({ repoPath, actor });
  // Collapse concurrent list() callers (the polling views) onto one collection read.
  let inflightList: Promise<Bead[]> | null = null;

  async function show(id: string): Promise<Bead> {
    // bd 1.0.5 `show <id> --json` returns its envelope `data` as an ARRAY even
    // for a single id, while beadSchema expects one object. Unwrap before parse.
    const data = await runBdJson(["show", id], ro);
    const rec = Array.isArray(data) ? data[0] : data;
    if (!rec) throw new BdError(`bead ${id} not found`, "not_found");
    const parsed = beadSchema.safeParse(rec);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw new BdError(`could not parse bead ${id}: ${detail}`, "parse_error");
    }
    return parsed.data;
  }

  return {
    kind: "bd",

    async list() {
      if (inflightList) return inflightList;
      inflightList = listByPath(repoPath);
      try {
        return await inflightList;
      } finally {
        inflightList = null;
      }
    },

    async get(id) {
      // Serialized too — `bd show` rewrites the store like any other invocation.
      return serializeWrite(repoPath, async () => {
        try {
          return await show(id);
        } catch (e) {
          if (e instanceof BdError && e.code === "not_found") return null;
          throw e;
        }
      });
    },

    create(input: CreateInput, actor: string) {
      return serializeWrite(repoPath, async () => {
        const args = [
          "create",
          input.title,
          "-t",
          input.issue_type,
          "--priority",
          String(input.priority),
        ];
        if (input.description) args.push("--description", input.description);
        if (input.assignee) args.push("--assignee", input.assignee);
        if (input.labels?.length) args.push("-l", input.labels.join(","));
        if (input.parent) args.push("--parent", input.parent);
        const created = await runBdJson<{ id: string }>(args, rw(actor));
        const id = created.id;
        if (input.backlog) {
          await runBdRaw(["update", id, "-s", "deferred"], rw(actor));
        }
        return show(id);
      });
    },

    update(id, patch: UpdateInput, actor: string) {
      return serializeWrite(repoPath, async () => {
        const args = ["update", id];
        if (patch.title !== undefined) args.push("--title", patch.title);
        if (patch.description !== undefined) args.push("--description", patch.description);
        if (patch.status !== undefined) args.push("-s", patch.status);
        if (patch.priority !== undefined) args.push("--priority", String(patch.priority));
        if (patch.issue_type !== undefined) args.push("-t", patch.issue_type);
        if (patch.assignee !== undefined) args.push("--assignee", patch.assignee);
        // `!== undefined` rather than a truthiness check: `""` is the detach
        // signal, so `if (patch.parent)` would make detaching inexpressible.
        if (patch.parent !== undefined) args.push("--parent", patch.parent);
        // Labels are replace-all. `bd update --set-labels ""` is silently
        // dropped (verified against bd 1.1.0) — an empty value never clears —
        // so the "remove every label" case has to go through --remove-label
        // with the bead's current labels instead.
        if (patch.labels !== undefined) {
          if (patch.labels.length) {
            args.push("--set-labels", patch.labels.join(","));
          } else {
            const current = (await show(id)).labels ?? [];
            if (current.length) args.push("--remove-label", current.join(","));
          }
        }
        // `bd update <id>` with no field flags is a no-op error; skip the call
        // when clearing labels on a bead that had none.
        if (args.length > 2) await runBdRaw(args, rw(actor));
        return show(id);
      });
    },

    setStatus(id, status, actor, reason) {
      return serializeWrite(repoPath, async () => {
        if (status === "closed") {
          const args = ["close", id];
          // Only `bd close --reason` persists a close reason, and re-closing an
          // already-closed bead won't overwrite it — so this is the one chance
          // to record why. Args go through execFile, so prose is safe verbatim.
          const trimmed = reason?.trim();
          if (trimmed) args.push("--reason", trimmed);
          await runBdRaw(args, rw(actor));
        } else {
          await runBdRaw(["update", id, "-s", status], rw(actor));
        }
        return show(id);
      });
    },

    remove(id, actor) {
      return serializeWrite(repoPath, async () => {
        await runBdRaw(["delete", id, "--force"], rw(actor));
      });
    },

    addComment(id, text, actor) {
      return serializeWrite(repoPath, async () => {
        await runBdRaw(["comment", id, text], rw(actor));
        return show(id);
      });
    },

    addDep(id, dependsOnId, type: DepType, actor) {
      return serializeWrite(repoPath, async () => {
        await runBdRaw(["dep", "add", id, dependsOnId, "-t", type], rw(actor));
        return show(id);
      });
    },

    removeDep(id, dependsOnId, actor) {
      return serializeWrite(repoPath, async () => {
        await runBdRaw(["dep", "remove", id, dependsOnId], rw(actor));
        return show(id);
      });
    },

    createGate(blocks, reason, actor) {
      return serializeWrite(repoPath, async () => {
        const args = ["gate", "create", "--type", "human", "--blocks", blocks];
        if (reason) args.push("--reason", reason);
        // `bd gate create --json` returns the created gate object (incl. its id).
        const created = await runBdJson<{ id: string }>(args, rw(actor));
        return show(created.id);
      });
    },

    removeLabel(id, label, actor) {
      return serializeWrite(repoPath, async () => {
        await runBdRaw(["update", id, "--remove-label", label], rw(actor));
        return show(id);
      });
    },

    archive(id, actor) {
      return serializeWrite(repoPath, async () => {
        await runBdRaw(["close", id], rw(actor));
        await runBdRaw(["label", "add", id, "archived"], rw(actor));
        return show(id);
      });
    },

    async doctor(): Promise<DoctorInfo> {
      try {
        const { stdout } = await pExecFile(BD_BIN, ["--version"], { cwd: repoPath });
        return {
          kind: "bd",
          ok: true,
          version: stdout.trim(),
          repoPath,
          message: `Connected to bd at ${repoPath}`,
        };
      } catch (e) {
        return {
          kind: "bd",
          ok: false,
          repoPath,
          message: (e as Error).message,
        };
      }
    },
  };
}
