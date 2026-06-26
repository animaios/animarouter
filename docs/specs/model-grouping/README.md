# Model Grouping — Unified Model Identity Across Providers

## Problem

When the same underlying model is available from multiple providers (e.g. "DeepSeek V4 Flash" from NVIDIA NIM and from OpenCode Zen), it appears as **two completely separate entries** in the system:

- Two rows in `models` with different `(platform, model_id)` pairs
- Two separate displayed intelligence ranks (e.g. 70 vs ?)
- Two separate fallback-chain entries that the user must prioritize manually
- Two separate degradation states (correct per-provider — but confusing to display together)
- Analytics and the dashboard show duplicate entries instead of one model

The root cause: the `models` table conflates **model identity** (what the model IS — its capabilities, intelligence, name) with **provider context** (how it's accessed — keys, rate limits, speed, reliability). Both live in the same row, so "same model, different provider" creates parallel rows with no linkage.

## Goal

Introduce a **model group** concept so that the same model from different providers appears and acts as **one entry** in the UI, routing, analytics, and benchmark scoring — while preserving per-provider differences (speed, reliability, degradation, key availability) for routing decisions.

## Key Design Principle

**Group-level = what the model IS.** Intelligence, display name, size tier, tools, vision, context window — these are properties of the model, not the provider.

**Provider-level = how the model is ACCESSED.** Speed, reliability, rate limits, degradation, key availability — these depend on which provider serves the model.

## Dependencies & Integration Points

This spec deeply integrates with:

| Feature | Integration |
|---------|-------------|
| **Benchmark Unification** (V34) | AA/SWE scores write to group-level; `canonical_model_key` becomes the group key source |
| **Dynamic Degradation** | Degradation stays per-provider (NV failing ≠ Zen failing), but display aggregates |
| **Fallback Chain** | Chain orders groups, not individual model rows; per-provider sub-ranking within groups |
| **Routing / Bandit Scoring** | Intelligence axis = group-level; Speed & Reliability axes = per-provider |
| **Analytics** | New `?groupBy=model` option to aggregate requests across providers |
| **Model Pinning** | Pin by group ("use DeepSeek V4 Flash"), router picks best provider within group |
| **Provider Health / Heartbeat** | Key health is per-provider, feeds into per-provider sub-ranking |
| **Custom Providers / Auto-Sync** | New models auto-group when canonical key matches existing group |

## Spec Structure

| Document | Purpose |
|----------|---------|
| `README.md` | This file — overview, motivation, integration map |
| `REQUIREMENTS.md` | Functional and non-functional requirements (R1–R13) |
| `DESIGN.md` | Architecture, DB schema, routing algorithm, API changes, sequence diagrams |
| `TASKS.md` | Implementation tasks with dependencies and file-level symbols |
