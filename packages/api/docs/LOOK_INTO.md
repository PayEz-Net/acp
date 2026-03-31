# Look Into / Research Notes

## Monty — Secure Python Interpreter for AI Agents

**URL:** https://github.com/pydantic/monty
**Date noted:** 2026-02-09
**Noted by:** BAPert

**What it is:** A minimal Python interpreter built in Rust by the Pydantic team. Designed to safely execute AI-generated Python code without containers or full runtimes.

**Key points:**
- ~0.06ms startup (vs ~195ms for containers — 3,000x faster)
- Runs a practical subset of Python — no stdlib, no third-party imports
- Zero access to host filesystem, env vars, or network unless explicitly exposed
- Can snapshot execution state to bytes (pause/resume across processes)
- Available as a library for Python, JavaScript, and Rust
- Being integrated into Pydantic AI's "code-mode" feature

**Limitations:** No classes (yet), no match statements, no standard library beyond sys/typing/asyncio.

**Why it matters for ACP:** Could be relevant for agent code execution sandboxing — if ACP agents need to run generated code snippets safely and fast, Monty is purpose-built for that. Worth evaluating as an alternative to container-based sandboxing.

**Status:** Research / evaluate when relevant.
