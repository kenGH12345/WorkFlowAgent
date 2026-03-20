---
name: javascript-dev
version: 1.1.0
type: domain-skill
domains: [frontend, backend, javascript]
dependencies: []
load_level: task
max_tokens: 800
triggers:
  keywords: [javascript, js, node, npm, typescript, ts, react, vue, express]
  roles: [developer]
description: "JavaScript development patterns"
---
# Skill: javascript-dev

> **Type**: Domain Skill
> **Version**: 1.1.0
> **Description**: JavaScript development patterns
> **Domains**: frontend, backend, javascript

---

## Rules
<!-- PURPOSE: Prescriptive constraints that MUST be followed. Written as imperatives ("Always X", "Never Y"). Each rule should be independently verifiable. Rules are the highest-authority content in a skill — they override best practices when in conflict. -->

1. **Use `const` by default, `let` when rebinding is needed, never `var`** — `var` has function scope and hoisting, causing subtle bugs. `const` signals immutable bindings and catches accidental reassignment at compile time.

2. **Always use `===` for comparison** — `==` performs type coercion (`"0" == false` is `true`). Triple equals checks both type and value, eliminating an entire class of subtle bugs.

3. **Handle Promise rejections explicitly** — Every `.then()` chain must have a `.catch()`. Every `async` function call must be in `try/catch` or have `.catch()`. Unhandled rejections crash Node.js 15+ by default.

4. **Use TypeScript for any project over 500 lines** — TypeScript catches 15-20% of bugs at compile time that would otherwise reach production. The type system pays for itself on the first refactor.

5. **Never mutate function arguments** — Create new objects/arrays instead of modifying inputs. Mutations cause action-at-a-distance bugs that are extremely difficult to trace in async codebases.

## SOP (Standard Operating Procedure)
<!-- PURPOSE: Step-by-step workflow for the skill's domain. Numbered phases with clear entry/exit criteria. An agent following this SOP should produce consistent, high-quality output regardless of the specific project. -->

1. **Node.js Project Setup**: `npm init` → Add TypeScript (`tsconfig.json` with `strict: true`) → ESLint + Prettier → Husky pre-commit hooks → Jest/Vitest for testing → CI pipeline.
2. **Error Handling Flow**: Define custom error classes extending `Error` → Throw domain errors in service layer → Catch at controller/middleware level → Map to HTTP responses → Log with context.
3. **Dependency Management**: Pin exact versions in `package-lock.json` → Use `npm audit` in CI → Renovate/Dependabot for automated updates → Review changelogs before major bumps.

## Checklist
<!-- PURPOSE: A verification checklist to run AFTER completing work. Each item is a yes/no question or a checkbox assertion. Group items by concern (correctness, security, performance, maintainability). -->

- [ ] `"strict": true` in tsconfig.json (if TypeScript)
- [ ] All async functions have error handling (try/catch or .catch())
- [ ] No `any` types in TypeScript (use `unknown` + type guards)
- [ ] ESLint configured with `no-unused-vars`, `no-implicit-globals`
- [ ] `package-lock.json` committed to version control
- [ ] Node.js version pinned in `.nvmrc` or `package.json` `engines` field

## Best Practices
<!-- PURPOSE: Recommended patterns that SHOULD be followed. Unlike Rules (which are mandatory), Best Practices are advisory — they can be overridden with justification. Each entry explains WHAT to do and WHY it helps. -->

1. **Use `AbortController` for cancellable async operations** — Pass `AbortSignal` to `fetch`, timers, and streams. This prevents resource leaks when users navigate away or requests time out.

2. **Prefer `structuredClone()` for deep copy (Node 17+/modern browsers)** — `JSON.parse(JSON.stringify(obj))` fails on `Date`, `Map`, `Set`, `RegExp`, `undefined`, and circular refs. `structuredClone()` handles all of these correctly.

3. **Use `Promise.allSettled()` over `Promise.all()` for independent tasks** — `Promise.all()` short-circuits on first rejection, losing results from other resolved promises. `Promise.allSettled()` always returns all outcomes.

4. **Debounce user input, throttle scroll/resize** — Use `debounce` for search inputs (fire after user stops typing), `throttle` for scroll handlers (fire at most every N ms). This prevents performance degradation and API spam.

5. **Use `WeakMap`/`WeakRef` for caches tied to object lifecycle** — Regular `Map` caches prevent garbage collection. `WeakMap` automatically releases entries when the key object is GC'd, preventing memory leaks in long-running processes.

## Anti-Patterns
<!-- PURPOSE: Common MISTAKES to avoid. Each entry describes: (1) the wrong approach, (2) why it's wrong, (3) the correct alternative. -->

1. **Callback hell / Promise chain pyramid** — Deeply nested `.then()` chains or callbacks. Instead: use `async/await` for flat, readable sequential async code. Extract helper functions for complex parallel flows.

2. **`typeof null === 'object'` trap** — Checking `typeof x === 'object'` passes `null`. Instead: always check `x !== null && typeof x === 'object'` or use TypeScript type guards.

3. **Importing entire lodash** — `import _ from 'lodash'` bundles 70KB+ even if you use one function. Instead: import specific functions `import debounce from 'lodash/debounce'` or use native alternatives.

4. **for...in on arrays** — `for...in` iterates over all enumerable properties (including prototype), not just indices. Instead: use `for...of`, `.forEach()`, or indexed `for` loop for arrays.

5. **Floating-point math for money** — `0.1 + 0.2 !== 0.3` in JavaScript. Instead: use integer arithmetic in smallest unit (cents), or libraries like `decimal.js` / `dinero.js` for financial calculations.

## Context Hints
<!-- PURPOSE: Background knowledge that helps an agent make better decisions. Not rules or practices — just useful context about libraries, team conventions, or known limitations. -->

1. **Node.js 22 LTS changes** — Node 22 ships with built-in `--watch` mode, native WebSocket support, and `require()` for ESM modules behind `--experimental-require-module`. The permission model (`--experimental-permission`) is now stable.

2. **ES2024 features** — `Array.groupBy()`, `Promise.withResolvers()`, `Object.groupBy()`, and `ArrayBuffer.prototype.resize()` are now standard. These replace many lodash utilities.

3. **ESM vs CJS migration** — Set `"type": "module"` in package.json for ESM. Use `.mjs` / `.cjs` extensions for mixed projects. Dynamic `import()` works in both modes. `__dirname` is not available in ESM — use `import.meta.dirname` (Node 21+).

4. **V8 hidden class deoptimization** — Adding properties to objects after creation (not in constructor) forces V8 to create new hidden classes, slowing property access 10x. Always initialize all properties in the constructor.

5. **`fetch()` in Node.js gotcha** — Node's built-in `fetch()` (Undici-based) does not follow redirects to different origins by default, and response body MUST be consumed or explicitly discarded, otherwise the connection leaks.

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-14 | Initial creation |
| v1.1.0 | 2026-03-19 | External knowledge enrichment: added Rules, SOP, Checklist, Best Practices, Anti-Patterns, Context Hints |