-- pattern_v1.lua
-- Lua pattern fragments + explicit pattern builder helpers

local P = {}

-- ============================
-- Structural Lua pattern syntax
-- Used to build patterns, not to match literal characters.
-- ============================

local _capture_l = "("
local _capture_r = ")"

local _class_l   = "["
local _class_r   = "]"

local _frontier  = "%f"

-- ============================
-- Lua pattern fragments
-- Pattern-safe fragments for matching literal chars/classes.
-- ============================

P.fragment = {
  alpha          = "%a",
  ampersand      = "&",
  asterisk       = "%*",
  atsign         = "@",
  backslash      = "\\",
  backslash_dual = "\\\\",
  backtick       = "`",
  bracket_l      = "%[",
  bracket_r      = "%]",
  caret          = "%^",
  colon          = ":",
  comma          = ",",
  control        = "%c",
  curly_l        = "%{",
  curly_r        = "%}",
  dash           = "%-",
  digit          = "%d",
  dollar         = "%$",
  dot            = "%.",
  equals         = "=",
  exclamation    = "!",
  graph          = "%g",
  greater        = ">",
  hashtag        = "#",
  lesser         = "<",
  lower          = "%l",
  paren_l        = "%(",
  paren_r        = "%)",
  percent        = "%%",
  pipe           = "|",
  plus           = "%+",
  punctuation    = "%p",
  question       = "%?",
  quote_double   = '"',
  quote_single   = "'",
  semicolon      = ";",
  slash          = "/",
  space          = "%s",
  tilde          = "~",
  underscore     = "_",
  upper          = "%u",
  word           = "%w",
  xdigit         = "%x",
  zero           = "%z",

  not_alpha      = "%A",
  not_digit      = "%D",
  not_lower      = "%L",
  not_punct      = "%P",
  not_space      = "%S",
  not_upper      = "%U",
  not_word       = "%W",
  not_xdigit     = "%X",
  -- Homoglyphs
  acute_accent   = "´",
}

-- ============================
-- Pattern builder helpers
-- ============================

function P.pattern_sequence(...)
  return table.concat({ ... })
end

function P.pattern_one_of(...)
  return _class_l .. table.concat({ ... }) .. _class_r
end

function P.pattern_not_one_of(...)
  return _class_l .. P.fragment.caret .. table.concat({ ... }) .. _class_r
end

function P.pattern_optional(pattern)
  return pattern .. "?"
end

function P.pattern_zero_or_more(pattern)
  return pattern .. "*"
end

function P.pattern_one_or_more(pattern)
  return pattern .. "+"
end

function P.pattern_capture(pattern)
  return _capture_l .. pattern .. _capture_r
end

function P.pattern_frontier(pattern)
  return _frontier .. _class_l .. pattern .. _class_r
end

function P.pattern_literal(value)
  local pattern_magic_character = "([%^%$%(%)%%%.%[%]%*%+%-%?])"

  return (
    value:gsub(
      pattern_magic_character,
      "%%%1"
    )
  )
end

-- Semantic alternation for composed pattern concepts.
-- Evaluation treats this as "any of these patterns".
function P.pattern_set(...)
  return {
    patterns = { ... },
  }
end

function P.pattern_set_append(transform, values)
  if type(transform) ~= "function" then
    error("pattern_set_append: transform must be a function", 2)
  end

  if type(values) ~= "table" then
    error("pattern_set_append: values must be a table", 2)
  end

  local patterns = {}

  for i = 1, #values do
    patterns[i] = transform(values[i])
  end

  return P.set(table.unpack(patterns))
end

function P.pattern_repeat(pattern, count)
  if type(count) ~= "number" then
    error("pattern_repeat: count must be a number", 2)
  end

  if count <= 0 or count % 1 ~= 0 then
    error("pattern_repeat: count must be a positive integer", 2)
  end

  local parts = {}

  for i = 1, count do
    parts[i] = pattern
  end

  return table.concat(parts)
end

-- ============================
-- Evaluation: literal contains
-- Plain-byte matching. No Lua pattern semantics.
-- ============================

function P.contains(value, needle)
  return value:find(needle, 1, true) ~= nil
end

function P.contains_any(value, ...)
  for i = 1, select("#", ...) do
    if value:find(select(i, ...), 1, true) then
      return true
    end
  end

  return false
end

function P.contains_all(value, ...)
  for i = 1, select("#", ...) do
    if not value:find(select(i, ...), 1, true) then
      return false
    end
  end

  return true
end

-- ============================
-- Evaluation: pattern contains
-- Assumes trusted/compiled-valid Lua patterns.
--
-- Pattern values may be:
--   string                 -> direct Lua pattern
--   { patterns = { ... } } -> semantic pattern set, evaluated as any-of
-- ============================

local function pattern_found(value, pattern)
  if type(pattern) == "table" and type(pattern.patterns) == "table" then
    for i = 1, #pattern.patterns do
      if pattern_found(value, pattern.patterns[i]) then
        return true
      end
    end

    return false
  end

  return value:find(pattern) ~= nil
end

function P.contains_pattern(value, pattern)
  return pattern_found(value, pattern)
end

function P.contains_any_pattern(value, ...)
  for i = 1, select("#", ...) do
    if P.contains_pattern(value, select(i, ...)) then
      return true
    end
  end

  return false
end

function P.contains_all_pattern(value, ...)
  for i = 1, select("#", ...) do
    if not P.contains_pattern(value, select(i, ...)) then
      return false
    end
  end

  return true
end

-- ============================
-- Evaluation: pattern extract
-- Contract:
--   success -> table
--   failure -> false
--
-- Assumes trusted/compiled-valid Lua patterns.
-- ============================

function P.extract_pattern(value, pattern)
  local results = { value:match(pattern) }

  if #results == 0 then
    return false
  end

  return results
end

function P.extract_any_pattern(value, ...)
  for i = 1, select("#", ...) do
    local pattern = select(i, ...)

    if type(pattern) == "table" and type(pattern.patterns) == "table" then
      for j = 1, #pattern.patterns do
        local results = { value:match(pattern.patterns[j]) }

        if #results > 0 then
          return results
        end
      end
    else
      local results = { value:match(pattern) }

      if #results > 0 then
        return results
      end
    end
  end

  return false
end

function P.extract_all_pattern(value, pattern)
  local results = {}

  if type(pattern) == "table" and type(pattern.patterns) == "table" then
    for i = 1, #pattern.patterns do
      local partial = P.extract_all_pattern(value, pattern.patterns[i])

      if partial then
        for j = 1, #partial do
          results[#results + 1] = partial[j]
        end
      end
    end
  else
    for match in value:gmatch(pattern) do
      results[#results + 1] = match
    end
  end

  if #results == 0 then
    return false
  end

  return results
end

-- ============================
-- Evaluation: pattern replace
-- Contract:
--   success -> string
--
-- Assumes trusted/compiled-valid Lua patterns.
-- ============================

function P.replace_pattern(value, pattern, replacement)
  if type(pattern) == "table" and type(pattern.patterns) == "table" then
    local result = value

    for i = 1, #pattern.patterns do
      result = result:gsub(pattern.patterns[i], replacement)
    end

    return result
  end

  return value:gsub(pattern, replacement)
end

function P.replace_any_pattern(value, replacement, ...)
  local result = value

  for i = 1, select("#", ...) do
    result = P.replace_pattern(result, select(i, ...), replacement)
  end

  return result
end

function P.replace_all_pattern(value, replacements)
  local result = value

  for i = 1, #replacements do
    local pair = replacements[i]
    result = P.replace_pattern(result, pair[1], pair[2])
  end

  return result
end

-- Short aliases, still explicit enough for local grammar building.
P.capture    = P.pattern_capture
P.frontier   = P.pattern_frontier
P.literal    = P.pattern_literal
P.not_one    = P.pattern_not_one_of
P.one_of     = P.pattern_one_of
P.one_or     = P.pattern_one_or_more
P.optional   = P.pattern_optional
P.repeat_n   = P.pattern_repeat
P.sequence   = P.pattern_sequence
P.set        = P.pattern_set
P.set_append = P.pattern_set_append
P.zero_or    = P.pattern_zero_or_more

return P