# manpage-db

Structured JSON database of Unix/Linux man pages for system binaries.

Parses `man` output into a queryable database with:
- **Commands** — name, section, synopsis, description, binary path
- **Switches** — short/long flags, whether they take values
- **Params** — positional operands, required/optional/repeatable

## Setup

```bash
npm install
```

## Generate the database

```bash
# Full generation (all discoverable binaries)
npm run generate

# Limited run (first 50 commands)
npm run generate -- --limit 50

# Filter by regex
npm run generate -- --filter "^(ls|grep|find|awk|sed)$"

# Custom output path
npm run generate -- --output ./db/custom.json
```

## Query the database

```bash
# Find a specific command
npm run query -- find ls

# Search by name or description
npm run query -- search "file"

# Find commands that accept a specific flag
npm run query -- switch "-r"

# List all switches for a command
npm run query -- switches grep
```

## Database schema

```typescript
interface ManPageDatabase {
  version: string;
  generatedAt: string;
  platform: string;
  commandCount: number;
  commands: Record<string, CommandEntry>;
}
```

See `src/types.ts` for the full type definitions.

## Programmatic usage

```typescript
import { findCommand, searchCommands, findBySwitch } from "./src/query.js";
```
