#!/usr/bin/env bun
import { Command } from "commander";
import { exec } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { promisify } from "node:util";
import { parseManPage } from "./parser.js";
import type { ManPageDatabase, CommandEntry } from "./types.js";
import { importJsonl, openDb, queryLolbin, querySQL, resolveSqlitePath, LOLBIN_CATEGORIES } from "./db.js";
import type { LolbinCategory } from "./db.js";

const execAsync = promisify(exec);

const BIN_DIRS = ["/bin", "/usr/bin", "/usr/local/bin", "/sbin", "/usr/sbin"];
const DEFAULT_CONCURRENCY = 32;

// ─── Database helpers ──────────────────────────────────────────────────────────

function loadDatabase(dbPath: string): ManPageDatabase {
  const raw = readFileSync(dbPath, "utf8");
  const lines = raw.split("\n").filter(Boolean);

  // First line is the metadata header
  const header = JSON.parse(lines[0]);
  const commands: Record<string, CommandEntry> = {};

  // Remaining lines are individual command entries
  for (let i = 1; i < lines.length; i++) {
    const entry = JSON.parse(lines[i]) as CommandEntry;
    commands[entry.name] = entry;
  }

  return {
    version: header.version,
    generatedAt: header.generatedAt,
    platform: header.platform,
    commandCount: Object.keys(commands).length,
    commands,
  };
}

function resolveDbPath(opts: { db?: string }): string {
  if (opts.db) return resolve(opts.db);
  const candidates = [
    resolve(process.cwd(), "db/manpages.jsonl"),
    resolve(process.cwd(), "db/manpages.json"),
    resolve(process.cwd(), "manpages.jsonl"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

// ─── Generate logic ────────────────────────────────────────────────────────────

function discoverCommands(): Set<string> {
  const commands = new Set<string>();
  for (const dir of BIN_DIRS) {
    try {
      for (const f of readdirSync(dir)) {
        if (!f.startsWith(".")) commands.add(f);
      }
    } catch {}
  }
  return commands;
}

async function whichCommand(name: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`which ${name}`, { timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

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

async function detectSection(name: string): Promise<string> {
  try {
    const { stdout } = await execAsync(
      `man -w ${name} 2>/dev/null`,
      { timeout: 5000 }
    );
    const match = stdout.match(/man(\d)/);
    return match ? match[1] : "1";
  } catch {
    return "1";
  }
}

async function processCommand(cmd: string): Promise<CommandEntry | null> {
  const text = await fetchManPage(cmd);
  if (!text) return null;

  const section = await detectSection(cmd);
  const entry = parseManPage(text, cmd, section);
  if (!entry) return null;

  entry.binaryPath = await whichCommand(cmd);
  return entry;
}

async function poolExecute<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      results[idx] = await fn(items[idx], idx);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

// ─── CLI ───────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("manpage-db")
  .description("Man page database generator and query tool")
  .version("1.0.0")
  .option("-j, --json", "Output as JSON (pipe-friendly for jq)");

// ─── generate command ──────────────────────────────────────────────────────────

program
  .command("generate")
  .description("Parse man pages and generate the JSON database")
  .option("-o, --output <path>", "Output database path", "db/manpages.jsonl")
  .option("-f, --filter <regex>", "Filter commands by regex pattern")
  .option("-l, --limit <n>", "Limit number of commands to process")
  .option("-c, --concurrency <n>", "Number of concurrent workers", String(DEFAULT_CONCURRENCY))
  .action(async (opts) => {
    const outputPath = resolve(opts.output);
    const limit = opts.limit ? parseInt(opts.limit, 10) : undefined;
    const concurrency = parseInt(opts.concurrency, 10);

    console.log("Discovering system binaries...");
    let commands = [...discoverCommands()].sort();

    if (opts.filter) {
      const filterRegex = new RegExp(opts.filter);
      commands = commands.filter((c) => filterRegex.test(c));
    }

    if (limit) {
      commands = commands.slice(0, limit);
    }

    console.log(`Found ${commands.length} commands. Parsing with concurrency=${concurrency}...`);

    const startTime = performance.now();
    let completed = 0;
    let failed = 0;

    const results = await poolExecute(commands, concurrency, async (cmd) => {
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

    const entries: Record<string, CommandEntry> = {};
    for (let i = 0; i < commands.length; i++) {
      const entry = results[i];
      if (entry) {
        entries[commands[i]] = entry;
      } else {
        failed++;
      }
    }

    const header = {
      version: "1.0.0",
      generatedAt: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      commandCount: Object.keys(entries).length,
    };

    const outDir = dirname(outputPath);
    mkdirSync(outDir, { recursive: true });

    // Write JSONL: header line + one line per command
    const lines = [JSON.stringify(header)];
    for (const entry of Object.values(entries)) {
      lines.push(JSON.stringify(entry));
    }
    writeFileSync(outputPath, lines.join("\n") + "\n");

    const totalTime = ((performance.now() - startTime) / 1000).toFixed(2);
    console.log(
      `\n\nDone in ${totalTime}s. ${Object.keys(entries).length} commands parsed (${failed} skipped).`
    );
    console.log(`Database written to: ${outputPath}`);
  });

// ─── find command ──────────────────────────────────────────────────────────────

program
  .command("find <name>")
  .description("Find a command by exact name")
  .option("--db <path>", "Path to database file")
  .action((name, opts) => {
    const db = loadDatabase(resolveDbPath(opts));
    const entry = db.commands[name] ?? null;
    if (!entry) {
      console.error(`Command "${name}" not found.`);
      process.exit(1);
    }
    // find always outputs JSON (it's the primary data access command)
    console.log(JSON.stringify(entry, null, 2));
  });

// ─── search command ────────────────────────────────────────────────────────────

program
  .command("search <pattern>")
  .description("Search commands by name or description (regex)")
  .option("--db <path>", "Path to database file")
  .option("-n, --limit <n>", "Max results to show", "20")
  .action((pattern, opts) => {
    const json = program.opts().json;
    const db = loadDatabase(resolveDbPath(opts));
    const regex = new RegExp(pattern, "i");
    const results = Object.values(db.commands).filter(
      (cmd) => regex.test(cmd.name) || regex.test(cmd.description)
    ).slice(0, parseInt(opts.limit, 10));
    if (json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log(`Found ${results.length} commands:`);
      for (const r of results) {
        console.log(`  ${r.name} — ${r.description}`);
      }
    }
  });

// ─── switch command ────────────────────────────────────────────────────────────

program
  .command("switch <flag>")
  .description("Find commands that have a specific switch (e.g. -v, --verbose)")
  .option("--db <path>", "Path to database file")
  .action((flag, opts) => {
    const json = program.opts().json;
    const db = loadDatabase(resolveDbPath(opts));
    const results = Object.values(db.commands).filter((cmd) =>
      cmd.switches.some((sw) => sw.short === flag || sw.long === flag)
    );
    if (json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log(`Commands with "${flag}" (${results.length}):`);
      for (const r of results.slice(0, 30)) {
        console.log(`  ${r.name} — ${r.description}`);
      }
    }
  });

// ─── switches command ──────────────────────────────────────────────────────────

program
  .command("switches <command>")
  .description("List all switches for a given command")
  .option("--db <path>", "Path to database file")
  .action((commandName, opts) => {
    const json = program.opts().json;
    const db = loadDatabase(resolveDbPath(opts));
    const cmd = db.commands[commandName];
    if (!cmd) {
      console.error(`Command "${commandName}" not found.`);
      process.exit(1);
    }
    if (json) {
      console.log(JSON.stringify(cmd.switches, null, 2));
    } else {
      for (const sw of cmd.switches) {
        const flags = [sw.short, sw.long].filter(Boolean).join(", ");
        const val = sw.takesValue ? ` <${sw.valueName}>` : "";
        console.log(`  ${flags}${val}  ${sw.description.slice(0, 80)}`);
      }
    }
  });

// ─── examples command ──────────────────────────────────────────────────────────

program
  .command("examples <command>")
  .description("Show usage examples for a command")
  .option("--db <path>", "Path to database file")
  .action((commandName, opts) => {
    const json = program.opts().json;
    const db = loadDatabase(resolveDbPath(opts));
    const cmd = db.commands[commandName];
    if (!cmd) {
      console.error(`Command "${commandName}" not found.`);
      process.exit(1);
    }
    if (json) {
      console.log(JSON.stringify(cmd.examples, null, 2));
    } else {
      if (cmd.examples.length === 0) {
        console.log(`No examples found for "${commandName}".`);
        return;
      }
      for (const ex of cmd.examples) {
        if (ex.description) console.log(`  # ${ex.description}`);
        console.log(`  $ ${ex.command}\n`);
      }
    }
  });

// ─── import command ──────────────────────────────────────────────────────────

program
  .command("import")
  .description("Import JSONL database into SQLite for analysis")
  .option("--jsonl <path>", "Path to JSONL database file")
  .option("--out <path>", "Output SQLite database path", "db/manpages.db")
  .action((opts) => {
    const jsonlPath = opts.jsonl ? resolve(opts.jsonl) : resolveDbPath({});
    const sqlitePath = resolve(opts.out);

    console.log(`Importing ${jsonlPath} → ${sqlitePath}`);
    const db = importJsonl(jsonlPath, sqlitePath);

    const count = db.prepare("SELECT COUNT(*) AS n FROM commands").get() as any;
    const swCount = db.prepare("SELECT COUNT(*) AS n FROM switches").get() as any;
    const exCount = db.prepare("SELECT COUNT(*) AS n FROM examples").get() as any;

    console.log(`Imported: ${count.n} commands, ${swCount.n} switches, ${exCount.n} examples`);
    console.log(`SQLite database: ${sqlitePath}`);
    db.close();
  });

// ─── sql command ──────────────────────────────────────────────────────────────

program
  .command("sql <query>")
  .description("Run an arbitrary SQL query against the SQLite database")
  .option("--db <path>", "Path to SQLite database file")
  .action((query, opts) => {
    const db = openDb(resolveSqlitePath(opts));
    try {
      const results = querySQL(db, query);
      console.log(JSON.stringify(results, null, 2));
    } finally {
      db.close();
    }
  });

// ─── lolbin command ──────────────────────────────────────────────────────────

program
  .command("lolbin [category]")
  .description(`Query LOLBin categories: ${LOLBIN_CATEGORIES.join(", ")}`)
  .option("--db <path>", "Path to SQLite database file")
  .action((category, opts) => {
    const json = program.opts().json;
    const db = openDb(resolveSqlitePath(opts));

    try {
      if (!category || category === "list") {
        console.log("Available LOLBin categories:");
        for (const cat of LOLBIN_CATEGORIES) {
          const viewName = cat === "summary"
            ? "lolbin_summary"
            : `lolbin_${cat.replace(/-/g, "_")}`;
          const count = db.prepare(`SELECT COUNT(DISTINCT name) AS n FROM ${viewName}`).get() as any;
          console.log(`  ${cat} (${count.n} binaries)`);
        }
        return;
      }

      if (!LOLBIN_CATEGORIES.includes(category as LolbinCategory)) {
        console.error(`Unknown category "${category}". Available: ${LOLBIN_CATEGORIES.join(", ")}`);
        process.exit(1);
      }

      const results = queryLolbin(db, category as LolbinCategory);

      if (json || category === "summary") {
        console.log(JSON.stringify(results, null, 2));
      } else {
        // Group by command name for readable output
        const grouped = new Map<string, { desc: string; switches: string[] }>();
        for (const r of results) {
          if (!grouped.has(r.name)) {
            grouped.set(r.name, { desc: r.description, switches: [] });
          }
          const sw = [r.short, r.long].filter(Boolean).join(", ");
          if (sw) grouped.get(r.name)!.switches.push(sw);
        }

        console.log(`LOLBin category: ${category} (${grouped.size} binaries)\n`);
        for (const [name, info] of grouped) {
          const swList = info.switches.length > 0
            ? ` [${[...new Set(info.switches)].join("; ")}]`
            : "";
          console.log(`  ${name}${swList} — ${info.desc}`);
        }
      }
    } finally {
      db.close();
    }
  });

program.parse();
