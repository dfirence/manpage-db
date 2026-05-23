/**
 * A single switch/flag for a command.
 * e.g. `-a`, `--all`
 */
export interface CommandSwitch {
  /** Short form, e.g. "-a" */
  short: string | null;
  /** Long form, e.g. "--all" */
  long: string | null;
  /** Human-readable description */
  description: string;
  /** Whether this switch accepts a value argument */
  takesValue: boolean;
  /** Placeholder name for the value if takesValue is true, e.g. "FILE" */
  valueName: string | null;
}

/**
 * A positional parameter (operand) for a command.
 * e.g. FILE, DIRECTORY, PATTERN
 */
export interface CommandParam {
  /** Name as shown in synopsis, e.g. "FILE", "PATTERN" */
  name: string;
  /** Whether this parameter is required */
  required: boolean;
  /** Whether this parameter can repeat (variadic) */
  repeatable: boolean;
  /** Human-readable description if available */
  description: string;
}

/**
 * Host OS information for provenance.
 */
export interface HostInfo {
  /** OS platform, e.g. "darwin", "linux" */
  platform: string;
  /** OS release version string */
  release: string;
  /** CPU architecture, e.g. "arm64", "x64" */
  arch: string;
  /** Hostname */
  hostname: string;
}

/**
 * Octal permission bit definition.
 */
export interface OctalMode {
  /** Octal value, e.g. "4000", "0755" */
  value: string;
  /** Description of what this bit enables */
  description: string;
}

/**
 * Symbolic mode grammar component.
 */
export interface SymbolicModeRule {
  /** Symbol character, e.g. "r", "w", "x", "+", "u" */
  symbol: string;
  /** Which grammar role: "who", "op", or "perm" */
  role: "who" | "op" | "perm";
  /** Description of the symbol */
  description: string;
}

/**
 * Parsed mode grammar for commands like chmod.
 */
export interface ModeGrammar {
  /** Raw BNF-style grammar if present */
  bnf: string[];
  /** Octal mode bits and their meanings */
  octalModes: OctalMode[];
  /** Symbolic mode symbols and their roles */
  symbolicRules: SymbolicModeRule[];
}

/**
 * A usage example from the EXAMPLES section or inline in option descriptions.
 */
export interface CommandExample {
  /** The command line invocation */
  command: string;
  /** Description of what the example does */
  description: string;
}

/**
 * Full structured entry for a single command.
 */
export interface CommandEntry {
  /** Command name, e.g. "ls" */
  name: string;
  /** Man page section, e.g. "1" */
  section: string;
  /** Raw synopsis line from man page */
  synopsis: string;
  /** Short one-line description (from NAME section) */
  description: string;
  /** Parsed switches/flags */
  switches: CommandSwitch[];
  /** Parsed positional parameters */
  params: CommandParam[];
  /** Usage examples */
  examples: CommandExample[];
  /** Path to the binary if resolved */
  binaryPath: string | null;
  /** Mode grammar if command accepts a mode operand (e.g. chmod) */
  modeGrammar: ModeGrammar | null;
  /** Host OS where this entry was generated */
  host: HostInfo;
}

/**
 * The full database structure.
 */
export interface ManPageDatabase {
  version: string;
  generatedAt: string;
  platform: string;
  commandCount: number;
  commands: Record<string, CommandEntry>;
}
