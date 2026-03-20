---
name: lua-scripting
version: 1.1.0
type: domain-skill
domains: [lua, game, scripting]
dependencies: []
load_level: task
max_tokens: 800
triggers:
  keywords: [lua, luajit, coroutine, metatables, unity lua, xlua]
  roles: [developer]
description: "Lua scripting patterns for game engines"
---
# Skill: lua-scripting

> **Type**: Domain Skill
> **Version**: 1.1.0
> **Description**: Lua scripting patterns for game engines
> **Domains**: lua, game, scripting

---

## Rules
<!-- PURPOSE: Prescriptive constraints that MUST be followed. Written as imperatives ("Always X", "Never Y"). Each rule should be independently verifiable. Rules are the highest-authority content in a skill — they override best practices when in conflict. -->

1. **Always use `local` for variables** — Global variables in Lua are stored in `_G` table and require hash lookups on every access. Local variables are register-allocated and 30-40% faster. Accidentally omitting `local` is the #1 Lua bug.

2. **Pre-declare functions before use in mutual recursion** — Lua processes files top-to-bottom. Forward-reference a function with `local funcName` before the actual `function funcName()` definition if two functions call each other.

3. **Never modify a table while iterating with `pairs()`/`ipairs()`** — Behavior is undefined and differs between Lua 5.x and LuaJIT. Collect keys to modify in a separate table, then apply changes after iteration.

4. **Use `#t` only on sequence tables** — The length operator `#t` is defined only for tables with consecutive integer keys starting at 1. On sparse tables, `#t` returns an arbitrary boundary. Use explicit count tracking for non-sequence tables.

5. **Avoid creating closures in hot loops** — Each `function() end` inside a loop creates a new closure object and GC pressure. Hoist the function outside the loop and pass data via upvalues or parameters.

## SOP (Standard Operating Procedure)
<!-- PURPOSE: Step-by-step workflow for the skill's domain. Numbered phases with clear entry/exit criteria. An agent following this SOP should produce consistent, high-quality output regardless of the specific project. -->

1. **xLua/ToLua Integration**: Define C# interface → Generate Lua binding wrapper → Implement Lua-side logic → Call via `LuaEnv.DoString()` or `LuaTable.Get<>()` → Dispose LuaEnv on scene unload.
2. **Hot-reload Workflow**: Save Lua file → Engine detects change via file watcher → Re-execute `dofile()` on the module → Preserve state by separating data (tables) from logic (functions).
3. **Module Pattern**: Use `local M = {}` ... `return M` for every module. Access via `local mod = require("moduleName")`. Never pollute `_G`.

## Checklist
<!-- PURPOSE: A verification checklist to run AFTER completing work. Each item is a yes/no question or a checkbox assertion. Group items by concern (correctness, security, performance, maintainability). -->

- [ ] All variables declared with `local` (use `luacheck` linter to enforce)
- [ ] No closures created inside per-frame update loops
- [ ] Table pools used for frequently allocated/deallocated tables
- [ ] `require` used for module loading (not `dofile` in production)
- [ ] C#↔Lua boundary calls minimized (batch operations where possible)

## Best Practices
<!-- PURPOSE: Recommended patterns that SHOULD be followed. Unlike Rules (which are mandatory), Best Practices are advisory — they can be overridden with justification. Each entry explains WHAT to do and WHY it helps. -->

1. **Table pooling for GC-sensitive paths** — Reuse tables from a pool instead of creating/destroying them per frame. Lua's GC is stop-the-world; reducing allocation rate directly reduces frame-time spikes.

2. **Prefer LuaJIT FFI over C API for native calls** — LuaJIT's FFI (Foreign Function Interface) inlines native calls directly, avoiding the C API stack overhead. Use `ffi.cdef` for struct definitions and function declarations.

3. **Metatables for OOP with `__index` chain** — Implement class-like patterns with `setmetatable(obj, { __index = Class })`. For inheritance: `setmetatable(Child, { __index = Parent })`. Keep inheritance depth ≤ 3 to avoid lookup chain performance issues.

4. **String interning awareness** — Lua automatically interns all strings. Comparing strings with `==` is O(1) (pointer comparison). But creating many unique strings (e.g., concatenating player IDs per frame) fills the string table and slows GC.

5. **Coroutines for async game logic** — Use `coroutine.create/resume/yield` for cutscenes, tween sequences, and multi-frame computations. Coroutines are cooperative (no race conditions) and have near-zero overhead compared to callbacks.

## Anti-Patterns
<!-- PURPOSE: Common MISTAKES to avoid. Each entry describes: (1) the wrong approach, (2) why it's wrong, (3) the correct alternative. -->

1. **String concatenation in loops** — `s = s .. newPart` in a loop creates O(n²) intermediate strings. Instead: collect parts in a table and `table.concat(parts)` once at the end.

2. **Using `_G` as a communication bus** — Storing shared state in globals makes code untestable and prone to name collisions. Instead: use explicit module returns and dependency injection via function parameters.

3. **Deep metatables chain** — 5+ levels of `__index` chaining for "inheritance" causes O(depth) lookup on every method call. Instead: flatten by copying methods directly into child tables, or use composition.

4. **Calling C#/C++ per frame without batching** — Each Lua↔C# boundary crossing has marshalling overhead (type conversion, GC handle). Instead: batch multiple operations into a single C# call that processes a Lua table.

5. **`error()` for control flow** — Using `pcall/error` as try-catch for normal control flow is expensive (10-50x slower than return values). Instead: use return codes `return nil, "error message"` for expected failures.

## Context Hints
<!-- PURPOSE: Background knowledge that helps an agent make better decisions. Not rules or practices — just useful context about libraries, team conventions, or known limitations. -->

1. **Lua 5.4 vs LuaJIT compatibility** — LuaJIT is frozen at Lua 5.1 semantics (with some 5.2 extensions). Features like integers (5.3+), generational GC (5.4), `goto` work differently. Game engines typically use LuaJIT for performance.

2. **xLua garbage collection** — xLua wraps C# objects in Lua userdata with weak references. If C# GC collects the object while Lua still holds a reference, access causes `ObjectDisposedException`. Pin long-lived objects with `GCHandle`.

3. **LuaJIT trace compiler** — LuaJIT's trace JIT works best on linear code paths. Polymorphic calls, deeply nested conditionals, and `pcall` inside hot loops cause trace aborts. Keep hot paths simple and type-stable.

4. **Table memory layout** — Lua tables have an array part (integer keys 1..n) and hash part (everything else). Mixing integer and string keys in the same table wastes memory. Separate data tables by access pattern.

5. **Profiling Lua code** — Use `debug.sethook` for function-level profiling or LuaJIT's `-jv` flag for trace inspection. For production, embed a sampling profiler that records call stacks at regular intervals.

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-13 | Initial creation |
| v1.1.0 | 2026-03-19 | External knowledge enrichment: added Rules, SOP, Checklist, Best Practices, Anti-Patterns, Context Hints |