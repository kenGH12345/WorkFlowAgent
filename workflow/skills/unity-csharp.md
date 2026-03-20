---
name: unity-csharp
version: 1.1.0
type: domain-skill
domains: [unity, csharp, game]
dependencies: []
load_level: task
max_tokens: 800
triggers:
  keywords: [unity, c#, csharp, monobehaviour, scriptableobject, ecs]
  roles: [developer]
description: "Unity C# development patterns and pitfalls"
---
# Skill: unity-csharp

> **Type**: Domain Skill
> **Version**: 1.1.0
> **Description**: Unity C# development patterns and pitfalls
> **Domains**: unity, csharp, game

---

## Rules
<!-- PURPOSE: Prescriptive constraints that MUST be followed. Written as imperatives ("Always X", "Never Y"). Each rule should be independently verifiable. Rules are the highest-authority content in a skill — they override best practices when in conflict. -->

1. **Never use `Find` methods in `Update()`** — `GameObject.Find()`, `FindObjectOfType()`, and `GetComponent()` are expensive reflection-based lookups. Cache references in `Awake()` or `Start()` and reuse them.

2. **Use `CompareTag()` instead of `==` for tag comparison** — `gameObject.tag == "Player"` allocates a new string every call due to marshalling. `CompareTag("Player")` does zero allocation and is 5x faster.

3. **Always null-check after `GetComponent<T>()`** — Components may be destroyed or not attached. Missing components return `null` (which Unity overloads — use `if (comp != null)` not `is not null`).

4. **Pool frequently instantiated objects** — `Instantiate()` and `Destroy()` trigger GC pressure and frame spikes. Use `ObjectPool<T>` (Unity 2021+) for bullets, particles, enemies — anything created/destroyed frequently.

5. **Avoid `string` concatenation in hot paths** — String operations in `Update()` or UI refresh loops cause GC allocations every frame. Use `StringBuilder` or `TextMeshPro.SetText("{0}", value)` with numeric formatting overloads.

## SOP (Standard Operating Procedure)
<!-- PURPOSE: Step-by-step workflow for the skill's domain. Numbered phases with clear entry/exit criteria. An agent following this SOP should produce consistent, high-quality output regardless of the specific project. -->

1. **Component Design**: Single responsibility per MonoBehaviour → Compose complex behaviors by attaching multiple components → Use `ScriptableObject` for shared data/config → Use `UnityEvent` or C# events for loose coupling between components.
2. **Performance Profiling Cycle**: Profile with Unity Profiler → Identify CPU/GPU-bound → Fix GC allocations first → Optimize draw calls with batching → Test on target hardware before optimizing further.
3. **Asset Pipeline**: Use Addressables for dynamic asset loading → Set proper compression (ASTC for mobile, DXT for desktop) → Atlas sprites → Limit texture sizes to power-of-2 for GPU efficiency.

## Checklist
<!-- PURPOSE: A verification checklist to run AFTER completing work. Each item is a yes/no question or a checkbox assertion. Group items by concern (correctness, security, performance, maintainability). -->

- [ ] No `Find*()` or `GetComponent()` calls inside `Update()` / `FixedUpdate()`
- [ ] Object pooling used for frequently spawned/destroyed objects
- [ ] `OnDestroy()` unsubscribes from all events to prevent leaks
- [ ] Coroutines use `WaitForSeconds` cached instance (not `new` every frame)
- [ ] Physics queries use `NonAlloc` variants (`RaycastNonAlloc`, `OverlapSphereNonAlloc`)

## Best Practices
<!-- PURPOSE: Recommended patterns that SHOULD be followed. Unlike Rules (which are mandatory), Best Practices are advisory — they can be overridden with justification. Each entry explains WHAT to do and WHY it helps. -->

1. **Use `ScriptableObject` for configuration data** — Instead of hardcoding values in MonoBehaviours, define `ScriptableObject` assets. They are editable in the Inspector, shareable across scenes, and don't require a GameObject instance.

2. **Async/Await with `UniTask` instead of coroutines** — Coroutines can't return values, can't be awaited, and have poor error handling. UniTask provides allocation-free async/await that integrates with Unity's player loop.

3. **Entity Component System (DOTS) for mass simulation** — When simulating 1000+ entities (crowds, particles, bullets), use Unity DOTS/ECS with Burst compiler. It leverages SIMD and cache-friendly data layout for 10-100x speedup over MonoBehaviour.

4. **Use `SerializeField` with private fields** — Expose fields to Inspector with `[SerializeField] private float _speed;` instead of making them `public`. This preserves encapsulation while maintaining Inspector editability.

5. **Assembly Definitions for compilation speed** — Split your project into Assembly Definitions (`.asmdef`). Changes in one assembly only recompile that assembly, not the entire project. Essential for projects with 500+ scripts.

## Anti-Patterns
<!-- PURPOSE: Common MISTAKES to avoid. Each entry describes: (1) the wrong approach, (2) why it's wrong, (3) the correct alternative. -->

1. **Singleton MonoBehaviour abuse** — Making everything a `GameManager.Instance.DoSomething()` singleton creates hidden dependencies and untestable code. Instead: use dependency injection (VContainer/Zenject) or ScriptableObject-based events.

2. **Coroutine leak** — Starting coroutines without storing the reference or stopping them on disable. Coroutines outlive the intent and cause `MissingReferenceException`. Instead: store `Coroutine` refs and `StopCoroutine` in `OnDisable()`.

3. **Physics in `Update()` instead of `FixedUpdate()`** — Applying forces or raycasting in `Update()` gives inconsistent results across frame rates. Instead: all physics code goes in `FixedUpdate()`, all input reading in `Update()`.

4. **`Resources` folder abuse** — Putting assets in `Resources/` loads them all into memory at startup and prevents Unity from optimizing asset bundles. Instead: use Addressables for dynamic loading.

5. **Camera.main in loops** — `Camera.main` calls `FindGameObjectWithTag("MainCamera")` internally. Instead: cache the camera reference once in `Start()`.

## Context Hints
<!-- PURPOSE: Background knowledge that helps an agent make better decisions. Not rules or practices — just useful context about libraries, team conventions, or known limitations. -->

1. **Unity null vs C# null** — Unity overrides `==` operator for `UnityEngine.Object`. A destroyed GameObject is `== null` in Unity but not `is null` in C# pattern matching. Use `== null` or explicit `ReferenceEquals` depending on intent.

2. **IL2CPP restrictions** — IL2CPP (required for iOS/consoles) does not support runtime code generation. `System.Reflection.Emit`, dynamic `Expression.Compile()`, and some serialization libraries fail. Test on target platform early.

3. **Render pipeline differences** — URP (Universal Render Pipeline) and HDRP use different shader models. Shaders from Built-in pipeline don't work in URP. Use `Shader Graph` for cross-pipeline compatibility.

4. **Burst Compiler limitations** — Burst-compiled jobs cannot use managed types (classes, strings, delegates). Only blittable structs and `NativeArray`/`NativeList` are allowed. Design data structures accordingly.

5. **Unity 6 (2025) changes** — Unity 6 makes Awaitable a first-class citizen, deprecates several legacy input system APIs, and defaults to URP. Check migration guides for `UnityEngine.Input` → `InputSystem` before upgrading.

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-13 | Initial creation |
| v1.1.0 | 2026-03-19 | External knowledge enrichment: added Rules, SOP, Checklist, Best Practices, Anti-Patterns, Context Hints |