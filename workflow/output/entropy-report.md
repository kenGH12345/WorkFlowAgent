# Entropy GC Report

> Generated: 2026-03-15T09:40:38.655Z
> Files scanned: 39
> Violations: 5 total (2 high / 3 medium / 0 low)

---

## 🔴 High Severity (2)

### FILE_TOO_LARGE: `index.js`
- **Detail**: 1257 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `init-project.js`
- **Detail**: 1221 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

## 🟡 Medium Severity (3)

### FILE_TOO_LARGE: `core\architecture-review-agent.js`
- **Detail**: 743 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `core\clarification-engine.js`
- **Detail**: 624 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `core\code-review-agent.js`
- **Detail**: 668 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

---

## Next Steps

1. Address all **high** severity violations before the next release.
2. Schedule **medium** violations for the next sprint.
3. **Low** violations can be batched into a periodic cleanup PR.

> Run `/wf gc` to trigger another scan after fixes.