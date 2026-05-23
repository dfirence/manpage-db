import { hostname, platform, release, arch } from "node:os";
import type { CommandEntry, CommandExample, CommandSwitch, CommandParam, HostInfo, ModeGrammar, OctalMode, SymbolicModeRule } from "./types.js";

const hostInfo: HostInfo = {
  platform: platform(),
  release: release(),
  arch: arch(),
  hostname: hostname(),
};

/**
 * Parse raw man page plain text into structured sections.
 */
function extractSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = text.split("\n");

  let currentSection = "";
  let currentContent: string[] = [];

  for (const line of lines) {
    // Section headers are lines that start at column 0, all uppercase or title case
    const sectionMatch = line.match(/^([A-Z][A-Z ]+)$/);
    if (sectionMatch) {
      if (currentSection) {
        sections.set(currentSection, currentContent.join("\n").trim());
      }
      currentSection = sectionMatch[1].trim();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  if (currentSection) {
    sections.set(currentSection, currentContent.join("\n").trim());
  }

  return sections;
}

/**
 * Parse the NAME section to get a short description.
 * Format is typically: "command - description"
 */
function parseDescription(nameSection: string): string {
  const match = nameSection.match(/^.*?\s+[-–—]\s+(.+)$/m);
  return match ? match[1].trim() : nameSection.trim();
}

/**
 * Parse the SYNOPSIS section for the raw synopsis string.
 */
function parseSynopsis(synopsisSection: string): string {
  return synopsisSection
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * Parse positional parameters from SYNOPSIS.
 * Looks for things like [FILE]..., PATTERN, <source>
 */
function parseParams(synopsis: string, commandName: string): CommandParam[] {
  const params: CommandParam[] = [];
  // Remove the command name prefix
  const afterCmd = synopsis.replace(new RegExp(`^\\s*${escapeRegex(commandName)}\\s*`), "");

  // Match uppercase operands like FILE, DIRECTORY, or [FILE]...
  // Require at least one vowel or underscore to filter out macOS-style flag clusters like "ABCFGH"
  const paramPattern = /(\[?)([A-Z][A-Z0-9_]{1,})\]?(\.\.\.)?/g;
  let match: RegExpExecArray | null;
  const seen = new Set<string>();

  const isLikelyFlagCluster = (s: string): boolean =>
    s.length > 4 && !/[_AEIOU]/.test(s.slice(1)) || /^[A-Z]{6,}$/.test(s) && !/[_]/.test(s);

  while ((match = paramPattern.exec(afterCmd)) !== null) {
    const name = match[2];
    // Skip common option-value placeholders that appear after switches
    if (seen.has(name)) continue;
    // Skip things that are clearly part of option descriptions
    if (["OPTION", "OPTIONS"].includes(name)) continue;
    // Skip macOS-style flag clusters (e.g. "ABCFGHILOPRSTUW")
    if (isLikelyFlagCluster(name)) continue;
    seen.add(name);

    params.push({
      name,
      required: match[1] !== "[",
      repeatable: match[3] === "...",
      description: "",
    });
  }

  return params;
}

/**
 * Parse switches/flags from the OPTIONS or DESCRIPTION section.
 * Handles all major man page formats:
 *
 * Style 1 — GNU inline:
 *   -a, --all          do not ignore entries starting with .
 *
 * Style 2 — Paragraph (curl, git):
 *       --abstract-unix-socket <path>
 *              (HTTP) Connect through an abstract Unix domain socket...
 *
 * Style 3 — BSD tagged:
 *     -Bmin n
 *             True if the difference...
 *
 * Style 4 — git-style (4-space indent + 8-space description):
 *       -v, --version
 *           Prints the Git suite version...
 */
function parseSwitches(optionsSection: string): CommandSwitch[] {
  const switches: CommandSwitch[] = [];
  const lines = optionsSection.split("\n");

  // Detect indentation style by scanning first few option lines
  const optLineIndents: number[] = [];
  for (const line of lines) {
    const m = line.match(/^(\s+)(--?[a-zA-Z])/);
    if (m) {
      optLineIndents.push(m[1].length);
      if (optLineIndents.length >= 10) break;
    }
  }
  const typicalOptIndent = optLineIndents.length > 0
    ? optLineIndents.sort((a, b) => a - b)[Math.floor(optLineIndents.length / 2)]
    : 4;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Detect an option line: starts with whitespace + dash (short or long option)
    // Value syntax handled:
    //   --option=<value>    --option=value
    //   --option <value>    -o <file name>
    //   --option VALUE      -n N  (uppercase short word = value placeholder)
    //   -Bmin n             -atime n[smhdw]  (find-style with lowercase placeholder)
    const optLineMatch = line.match(
      /^(\s+)(--?[\w][\w-]*(?:\s*[,|]\s*--?[\w][\w-]*)*(?:\s*=\s*(?:<[^>]+>|[\w./:[\]=-]+)|\s+<[^>]+>|\s+[A-Z][A-Z0-9_:]*(?:\[[\w:]+\])?(?![a-z])|\s+[-|+]?[a-z][\w[\]]*)?)\s*(.*)$/
    );

    if (optLineMatch && optLineMatch[2].match(/^--?[a-zA-Z]/)) {
      const indent = optLineMatch[1].length;
      const optPart = optLineMatch[2].trim();

      // Reject lines that are continuation prose at much deeper indent than typical options
      if (typicalOptIndent > 0 && indent > typicalOptIndent + 4) {
        i++;
        continue;
      }

      // Count how many option-like tokens are in the captured part
      // Real definitions have at most 2 (short + long), prose lists have many
      const optTokens = optPart.match(/--?[\w][\w-]*/g) ?? [];
      if (optTokens.length > 2) {
        i++;
        continue;
      }

      let desc = (optLineMatch[3] ?? "").trim();

      i++;

      // Gather description from continuation lines
      // Continuation = lines indented MORE than the option line, not starting with a new option
      while (i < lines.length) {
        const next = lines[i];

        // Empty line within a paragraph-style description — keep collecting
        // unless next non-empty line is a new option
        if (next.trim() === "") {
          // Look ahead: if next non-empty line is a new option, stop
          let lookahead = i + 1;
          while (lookahead < lines.length && lines[lookahead].trim() === "") {
            lookahead++;
          }
          if (lookahead >= lines.length) break;

          const nextNonEmpty = lines[lookahead];
          const isNewOpt = nextNonEmpty.match(/^\s+--?[a-zA-Z]/);
          const nextIndent = nextNonEmpty.match(/^(\s*)/)?.[1].length ?? 0;

          // New option at same or less indentation = stop
          if (isNewOpt && nextIndent <= indent + 2) break;

          // Otherwise it's a paragraph break within the description
          if (nextIndent > indent) {
            desc += "\n";
            i++;
            continue;
          }
          break;
        }

        const nextIndent = next.match(/^(\s*)/)?.[1].length ?? 0;

        // If next line is at deeper indentation, it's a description continuation
        if (nextIndent > indent && !next.match(/^\s+--?[a-zA-Z]\S*(?:\s*[,|]\s*--?[a-zA-Z])/)) {
          desc += (desc ? " " : "") + next.trim();
          i++;
        } else {
          break;
        }
      }

      const parsed = parseOptionString(optPart);
      if (parsed) {
        // Trim description: take first sentence/paragraph, cap at reasonable length
        switches.push({ ...parsed, description: desc.trim() });
      }
    } else {
      i++;
    }
  }

  return switches;
}

/**
 * Parse an option string into structured short/long/value components.
 * Handles all common formats:
 *   "-a, --all"
 *   "--color=WHEN"  "--color=<when>"
 *   "--cert <certificate[:password]>"
 *   "-o FILE"  "-D format"
 *   "-E, --cert <cert:pass>"
 */
function parseOptionString(
  raw: string
): Omit<CommandSwitch, "description"> | null {
  let short: string | null = null;
  let long: string | null = null;
  let takesValue = false;
  let valueName: string | null = null;

  // Separate the value portion (after = or the last <...> or uppercase word)
  // from the flags portion
  let flagsPart = raw;
  let valueRaw: string | null = null;

  // Check for =value syntax
  const eqMatch = raw.match(/^(.+?)=(.+)$/);
  if (eqMatch) {
    flagsPart = eqMatch[1];
    valueRaw = eqMatch[2];
  } else {
    // Check for <value> syntax (possibly with spaces inside)
    const angleMatch = raw.match(/^(.+?)\s+(<[^>]+>)$/);
    if (angleMatch) {
      flagsPart = angleMatch[1];
      valueRaw = angleMatch[2];
    } else {
      // Check for trailing UPPERCASE value placeholder (at least 2 chars to avoid
      // matching the start of a description like "Decode..." as value "D")
      const upperMatch = raw.match(/^(.+?)\s+([A-Z][A-Z0-9_:[\]]+(?:\[[\w:]+\])?)$/);
      if (upperMatch) {
        flagsPart = upperMatch[1];
        valueRaw = upperMatch[2];
      }
    }
  }

  if (valueRaw) {
    takesValue = true;
    valueName = valueRaw.replace(/[[\]<>]/g, "").trim();
  }

  // Split flags by comma or pipe separators
  const parts = flagsPart.split(/\s*[,|]\s*/);

  for (const part of parts) {
    const trimmed = part.trim();

    // Long option: --word-chars
    const longMatch = trimmed.match(/^(--[\w][\w-]*)$/);
    if (longMatch) {
      long = longMatch[1];
      continue;
    }

    // Short option: -X (single char)
    const shortMatch = trimmed.match(/^(-[a-zA-Z0-9:#])$/);
    if (shortMatch) {
      short = shortMatch[1];
      continue;
    }

    // Multi-char single-dash option: -Bmin, -acl, -atime (find-style primaries)
    const multiCharMatch = trimmed.match(/^(-[a-zA-Z][\w]+)$/);
    if (multiCharMatch) {
      // Treat as short option (find primaries are single-dash multi-char)
      short = multiCharMatch[1];
      continue;
    }

    // Short option with attached value: -D FORMAT, -c name=value
    const shortValMatch = trimmed.match(/^(-[a-zA-Z0-9])\s+(.+)$/);
    if (shortValMatch) {
      short = shortValMatch[1];
      if (!takesValue) {
        takesValue = true;
        valueName = shortValMatch[2].replace(/[[\]<>]/g, "").trim();
      }
      continue;
    }

    // Multi-char option with value: -Bmin n, -newer file
    const multiValMatch = trimmed.match(/^(-[a-zA-Z][\w]*)\s+(.+)$/);
    if (multiValMatch) {
      short = multiValMatch[1];
      if (!takesValue) {
        takesValue = true;
        valueName = multiValMatch[2].replace(/[[\]<>]/g, "").trim();
      }
      continue;
    }
  }

  if (!short && !long) return null;

  return { short, long, takesValue, valueName };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse the MODES section (present in chmod-style man pages).
 * Extracts BNF grammar, octal bit definitions, and symbolic mode rules.
 */
function parseModeGrammar(modesSection: string): ModeGrammar | null {
  if (!modesSection) return null;

  const lines = modesSection.split("\n");
  const bnf: string[] = [];
  const octalModes: OctalMode[] = [];
  const symbolicRules: SymbolicModeRule[] = [];

  // Extract BNF grammar lines (contain ::=)
  for (const line of lines) {
    const bnfMatch = line.match(/^\s+(\w+\s+::=.+)$/);
    if (bnfMatch) {
      bnf.push(bnfMatch[1].trim());
    }
  }

  // Extract octal mode definitions (lines starting with 4-digit octal number)
  for (let i = 0; i < lines.length; i++) {
    const octalMatch = lines[i].match(/^\s+([0-7]{4})\s+(.+)$/);
    if (octalMatch) {
      let desc = octalMatch[2].trim();
      // Gather continuation lines
      let j = i + 1;
      while (j < lines.length && lines[j].match(/^\s{16,}\S/) && !lines[j].match(/^\s+[0-7]{4}/)) {
        desc += " " + lines[j].trim();
        j++;
      }
      octalModes.push({ value: octalMatch[1], description: desc });
    }
  }

  // Extract symbolic mode rules from perm/who/op tables
  // who symbols
  const whoSymbols: Record<string, string> = { a: "ugo (all)", u: "user", g: "group", o: "other" };
  const opSymbols: Record<string, string> = { "+": "set bits", "-": "clear bits", "=": "assign exactly" };

  for (const [sym, desc] of Object.entries(whoSymbols)) {
    symbolicRules.push({ symbol: sym, role: "who", description: desc });
  }
  for (const [sym, desc] of Object.entries(opSymbols)) {
    symbolicRules.push({ symbol: sym, role: "op", description: desc });
  }

  // Parse perm symbol descriptions from the man page text
  const permDescriptions: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    // Match lines like:  r       The read bits.
    const permLine = lines[i].match(/^\s{8,}([rwxXstugoa])\s{2,}(.+)$/);
    if (permLine) {
      let desc = permLine[2].trim();
      // Gather continuation
      let j = i + 1;
      while (j < lines.length && lines[j].match(/^\s{16,}\S/) && !lines[j].match(/^\s{8,}[rwxXstugoa]\s{2,}/)) {
        desc += " " + lines[j].trim();
        j++;
      }
      permDescriptions[permLine[1]] = desc;
    }
  }

  // If we found perm descriptions, use them; otherwise use defaults
  const defaultPerms: Record<string, string> = {
    r: "The read bits.",
    w: "The write bits.",
    x: "The execute/search bits.",
    X: "Execute/search if directory or already executable.",
    s: "The set-user-ID and set-group-ID bits.",
    t: "The sticky bit.",
  };

  const perms = Object.keys(permDescriptions).length > 0 ? permDescriptions : defaultPerms;
  for (const [sym, desc] of Object.entries(perms)) {
    if (!whoSymbols[sym] && !opSymbols[sym]) {
      symbolicRules.push({ symbol: sym, role: "perm", description: desc });
    }
  }

  // Only return if we actually found meaningful content
  if (bnf.length === 0 && octalModes.length === 0 && symbolicRules.length <= 7) {
    return null;
  }

  return { bnf, octalModes, symbolicRules };
}

/**
 * Parse GNU coreutils-style mode grammar from DESCRIPTION prose.
 * GNU chmod documents modes inline:
 *   "The format of a symbolic mode is [ugoa...][[-+=][perms...]...]"
 *   "The letters rwxXst select file mode bits..."
 *   "A numeric mode is from one to four octal digits (0-7)..."
 */
function parseGnuModeGrammar(descriptionSection: string): ModeGrammar | null {
  if (!descriptionSection) return null;

  const text = descriptionSection;

  // Detect: must mention BOTH symbolic mode format AND octal/numeric mode
  // to distinguish from unrelated commands that happen to mention "octal"
  const hasSymbolicFormat = /\[ugoa[.\s]*\].*\[-\+=\]|\bformat of a symbolic mode\b/i.test(text);
  const hasOctalMode = /\b(?:octal|numeric) (?:mode|digit).*?\b(?:read|write|execute)\b/is.test(text);
  const hasPermLetters = /\bletters?\b.*?\brwx/i.test(text);
  if (!hasSymbolicFormat || !(hasOctalMode || hasPermLetters)) return null;

  const bnf: string[] = [];
  const octalModes: OctalMode[] = [];
  const symbolicRules: SymbolicModeRule[] = [];

  // Extract the symbolic format string as a pseudo-BNF
  const fmtMatch = text.match(/format of a symbolic mode is\s+(\[ugoa[^\n,;]*\])/i);
  if (fmtMatch) {
    bnf.push(`mode ::= ${fmtMatch[1].trim()}`);
  }

  // Parse who symbols from prose like "the user who owns it (u)"
  const whoMap: [string, RegExp][] = [
    ["u", /\buser who owns\b.*?\(u\)|\(u\).*?\bowner\b/i],
    ["g", /\busers in the file's group\b.*?\(g\)|\(g\).*?\bgroup\b/i],
    ["o", /\busers not in the file's group\b.*?\(o\)|\(o\).*?\bother\b/i],
    ["a", /\ball users\b.*?\(a\)|\(a\).*?\ball\b/i],
  ];
  for (const [sym, rx] of whoMap) {
    const m = text.match(rx);
    const defaultDescs: Record<string, string> = {
      u: "user (owner)", g: "group", o: "other", a: "all (ugo)"
    };
    symbolicRules.push({ symbol: sym, role: "who", description: m ? m[0].trim() : defaultDescs[sym] });
  }

  // Parse operator symbols from prose
  const opPatterns: [string, string, RegExp][] = [
    ["+", "add selected bits", /\+\s+causes.*?to be added/i],
    ["-", "remove selected bits", /-\s+causes.*?to be removed/i],
    ["=", "set exactly", /=\s+causes.*?to be added.*?removed/i],
  ];
  for (const [sym, defaultDesc, rx] of opPatterns) {
    symbolicRules.push({ symbol: sym, role: "op", description: defaultDesc });
  }

  // Parse perm symbols: "read (r), write (w), execute ... (x), ... (X), ... (s), ... (t)"
  const permDescs: [string, string][] = [
    ["r", "read"],
    ["w", "write"],
    ["x", "execute (or search for directories)"],
    ["X", "execute/search only if directory or already has execute permission"],
    ["s", "set user or group ID on execution"],
    ["t", "restricted deletion flag or sticky bit"],
  ];

  // Try to extract descriptions from prose like "read (r)"
  for (const [sym, defaultDesc] of permDescs) {
    let desc = defaultDesc;
    // Match patterns like "read (r)" or "execute/search ... (X)"
    const permRx = new RegExp(`([\\w/()\\s]{3,40})\\(${sym === "+" ? "\\+" : sym}\\)`, "i");
    const m = text.match(permRx);
    if (m) {
      desc = m[1].trim();
    }
    symbolicRules.push({ symbol: sym, role: "perm", description: desc });
  }

  // Parse numeric/octal mode description
  // GNU format: "first digit selects set user ID (4) and set group ID (2) and ... sticky (1)"
  // "second digit selects permissions for the user: read (4), write (2), and execute (1)"
  const octalDescs: [string, string][] = [
    ["4000", "set user ID on execution"],
    ["2000", "set group ID on execution"],
    ["1000", "restricted deletion flag or sticky bit"],
    ["0400", "read by owner"],
    ["0200", "write by owner"],
    ["0100", "execute by owner"],
    ["0040", "read by group"],
    ["0020", "write by group"],
    ["0010", "execute by group"],
    ["0004", "read by others"],
    ["0002", "write by others"],
    ["0001", "execute by others"],
  ];

  if (hasOctalMode) {
    for (const [val, desc] of octalDescs) {
      octalModes.push({ value: val, description: desc });
    }
  }

  if (symbolicRules.length <= 7 && octalModes.length === 0 && bnf.length === 0) {
    return null;
  }

  return { bnf, octalModes, symbolicRules };
}

/**
 * Parse the EXAMPLES section into structured examples.
 * Handles formats:
 *   Description text...
 *       command --example
 *
 *   command --example
 *       Description text...
 */
function parseExamples(examplesSection: string): CommandExample[] {
  if (!examplesSection) return [];

  const examples: CommandExample[] = [];
  const lines = examplesSection.split("\n");

  const isCommandLine = (l: string): boolean => {
    const t = l.trim();
    if (!t) return false;
    if (t.match(/^[$%#>]\s/)) return true;
    if (t.match(/\||\s>\s|;\s|&&|\$\(|`.*`/)) return true;
    if (t.match(/^[a-z./][a-z0-9_./-]*(\s|$)/)) return true;
    if (t.match(/^(sudo\s+)?[a-z][\w.-]*(\s|$)/)) return true;
    return false;
  };

  const getIndent = (l: string): number => l.match(/^(\s*)/)?.[1].length ?? 0;

  const gatherText = (start: number, minIndent: number): [string, number] => {
    let text = lines[start].trim();
    let j = start + 1;
    while (j < lines.length && lines[j].trim() &&
           getIndent(lines[j]) >= minIndent) {
      text += " " + lines[j].trim();
      j++;
    }
    return [text, j];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const indent = getIndent(line);
    const cmdLike = isCommandLine(line);

    // Format B: command first, then indented description (find-style)
    if (cmdLike) {
      let cmd = line.trim().replace(/^[$%#]\s+/, "");
      let j = i + 1;

      // Gather continuation command lines at same indent
      while (j < lines.length && lines[j].trim() &&
             getIndent(lines[j]) === indent && isCommandLine(lines[j])) {
        cmd += " " + lines[j].trim().replace(/^[$%#]\s+/, "");
        j++;
      }

      // Skip blank lines
      while (j < lines.length && !lines[j]?.trim()) j++;

      // Check if next block is more-indented description
      if (j < lines.length && getIndent(lines[j]) > indent && !isCommandLine(lines[j])) {
        const [desc, end] = gatherText(j, getIndent(lines[j]));
        examples.push({ command: cmd, description: desc });
        i = end;
      } else {
        examples.push({ command: cmd, description: "" });
        i = j;
      }
      continue;
    }

    // Format A: description first, then indented command (tar-style)
    if (!cmdLike) {
      let desc = line.trim();
      let j = i + 1;

      // Gather multi-line description at same/deeper indent
      while (j < lines.length && lines[j].trim() && !isCommandLine(lines[j]) &&
             getIndent(lines[j]) >= indent) {
        desc += " " + lines[j].trim();
        j++;
      }

      // Skip blank lines
      while (j < lines.length && !lines[j]?.trim()) j++;

      // Look for indented command
      if (j < lines.length && getIndent(lines[j]) > indent && isCommandLine(lines[j])) {
        let cmd = lines[j].trim().replace(/^[$%#]\s+/, "");
        const cmdIndent = getIndent(lines[j]);
        let k = j + 1;

        // Gather multi-line commands
        while (k < lines.length && lines[k].trim() &&
               getIndent(lines[k]) >= cmdIndent && isCommandLine(lines[k])) {
          cmd += " " + lines[k].trim().replace(/^[$%#]\s+/, "");
          k++;
        }

        examples.push({ command: cmd, description: desc });
        i = k;
      } else {
        // No command found — skip this block
        i = j > i + 1 ? j : i + 1;
      }
      continue;
    }

    i++;
  }

  return examples;
}

/**
 * Parse a full man page (plain text from `man <cmd> | col -b`) into a CommandEntry.
 */
export function parseManPage(
  text: string,
  commandName: string,
  section: string = "1"
): CommandEntry | null {
  if (!text.trim()) return null;

  const sections = extractSections(text);

  const nameSection = sections.get("NAME") ?? "";
  const synopsisSection = sections.get("SYNOPSIS") ?? "";
  const modesSection = sections.get("MODES") ?? "";

  // Scan multiple sections where options/switches may live
  const optionSectionNames = [
    "OPTIONS",
    "PRIMARIES",
    "OPERATORS",
    "FLAGS",
    "OPERANDS",
    "COMMANDS",
    "DESCRIPTION",
  ];

  let switches: CommandSwitch[] = [];
  const seenFlags = new Set<string>();

  for (const secName of optionSectionNames) {
    const content = sections.get(secName);
    if (!content) continue;

    const parsed = parseSwitches(content);
    for (const sw of parsed) {
      // De-duplicate across sections using a composite key
      const key = `${sw.short ?? ""}|${sw.long ?? ""}`;
      if (!seenFlags.has(key)) {
        seenFlags.add(key);
        switches.push(sw);
      }
    }

    // If we got results from OPTIONS or PRIMARIES, skip DESCRIPTION fallback
    if (parsed.length > 0 && (secName === "OPTIONS" || secName === "PRIMARIES")) {
      break;
    }
  }

  const description = parseDescription(nameSection);
  const synopsis = parseSynopsis(synopsisSection);
  const params = parseParams(synopsis, commandName);
  const descriptionSection = sections.get("DESCRIPTION") ?? "";
  const modeGrammar = parseModeGrammar(modesSection)
    ?? parseGnuModeGrammar(descriptionSection);
  const examplesSection = sections.get("EXAMPLES") ?? sections.get("EXAMPLE") ?? "";
  const examples = parseExamples(examplesSection);

  // Fallback: extract switches from SYNOPSIS if none found in structured sections
  if (switches.length === 0 && synopsisSection) {
    switches = parseSynopsisSwitches(synopsisSection);
  }

  return {
    name: commandName,
    section,
    synopsis: synopsis || `${commandName} [OPTIONS]`,
    description,
    switches,
    params,
    examples,
    binaryPath: null,
    modeGrammar,
    host: hostInfo,
  };
}

/**
 * Extract switches from the SYNOPSIS section as a fallback.
 * Handles patterns like:
 *   command [-abc] [-f file] [-o output] ...
 *   command [ -F fs ] [ -v var=value ] [ -f progfile ]
 */
function parseSynopsisSwitches(synopsisSection: string): CommandSwitch[] {
  const switches: CommandSwitch[] = [];
  const seen = new Set<string>();
  const text = synopsisSection.replace(/\n/g, " ");

  // Match bracketed option groups: [-abc], [ -f file ], [-o output]
  const bracketGroups = text.matchAll(/\[\s*(-[a-zA-Z0-9]+(?:\s+\S+)?)\s*\]/g);
  for (const m of bracketGroups) {
    const inner = m[1].trim();

    // Cluster of flags: -abc → individual -a, -b, -c
    const clusterMatch = inner.match(/^-([a-zA-Z0-9]+)$/);
    if (clusterMatch) {
      for (const ch of clusterMatch[1]) {
        const flag = `-${ch}`;
        if (!seen.has(flag)) {
          seen.add(flag);
          switches.push({
            short: flag,
            long: null,
            takesValue: false,
            valueName: null,
            description: "",
          });
        }
      }
      continue;
    }

    // Single flag with value: -f file, -F fs, -v var=value
    const flagValMatch = inner.match(/^(-[a-zA-Z0-9])\s+(.+)$/);
    if (flagValMatch) {
      const flag = flagValMatch[1];
      if (!seen.has(flag)) {
        seen.add(flag);
        switches.push({
          short: flag,
          long: null,
          takesValue: true,
          valueName: flagValMatch[2].replace(/[[\]<>]/g, "").trim(),
          description: "",
        });
      }
      continue;
    }
  }

  // Also match unbracketed flags in synopsis: command -flag
  const unbracketedFlags = text.matchAll(/(?:^|\s)(-[a-zA-Z](?:\s+\w+)?)\b/g);
  for (const m of unbracketedFlags) {
    const inner = m[1].trim();
    const flagMatch = inner.match(/^(-[a-zA-Z0-9])(?:\s+(\S+))?$/);
    if (flagMatch) {
      const flag = flagMatch[1];
      if (!seen.has(flag)) {
        seen.add(flag);
        switches.push({
          short: flag,
          long: null,
          takesValue: !!flagMatch[2],
          valueName: flagMatch[2]?.replace(/[[\]<>]/g, "").trim() ?? null,
          description: "",
        });
      }
    }
  }

  return switches;
}
