# Reasonix upstream sync report

- Upstream: `esengine/DeepSeek-Reasonix` @ `main-v2`
- Upstream commit: `2a2dbbeaefe624d1764118d4aafb660fb7a53e0b`
- Previous commit: `2a2dbbeaefe624d1764118d4aafb660fb7a53e0b`
- Vendored files: 17

## Upstream default changes adopted

- REASONIX_DEFAULT_COMPACT_RATIO: upstream 0.8 (was 0.85 locally)
- REASONIX_RECENT_TAIL_BUDGET_RATIO: upstream 0.16 (was 0.1 locally)
- REASONIX_SUMMARY_OUTPUT_MAX_TOKENS: upstream 8192 (was 16384 locally)

## Vendored snapshot

- `internal/agent/compact.go`
- `internal/agent/compact_active_turn.go`
- `internal/agent/compact_commit.go`
- `internal/agent/compact_fold_input.go`
- `internal/agent/compact_projection.go`
- `internal/agent/compact_safe_prefix.go`
- `internal/agent/compact_slim.go`
- `internal/agent/compact_summary_feedback.go`
- `internal/agent/context_capsule.go`
- `internal/agent/context_manager.go`
- `internal/agent/context_receipt.go`
- `internal/agent/context_recovery.go`
- `internal/agent/context_report.go`
- `internal/agent/context_status.go`
- `internal/agent/context_usage.go`
- `docs/research/cache-aware-compaction-design.md`
- `docs/SPEC.md`
