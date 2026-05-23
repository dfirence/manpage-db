import { exec } from "node:child_process";
import { readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { parseManPage } from "./parser.js";
import type { ManPageDatabase, CommandEntry } from "./types.js";

const execAsync = promisify(exec);

const BIN_DIRS = [
  "/bin",
  "/usr/bin",
  "/usr/local/bin",
  "/sbin",
  "/usr/sbin",
];

const DEFAULT_CONCURRENCY = 32;

/**
 * Discover all executable binary names from standard paths.
 */
function discoverCommands(): Set<string> {
  const commands = new Set<string>();

  for (const dir of BIN_DIRS) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        commands.add(entry);
      }
    } catch {
      // Permission denied or similar — skip
    }
  }

  return commands;
}

/**
 * Resolve the full binary path for a command (async).
 */
async function whichCommand(name: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`which ${name}`, { timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Fetch the raw man page text for a command (async).
 */
async function fetchManPage(name: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      `MANWIDTH=200 man ${name} 2>/dev/null | col -b | expand`,
      { maxBuffer: 1024 * 1024 * 5, timeout: 15000 }
    );
    return stdout || null;
  } catch {
    return null;
  }
}

/**
 * Detect which man section a command belongs to (async).
 */
async function detectSection(name: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`man -w ${name} 2>/dev/null`, {
      timeout: 5000,
    });
    const sectionMatch = stdout.trim().match(/\.(\d)\w*(?:\.gz)?$/);
    return sectionMatch?.[1] ?? "1";
  } catch {
    return "1";
  }
}

/**
 * Process a single command: fetch man page, parse, resolve binary path.
 */
async function processCommand(cmd: string): Promise<CommandEntry | null> {
  const text = await fetchManPage(cmd);
  if (!text) return null;

  const section = await detectSection(cmd);
  const entry = parseManPage(text, cmd, section);
  if (!entry) return null;

  entry.binaryPath = await whichCommand(cmd);
  return entry;
}

/**
 * Run tasks with bounded concurrency.
 * Yields results as they complete for memory efficiency.
 */
async function poolExecute<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );

  await Promise.all(workers);
  return results;
}

function parseArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const outputPath = parseArg(args, "--output")
    ?? resolve(import.meta.dirname ?? ".", "../db/manpages.json");

  const limitArg = parseArg(args, "--limit");
  const limit = limitArg ? parseInt(limitArg, 10) : undefined;

  const concurrencyArg = parseArg(args, "--concurrency");
  const concurrency = concurrencyArg
    ? parseInt(concurrencyArg, 10)
    : DEFAULT_CONCURRENCY;

  const filterArg = parseArg(args, "--filter");

  console.log("Discovering system binaries...");
  let commands = [...discoverCommands()].sort();

  if (filterArg) {
    const filterRegex = new RegExp(filterArg);
    commands = commands.filter((c) => filterRegex.test(c));
  }

  if (limit) {
    commands = commands.slice(0, limit);
  }

  console.log(
    `Found ${commands.length} commands. Parsing with concurrency=${concurrency}...`
  );

  const startTime = performance.now();
  let completed = 0;
  let failed = 0;

  const entries: Record<string, CommandEntry> = {};

  const results = await poolExecute(commands, concurrency, async (cmd, idx) => {
    const entry = await processCommand(cmd);

    completed++;
    if (completed % 100 === 0 || completed === commands.length) {
      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
      const rate = (completed / parseFloat(elapsed)).toFixed(0);
      process.stdout.write(
        `\r  [${completed}/${commands.length}] ${rate} cmd/s — ${elapsed}s elapsed`
      );
    }

    return entry;
  });

  for (let i = 0; i < commands.length; i++) {
    const entry = results[i];
    if (entry) {
      entries[commands[i]] = entry;
    } else {
      failed++;
    }
  }

  const database: ManPageDatabase = {
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    commandCount: Object.keys(entries).length,
    commands: entries,
  };

  const outDir = resolve(outputPath, "..");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outputPath, JSON.stringify(database, null, 2));

  const totalTime = ((performance.now() - startTime) / 1000).toFixed(2);
  console.log(
    `\n\nDone in ${totalTime}s. ${Object.keys(entries).length} commands parsed (${failed} skipped).`
  );
  console.log(`Database written to: ${outputPath}`);
}

main().catch((err) => {
  console.error("Generation failed:", err);
  process.exit(1);
});
