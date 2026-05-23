import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type { CommandEntry } from "./types.js";

// ─── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commands (
  name         TEXT PRIMARY KEY,
  section      TEXT NOT NULL,
  synopsis     TEXT NOT NULL,
  description  TEXT NOT NULL,
  binary_path  TEXT,
  platform     TEXT,
  hostname     TEXT
);

CREATE TABLE IF NOT EXISTS switches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  command     TEXT NOT NULL REFERENCES commands(name),
  short       TEXT,
  long        TEXT,
  takes_value INTEGER NOT NULL DEFAULT 0,
  value_name  TEXT,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS params (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  command     TEXT NOT NULL REFERENCES commands(name),
  name        TEXT NOT NULL,
  required    INTEGER NOT NULL DEFAULT 0,
  repeatable  INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS examples (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  command     TEXT NOT NULL REFERENCES commands(name),
  cmdline     TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_switches_command ON switches(command);
CREATE INDEX IF NOT EXISTS idx_switches_short   ON switches(short);
CREATE INDEX IF NOT EXISTS idx_switches_long    ON switches(long);
CREATE INDEX IF NOT EXISTS idx_params_command   ON params(command);
CREATE INDEX IF NOT EXISTS idx_examples_command ON examples(command);

-- Full-text search on descriptions and switch text
CREATE VIRTUAL TABLE IF NOT EXISTS commands_fts USING fts5(
  name, description, synopsis,
  content='commands', content_rowid='rowid'
);

CREATE VIRTUAL TABLE IF NOT EXISTS switches_fts USING fts5(
  command, short, long, description, value_name,
  content='switches', content_rowid='id'
);
`;

// ─── LOLBin Views ────────────────────────────────────────────────────────────

const LOLBIN_VIEWS = `
DROP VIEW IF EXISTS lolbin_file_copy;
DROP VIEW IF EXISTS lolbin_download;
DROP VIEW IF EXISTS lolbin_exec;
DROP VIEW IF EXISTS lolbin_file_read;
DROP VIEW IF EXISTS lolbin_encode;
DROP VIEW IF EXISTS lolbin_network;
DROP VIEW IF EXISTS lolbin_permissions;
DROP VIEW IF EXISTS lolbin_compile_interpret;
DROP VIEW IF EXISTS lolbin_summary;

-- Binaries that can copy / write files
CREATE VIEW lolbin_file_copy AS
SELECT DISTINCT c.name, c.description, c.binary_path,
  s.short, s.long, s.description AS switch_desc
FROM commands c
JOIN switches s ON s.command = c.name
WHERE s.description LIKE '%copy%'
   OR s.description LIKE '%output%file%'
   OR s.description LIKE '%write%to%'
   OR s.description LIKE '%destination%'
   OR c.description LIKE '%copy%file%'
   OR c.description LIKE '%archive%'
   OR c.name IN ('cp','dd','install','rsync','scp','ditto','pax','cpio','tee','cat');

-- Binaries that can download / fetch from network
CREATE VIEW lolbin_download AS
SELECT DISTINCT c.name, c.description, c.binary_path,
  s.short, s.long, s.description AS switch_desc
FROM commands c
JOIN switches s ON s.command = c.name
WHERE s.description LIKE '%url%'
   OR s.description LIKE '%http%'
   OR s.description LIKE '%download%'
   OR s.description LIKE '%fetch%from%'
   OR s.description LIKE '%remote file%'
   OR s.description LIKE '%remote server%'
   OR s.description LIKE '%remote host%'
   OR c.description LIKE '%transfer%URL%'
   OR c.description LIKE '%download%'
   OR c.description LIKE '%network downloader%'
   OR c.name IN ('curl','wget','ftp','scp','sftp','nc','fetch','rsync','aria2c');

-- Binaries that can execute other programs
CREATE VIEW lolbin_exec AS
SELECT DISTINCT c.name, c.description, c.binary_path,
  s.short, s.long, s.description AS switch_desc
FROM commands c
JOIN switches s ON s.command = c.name
WHERE s.description LIKE '%exec%command%'
   OR s.description LIKE '%run%command%'
   OR s.description LIKE '%shell%command%'
   OR s.description LIKE '%invoke%'
   OR s.long = '--exec'
   OR s.short = '-exec'
   OR c.description LIKE '%execute%command%'
   OR c.name IN ('xargs','env','nohup','nice','timeout','strace','ltrace');

-- Binaries that can read arbitrary files
CREATE VIEW lolbin_file_read AS
SELECT DISTINCT c.name, c.description, c.binary_path,
  s.short, s.long, s.description AS switch_desc
FROM commands c
JOIN switches s ON s.command = c.name
WHERE s.description LIKE '%read%file%'
   OR s.description LIKE '%input%file%'
   OR s.description LIKE '%from file%'
   OR c.description LIKE '%display%file%'
   OR c.description LIKE '%concatenate%'
   OR c.description LIKE '%print%file%'
   OR c.name IN ('cat','head','tail','less','more','strings','xxd','od','hexdump','base64');

-- Binaries that can encode / decode data
CREATE VIEW lolbin_encode AS
SELECT DISTINCT c.name, c.description, c.binary_path,
  s.short, s.long, s.description AS switch_desc
FROM commands c
JOIN switches s ON s.command = c.name
WHERE s.description LIKE '%encode%'
   OR s.description LIKE '%decode%'
   OR s.description LIKE '%base64%'
   OR s.description LIKE '%hex%'
   OR c.description LIKE '%encode%'
   OR c.description LIKE '%decode%'
   OR c.name IN ('base64','base32','xxd','uuencode','uudecode','openssl');

-- Binaries with network capabilities
CREATE VIEW lolbin_network AS
SELECT DISTINCT c.name, c.description, c.binary_path,
  s.short, s.long, s.description AS switch_desc
FROM commands c
JOIN switches s ON s.command = c.name
WHERE s.description LIKE '%connect to%'
   OR s.description LIKE '%listen%'
   OR s.description LIKE '%socket%'
   OR s.description LIKE '%TCP%port%'
   OR s.description LIKE '%UDP%port%'
   OR s.description LIKE '%bind%address%'
   OR s.description LIKE '%proxy%'
   OR c.description LIKE '%network%'
   OR c.description LIKE '%socket%'
   OR c.description LIKE '%TCP%'
   OR c.description LIKE '%UDP%'
   OR c.name IN ('nc','ncat','socat','ssh','telnet','curl','wget','ftp','openssl');

-- Binaries that can modify permissions / setuid
CREATE VIEW lolbin_permissions AS
SELECT DISTINCT c.name, c.description, c.binary_path,
  s.short, s.long, s.description AS switch_desc
FROM commands c
JOIN switches s ON s.command = c.name
WHERE s.description LIKE '%permission%'
   OR s.description LIKE '%owner%'
   OR s.description LIKE '%setuid%'
   OR s.description LIKE '%suid%'
   OR s.description LIKE '%mode%'
   OR c.description LIKE '%permission%'
   OR c.description LIKE '%mode%'
   OR c.name IN ('chmod','chown','chgrp','install','setfacl');

-- Binaries that can compile or interpret code
CREATE VIEW lolbin_compile_interpret AS
SELECT DISTINCT c.name, c.description, c.binary_path
FROM commands c
WHERE c.description LIKE '%compiler%'
   OR c.description LIKE '%interpreter%'
   OR c.description LIKE '%scripting%'
   OR c.description LIKE '%evaluate%'
   OR c.name IN ('python','python3','perl','ruby','node','lua','awk','sed','bash','sh','zsh','tclsh','expect','php','gcc','cc','g++','clang','make','cmake');

-- Summary: all potential LOLBin categories per command
CREATE VIEW lolbin_summary AS
SELECT name, group_concat(DISTINCT category) AS categories FROM (
  SELECT name, 'file-copy'   AS category FROM lolbin_file_copy
  UNION ALL
  SELECT name, 'download'    AS category FROM lolbin_download
  UNION ALL
  SELECT name, 'exec'        AS category FROM lolbin_exec
  UNION ALL
  SELECT name, 'file-read'   AS category FROM lolbin_file_read
  UNION ALL
  SELECT name, 'encode'      AS category FROM lolbin_encode
  UNION ALL
  SELECT name, 'network'     AS category FROM lolbin_network
  UNION ALL
  SELECT name, 'permissions' AS category FROM lolbin_permissions
  UNION ALL
  SELECT name, 'compile-interpret' AS category FROM lolbin_compile_interpret
) GROUP BY name
ORDER BY name;
`;

// ─── Import ──────────────────────────────────────────────────────────────────

export function importJsonl(jsonlPath: string, sqlitePath: string): Database {
  const db = new Database(sqlitePath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec(SCHEMA);
  db.exec(LOLBIN_VIEWS);

  const raw = readFileSync(jsonlPath, "utf8");
  const lines = raw.split("\n").filter(Boolean);

  // First line is metadata header
  const header = JSON.parse(lines[0]);
  const insertMeta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  const insertCmd = db.prepare(
    "INSERT OR REPLACE INTO commands (name, section, synopsis, description, binary_path, platform, hostname) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const insertSwitch = db.prepare(
    "INSERT INTO switches (command, short, long, takes_value, value_name, description) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const insertParam = db.prepare(
    "INSERT INTO params (command, name, required, repeatable, description) VALUES (?, ?, ?, ?, ?)"
  );
  const insertExample = db.prepare(
    "INSERT INTO examples (command, cmdline, description) VALUES (?, ?, ?)"
  );

  const importAll = db.transaction(() => {
    // Clear existing data
    db.exec("DELETE FROM examples; DELETE FROM params; DELETE FROM switches; DELETE FROM commands; DELETE FROM meta;");

    insertMeta.run("version", header.version ?? "1.0.0");
    insertMeta.run("generatedAt", header.generatedAt ?? new Date().toISOString());
    insertMeta.run("platform", header.platform ?? "unknown");
    insertMeta.run("commandCount", String(header.commandCount ?? 0));

    let count = 0;
    for (let i = 1; i < lines.length; i++) {
      const entry = JSON.parse(lines[i]) as CommandEntry;

      insertCmd.run(
        entry.name,
        entry.section,
        entry.synopsis,
        entry.description,
        entry.binaryPath,
        entry.host?.platform ?? null,
        entry.host?.hostname ?? null
      );

      for (const sw of entry.switches) {
        insertSwitch.run(
          entry.name,
          sw.short,
          sw.long,
          sw.takesValue ? 1 : 0,
          sw.valueName,
          sw.description
        );
      }

      for (const p of entry.params) {
        insertParam.run(
          entry.name,
          p.name,
          p.required ? 1 : 0,
          p.repeatable ? 1 : 0,
          p.description
        );
      }

      for (const ex of entry.examples) {
        insertExample.run(entry.name, ex.command, ex.description);
      }

      count++;
    }

    // Populate FTS indexes
    db.exec("INSERT INTO commands_fts(commands_fts) VALUES('rebuild')");
    db.exec("INSERT INTO switches_fts(switches_fts) VALUES('rebuild')");

    return count;
  });

  const count = importAll();
  return db;
}

// ─── Query helpers ───────────────────────────────────────────────────────────

export function openDb(sqlitePath: string): Database {
  return new Database(sqlitePath, { readonly: true });
}

export const LOLBIN_CATEGORIES = [
  "file-copy",
  "download",
  "exec",
  "file-read",
  "encode",
  "network",
  "permissions",
  "compile-interpret",
  "summary",
] as const;

export type LolbinCategory = (typeof LOLBIN_CATEGORIES)[number];

export function queryLolbin(db: Database, category: LolbinCategory): any[] {
  const viewName = category === "summary"
    ? "lolbin_summary"
    : `lolbin_${category.replace(/-/g, "_")}`;

  return db.prepare(`SELECT * FROM ${viewName}`).all();
}

export function querySQL(db: Database, sql: string): any[] {
  return db.prepare(sql).all();
}

export function resolveSqlitePath(opts: { db?: string }): string {
  if (opts.db) return opts.db;
  const { resolve: r } = require("node:path");
  const { existsSync } = require("node:fs");
  const candidates = [
    r(process.cwd(), "db/manpages.db"),
    r(process.cwd(), "manpages.db"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}
