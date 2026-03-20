---
name: frontend-review
version: 1.0.0
type: domain-skill
domains: [frontend, review, accessibility, ux]
dependencies: [code-review]
load_level: task
max_tokens: 1000
triggers:
  keywords: [frontend, react, vue, angular, svelte, css, html, dom, browser, webpack, vite, accessibility, a11y, responsive, spa, pwa, component, render, state, hook, redux, zustand]
  roles: [developer, architect]
description: "Frontend-specific code review covering component design, accessibility, performance, security (XSS/CSRF/CSP), and state management"
---
# Skill: frontend-review

> **Type**: Domain Skill
> **Version**: 1.0.0
> **Description**: Frontend-specific code review covering component design, accessibility, performance, security (XSS/CSRF/CSP), and state management
> **Domains**: frontend, review, accessibility, ux

---

## Rules
<!-- PURPOSE: Prescriptive constraints that MUST be followed. Written as imperatives ("Always X", "Never Y"). Each rule should be independently verifiable. Rules are the highest-authority content in a skill — they override best practices when in conflict. -->

### R1: Render Safety
- Never use `dangerouslySetInnerHTML` (React) / `v-html` (Vue) / `[innerHTML]` (Angular) with user-controlled data
- Always sanitize HTML before rendering (use DOMPurify or equivalent)
- Template literals in HTML context MUST be escaped

### R2: State Management Discipline
- UI state stays in components; application state in stores
- Never mutate state directly — use immutable updates (spread, `structuredClone`, Immer)
- Derived data should be computed (useMemo / computed / selectors), not stored

### R3: Accessibility is Not Optional
- Every interactive element MUST be keyboard-accessible
- Every image MUST have a meaningful `alt` attribute (or `alt=""` for decorative images)
- Color MUST NOT be the only means of conveying information
- Focus management is required for modals, drawers, and dynamic content

### R4: Bundle Size Awareness
- Every new dependency is a cost to all users — justify the bundle size impact
- Prefer tree-shakable ES module packages over CommonJS
- Lazy-load routes and heavy components (React.lazy, dynamic import)

---

## SOP (Standard Operating Procedure)
<!-- PURPOSE: Step-by-step workflow for the skill's domain. Numbered phases with clear entry/exit criteria. An agent following this SOP should produce consistent, high-quality output regardless of the specific project. -->

### Phase 1: Component Architecture Review
1. Check component granularity (too large = hard to test; too small = prop drilling hell)
2. Verify separation of concerns (container vs presentational, logic vs UI)
3. Check prop types / TypeScript interfaces are defined for all component props
4. Verify key prop usage in lists (no array index as key for dynamic lists)
5. Check for unnecessary re-renders (React: missing memo/useMemo/useCallback where needed)

### Phase 2: Security Review (Frontend-Specific)
1. **XSS**: Search for `innerHTML`, `dangerouslySetInnerHTML`, `v-html`, `document.write()`, `eval()`
2. **CSRF**: Verify anti-CSRF tokens on all state-changing requests
3. **CSP**: Check Content-Security-Policy headers (no `unsafe-inline`, no `unsafe-eval` in production)
4. **Open Redirect**: Validate redirect URLs against an allowlist
5. **Sensitive Data**: Ensure tokens/secrets are not stored in localStorage (use httpOnly cookies)
6. **Postmessage**: Verify origin validation in `window.addEventListener('message', ...)`

### Phase 3: Performance Review
1. **Largest Contentful Paint (LCP)**: Hero images/text load within 2.5s
2. **First Input Delay (FID)**: Main thread not blocked for >100ms
3. **Cumulative Layout Shift (CLS)**: No unexpected layout shifts (set width/height on images, use `font-display: swap`)
4. **Bundle analysis**: Run `webpack-bundle-analyzer` or equivalent — flag bundles >250KB
5. **Network waterfall**: Check for request chains, unnecessary sequential fetches
6. **Image optimization**: WebP/AVIF format, responsive `srcset`, lazy loading for below-fold images

### Phase 4: Accessibility Audit
1. Run automated check (axe-core, Lighthouse accessibility)
2. Keyboard navigation: Tab through the entire flow — can you complete every action?
3. Screen reader: Verify meaningful landmark regions, ARIA labels, live regions for dynamic content
4. Color contrast: Minimum 4.5:1 ratio for normal text, 3:1 for large text (WCAG AA)
5. Form labels: Every input has an associated `<label>` or `aria-label`
6. Error states: Error messages are programmatically associated with inputs (`aria-describedby`)

---

## Checklist
<!-- PURPOSE: A verification checklist to run AFTER completing work. Each item is a yes/no question or a checkbox assertion. Group items by concern (correctness, security, performance, maintainability). -->

### Component Quality
- [ ] All components have TypeScript types/PropTypes for their props
- [ ] No prop drilling beyond 2 levels (use context or state management)
- [ ] List rendering uses stable unique keys (not array index)
- [ ] Effects have correct dependency arrays (no stale closures)
- [ ] Cleanup functions in useEffect / onUnmounted for subscriptions and timers

### Security
- [ ] No `innerHTML` / `dangerouslySetInnerHTML` with user data (or sanitized with DOMPurify)
- [ ] Anti-CSRF tokens on all POST/PUT/DELETE requests
- [ ] No secrets or tokens in localStorage
- [ ] CSP headers configured (no unsafe-inline/eval in production)
- [ ] Third-party scripts loaded with `integrity` attribute (SRI)

### Performance
- [ ] Route-level code splitting implemented
- [ ] Images use modern formats (WebP/AVIF) with fallbacks
- [ ] No synchronous script tags blocking render
- [ ] Debounce/throttle on scroll, resize, and search input handlers
- [ ] Virtual scrolling for lists >100 items

### Accessibility
- [ ] All interactive elements keyboard-accessible
- [ ] All images have appropriate alt text
- [ ] Color contrast meets WCAG AA (4.5:1 normal, 3:1 large)
- [ ] Focus trap in modals and dialogs
- [ ] Error messages associated with form fields

---

## Best Practices
<!-- PURPOSE: Recommended patterns that SHOULD be followed. Unlike Rules (which are mandatory), Best Practices are advisory — they can be overridden with justification. Each entry explains WHAT to do and WHY it helps. -->

### 1. Optimistic UI with Rollback
For user interactions (likes, saves, toggles), update the UI immediately and revert on server error. This creates a snappy, responsive feel while maintaining data integrity.

### 2. Error Boundaries
Wrap major UI sections in error boundaries (React) or error handlers (Vue `errorCaptured`). A failing sidebar should not crash the entire page.

### 3. Progressive Enhancement
Core functionality should work without JavaScript. Enhance with JS for better UX. At minimum: forms should submit, links should navigate, content should be readable.

### 4. Design Token System
Use CSS custom properties (or a design system) for colors, spacing, and typography. Never hardcode `#3B82F6` or `16px` — use `var(--color-primary)` and `var(--space-4)`.

---

## Anti-Patterns
<!-- PURPOSE: Common MISTAKES to avoid. Each entry describes: (1) the wrong approach, (2) why it's wrong, (3) the correct alternative. -->

| ❌ Anti-Pattern | ✅ Correct Approach |
|----------------|---------------------|
| Fetch data in useEffect without cleanup/cancellation | Use AbortController, React Query, or SWR for data fetching |
| Store everything in global state | Only shared cross-component state goes in stores |
| CSS-in-JS for static styles | Use CSS modules or utility classes for static styles; CSS-in-JS for dynamic styles only |
| Catch errors at the top level only | Use error boundaries per UI section |
| Use `!important` to override styles | Fix specificity issues; restructure selectors |
| Inline event handlers with new function on every render | Use useCallback or define handlers outside JSX |

---

## Context Hints
<!-- PURPOSE: Background knowledge that helps an agent make better decisions. Not rules or practices — just useful context about libraries, team conventions, or known limitations. -->

- When reviewing **React** code: check for hook rules (no hooks in conditions/loops), memo usage, context splitting
- When reviewing **Vue** code: check for reactivity gotchas (Vue 2 Object.set, Vue 3 ref/reactive), v-for with v-if precedence
- When reviewing **Angular** code: check for OnPush change detection, unsubscribe from Observables, lazy modules
- When the diff is **CSS-heavy**: focus on specificity, responsive breakpoints, and CLS impact
- When the diff is **form-related**: focus on validation UX, accessibility, and CSRF protection

---

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-19 | Initial creation. Frontend-specific review skill covering component design, security, performance, and accessibility. Inspired by ECC frontend review patterns. |