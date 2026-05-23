import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ManPageDatabase, CommandEntry } from "./types.js";

function loadDatabase(path?: string): ManPageDatabase {
  const dbPath = path ?? resolve(import.meta.dirname ?? ".", "../db/manpages.json");
  const raw = readFileSync(dbPath, "utf8");
  return JSON.parse(raw) as ManPageDatabase;
}

/**
 * Find a command by exact name.
 */
export function findCommand(db: ManPageDatabase, name: string): CommandEntry | null {
  return db.commands[name] ?? null;
}

/**
 * Search commands by partial name match.
 */
export function searchCommands(db: ManPageDatabase, query: string): CommandEntry[] {
  const regex = new RegExp(query, "i");
  return Object.values(db.commands).filter(
    (cmd) => regex.test(cmd.name) || regex.test(cmd.description)
  );
}

/**
 * Find commands that have a specific switch (short or long form).
 */
export function findBySwitch(db: ManPageDatabase, flag: string): CommandEntry[] {
  return Object.values(db.commands).filter((cmd) =>
    cmd.switches.some((sw) => sw.short === flag || sw.long === flag)
  );
}

/**
 * Find commands that accept a specific parameter name.
 */
export function findByParam(db: ManPageDatabase, paramName: string): CommandEntry[] {
  const regex = new RegExp(paramName, "i");
  return Object.values(db.commands).filter((cmd) =>
    cmd.params.some((p) => regex.test(p.name))
  );
}

/**
 * Get all switches for a given command.
 */
export function listSwitches(db: ManPageDatabase, commandName: string) {
  const cmd = db.commands[commandName];
  if (!cmd) return null;
  return cmd.switches;
}

// CLI interface
function main() {
  const args = process.argv.slice(2);
  const dbPath = args.includes("--db")
    ? args[args.indexOf("--db") + 1]
    : undefined;

  const db = loadDatabase(dbPath);

  const action = args[0];

  switch (action) {
    case "find": {
      const name = args[1];
      const result = findCommand(db, name);
      if (result) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Command "${name}" not found.`);
      }
      break;
    }

    case "search": {
      const query = args[1];
      const results = searchCommands(db, query);
      console.log(`Found ${results.length} commands:`);
      for (const r of results.slice(0, 20)) {
        console.log(`  ${r.name} - ${r.description}`);
      }
      break;
    }

    case "switch": {
      const flag = args[1];
      const results = findBySwitch(db, flag);
      console.log(`Commands with switch "${flag}" (${results.length}):`);
      for (const r of results.slice(0, 20)) {
        console.log(`  ${r.name}`);
      }
      break;
    }

    case "switches": {
      const cmd = args[1];
      const switches = listSwitches(db, cmd);
      if (!switches) {
        console.log(`Command "${cmd}" not found.`);
      } else {
        for (const sw of switches) {
          const flags = [sw.short, sw.long].filter(Boolean).join(", ");
          const val = sw.takesValue ? ` ${sw.valueName}` : "";
          console.log(`  ${flags}${val}  ${sw.description}`);
        }
      }
      break;
    }

    default:
      console.log(`Usage:
  query find <command>       Find a command by name
  query search <pattern>    Search commands by name/description
  query switch <flag>       Find commands that use a switch
  query switches <command>  List all switches for a command`);
  }
}

main();
