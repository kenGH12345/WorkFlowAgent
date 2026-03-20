# Deep Audit Report

> Generated: 2026-03-19T04:22:48.427Z
> Duration: 0.1s
> Total findings: 49 (Critical: 0 | High: 20 | Medium: 23 | Low: 6 | Info: 0)

---

## 🔴 Top Priority (20)

### [HIGH] File exceeds architecture constraint: index.js
- **Category**: config-consistency
- **Description**: index.js has 1153 lines (limit: 600). This violates the architecture-constraints.md rule for "index.js".
- **Suggestion**: Split into smaller modules. Extract helpers or sub-components. 
- **Locations**: [{"file":"index.js","lines":1153,"limit":600}]

### [HIGH] File exceeds architecture constraint: clarification-engine.js
- **Category**: config-consistency
- **Description**: clarification-engine.js has 998 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
- **Suggestion**: Split into smaller modules. Extract helpers or sub-components. URGENT: file is 2× over limit.
- **Locations**: [{"file":"core\\clarification-engine.js","lines":998,"limit":400}]

### [HIGH] File exceeds architecture constraint: code-graph.js
- **Category**: config-consistency
- **Description**: code-graph.js has 1440 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
- **Suggestion**: Split into smaller modules. Extract helpers or sub-components. URGENT: file is 2× over limit.
- **Locations**: [{"file":"core\\code-graph.js","lines":1440,"limit":400}]

### [HIGH] File exceeds architecture constraint: code-review-agent.js
- **Category**: config-consistency
- **Description**: code-review-agent.js has 871 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
- **Suggestion**: Split into smaller modules. Extract helpers or sub-components. URGENT: file is 2× over limit.
- **Locations**: [{"file":"core\\code-review-agent.js","lines":871,"limit":400}]

### [HIGH] File exceeds architecture constraint: context-loader.js
- **Category**: config-consistency
- **Description**: context-loader.js has 710 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
- **Suggestion**: Split into smaller modules. Extract helpers or sub-components. 
- **Locations**: [{"file":"core\\context-loader.js","lines":710,"limit":400}]

### [HIGH] File exceeds architecture constraint: deep-audit-orchestrator.js
- **Category**: config-consistency
- **Description**: deep-audit-orchestrator.js has 953 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
- **Suggestion**: Split into smaller modules. Extract helpers or sub-components. URGENT: file is 2× over limit.
- **Locations**: [{"file":"core\\deep-audit-orchestrator.js","lines":953,"limit":400}]

### [HIGH] File exceeds architecture constraint: git-integration.js
- **Category**: config-consistency
- **Description**: git-integration.js has 735 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
- **Suggestion**: Split into smaller modules. Extract helpers or sub-components. 
- **Locations**: [{"file":"core\\git-integration.js","lines":735,"limit":400}]

### [HIGH] File exceeds architecture constraint: knowledge-pipeline.js
- **Category**: config-consistency
- **Description**: knowledge-pipeline.js has 678 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
- **Suggestion**: Split into smaller modules. Extract helpers or sub-components. 
- **Locations**: [{"file":"core\\knowledge-pipeline.js","lines":678,"limit":400}]

### [HIGH] File exceeds architecture constraint: observability.js
- **Category**: config-consistency
- **Description**: observability.js has 1330 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
- **Suggestion**: Split into smaller modules. Extract helpers or sub-components. URGENT: file is 2× over limit.
- **Locations**: [{"file":"core\\observability.js","lines":1330,"limit":400}]

### [HIGH] File exceeds architecture constraint: orchestrator-lifecycle.js
- **Category**: config-consistency
- **Description**: orchestrator-lifecycle.js has 1119 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
- **Suggestion**: Split into smaller modules. Extract helpers or sub-components. URGENT: file is 2× over limit.
- **Locations**: [{"file":"core\\orchestrator-lifecycle.js","lines":1119,"limit":400}]

### [HIGH] File exceeds architecture constraint: orchestrator-task.js
- **Category**: config-consistency
- **Description**: orchestrator-task.js has 1181 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
- **Suggestion**: Split into smaller modules. Extract helpers or sub-components. URGENT: file is 2× over limit.
- **Locations**: [{"file":"core\\orchestrator-task.js","lines":1181,"limit":400}]

### [HIGH] File exceeds architecture constraint: prompt-builder.js
- **Category**: config-consistency
- **Description**: prompt-builder.js has 830 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
- **Suggestion**: Split into smaller modules. Extract helpers or sub-components. URGENT: file is 2× over limit.
- **Locations**: [{"file":"core\\prompt-builder.js","lines":830,"limit":400}]

### [HIGH] File exceeds architecture constraint: self-reflection-engine.js
- **Category**: config-consistency
- **Description**: self-reflection-engine.js has 848 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
- **Suggestion**: Split into smaller modules. Extract helpers or sub-components. URGENT: file is 2× over limit.
- **Locations**: [{"file":"core\\self-reflection-engine.js","lines":848,"limit":400}]

### [HIGH] File exceeds architecture constraint: skill-evolution.js
- **Category**: config-consistency
- **Description**: skill-evolution.js has 787 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
- **Suggestion**: Split into smaller modules. Extract helpers or sub-components. 
- **Locations**: [{"file":"core\\skill-evolution.js","lines":787,"limit":400}]

### [HIGH] File exceeds architecture constraint: stage-context-store.js
- **Category**: config-consistency
- **Description**: stage-context-store.js has 622 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
- **Suggestion**: Split into smaller modules. Extract helpers or sub-components. 
- **Locations**: [{"file":"core\\stage-context-store.js","lines":622,"limit":400}]

### [HIGH] File exceeds architecture constraint: stage-tester.js
- **Category**: config-consistency
- **Description**: stage-tester.js has 758 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
- **Suggestion**: Split into smaller modules. Extract helpers or sub-components. 
- **Locations**: [{"file":"core\\stage-tester.js","lines":758,"limit":400}]

### [HIGH] File exceeds architecture constraint: test-case-executor.js
- **Category**: config-consistency
- **Description**: test-case-executor.js has 864 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
- **Suggestion**: Split into smaller modules. Extract helpers or sub-components. URGENT: file is 2× over limit.
- **Locations**: [{"file":"core\\test-case-executor.js","lines":864,"limit":400}]

### [HIGH] File exceeds architecture constraint: command-router.js
- **Category**: config-consistency
- **Description**: command-router.js has 1717 lines (limit: 300). This violates the architecture-constraints.md rule for "commands/command-router.js".
- **Suggestion**: Split into smaller modules. Extract helpers or sub-components. URGENT: file is 2× over limit.
- **Locations**: [{"file":"commands\\command-router.js","lines":1717,"limit":300}]

### [HIGH] 10/22 skills have thin content (< 40% section fill-rate)
- **Category**: functional-completeness
- **Description**: Hollow skills: [bp-architecture-design, bp-coding-best-practices, bp-component-design, bp-distributed-systems, bp-performance-optimization, self-refinement, spec-template, standards, +2 more]. Run `/skill-enrich` to auto-populate from external knowledge.
- **Suggestion**: Run `/skill-enrich <name>` for each hollow skill, or batch enrich all.

### [HIGH] 2 high-severity entropy violation(s) from last scan
- **Category**: performance-efficiency
- **Description**: EntropyGC found: FILE_TOO_LARGE: 1257 lines (limit: 600); FILE_TOO_LARGE: 1221 lines (limit: 600)
- **Suggestion**: Run `/gc` and fix high-severity violations.

## ⚙️ config-consistency (22)

- **[medium]** File exceeds architecture constraint: adapter-plugin-registry.js: adapter-plugin-registry.js has 570 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
  > 💡 Split into smaller modules. Extract helpers or sub-components. 
- **[medium]** File exceeds architecture constraint: adapter-telemetry.js: adapter-telemetry.js has 409 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
  > 💡 Split into smaller modules. Extract helpers or sub-components. 
- **[medium]** File exceeds architecture constraint: architecture-review-agent.js: architecture-review-agent.js has 561 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
  > 💡 Split into smaller modules. Extract helpers or sub-components. 
- **[medium]** File exceeds architecture constraint: block-compressor.js: block-compressor.js has 447 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
  > 💡 Split into smaller modules. Extract helpers or sub-components. 
- **[medium]** File exceeds architecture constraint: ci-integration.js: ci-integration.js has 485 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
  > 💡 Split into smaller modules. Extract helpers or sub-components. 
- **[medium]** File exceeds architecture constraint: entropy-gc.js: entropy-gc.js has 510 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
  > 💡 Split into smaller modules. Extract helpers or sub-components. 
- **[medium]** File exceeds architecture constraint: experience-evolution.js: experience-evolution.js has 463 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
  > 💡 Split into smaller modules. Extract helpers or sub-components. 
- **[medium]** File exceeds architecture constraint: experience-query.js: experience-query.js has 434 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
  > 💡 Split into smaller modules. Extract helpers or sub-components. 
- **[medium]** File exceeds architecture constraint: file-ref-bus.js: file-ref-bus.js has 414 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
  > 💡 Split into smaller modules. Extract helpers or sub-components. 
- **[medium]** File exceeds architecture constraint: mcp-adapter-helpers.js: mcp-adapter-helpers.js has 520 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
  > 💡 Split into smaller modules. Extract helpers or sub-components. 
- **[medium]** File exceeds architecture constraint: observability-strategy.js: observability-strategy.js has 446 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
  > 💡 Split into smaller modules. Extract helpers or sub-components. 
- **[medium]** File exceeds architecture constraint: orchestrator-helpers.js: orchestrator-helpers.js has 440 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
  > 💡 Split into smaller modules. Extract helpers or sub-components. 
- **[medium]** File exceeds architecture constraint: quality-gate.js: quality-gate.js has 453 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
  > 💡 Split into smaller modules. Extract helpers or sub-components. 
- **[medium]** File exceeds architecture constraint: requirement-clarifier.js: requirement-clarifier.js has 581 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
  > 💡 Split into smaller modules. Extract helpers or sub-components. 
- **[medium]** File exceeds architecture constraint: review-agent-base.js: review-agent-base.js has 444 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
  > 💡 Split into smaller modules. Extract helpers or sub-components. 
- **[medium]** File exceeds architecture constraint: sandbox.js: sandbox.js has 582 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
  > 💡 Split into smaller modules. Extract helpers or sub-components. 
- **[medium]** File exceeds architecture constraint: skill-enrichment.js: skill-enrichment.js has 512 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
  > 💡 Split into smaller modules. Extract helpers or sub-components. 
- **[medium]** File exceeds architecture constraint: smart-context-selector.js: smart-context-selector.js has 599 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
  > 💡 Split into smaller modules. Extract helpers or sub-components. 
- **[medium]** File exceeds architecture constraint: socratic-engine.js: socratic-engine.js has 419 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
  > 💡 Split into smaller modules. Extract helpers or sub-components. 
- **[medium]** File exceeds architecture constraint: state-machine.js: state-machine.js has 420 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
  > 💡 Split into smaller modules. Extract helpers or sub-components. 
- **[medium]** File exceeds architecture constraint: task-manager.js: task-manager.js has 436 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
  > 💡 Split into smaller modules. Extract helpers or sub-components. 
- **[medium]** File exceeds architecture constraint: token-budget.js: token-budget.js has 475 lines (limit: 400). This violates the architecture-constraints.md rule for "core/*.js".
  > 💡 Split into smaller modules. Extract helpers or sub-components. 

## ⚡ performance-efficiency (4)

- **[low]** Large core module: code-graph.js (62KB): code-graph.js is 62KB. Large modules increase memory footprint and make maintenance harder.
  > 💡 Consider extracting helper functions into separate modules.
- **[low]** Large core module: observability.js (57KB): observability.js is 57KB. Large modules increase memory footprint and make maintenance harder.
  > 💡 Consider extracting helper functions into separate modules.
- **[low]** Large core module: orchestrator-lifecycle.js (53KB): orchestrator-lifecycle.js is 53KB. Large modules increase memory footprint and make maintenance harder.
  > 💡 Consider extracting helper functions into separate modules.
- **[low]** Large core module: orchestrator-task.js (54KB): orchestrator-task.js is 54KB. Large modules increase memory footprint and make maintenance harder.
  > 💡 Consider extracting helper functions into separate modules.

## 🔀 logic-consistency (2)

- **[medium]** 5 circular require() dependency pairs detected: Circular dependencies: context-budget-manager.js↔context-budget-manager.js, experience-store.js↔experience-store.js, file-scanner.js↔file-scanner.js, ...
  > 💡 Break cycles by extracting shared logic into a common module, or use lazy require() inside functions.
- **[low]** 39 completely silent catch blocks: Silent catch blocks (empty or comment-only) may hide important errors. While fire-and-forget patterns are intentional, excessive use can mask bugs.
  > 💡 Audit silent catch blocks. Ensure at minimum a console.warn for non-trivial operations.

## 📚 knowledge-quality (1)

- **[low]** 7 skill file(s) missing version in frontmatter: Skills without version tracking cannot be audited for staleness.
  > 💡 Add `version: 1.0.0` to skill frontmatter.
