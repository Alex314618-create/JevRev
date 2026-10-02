# JevRev benchmark harness

For prospective live workflow comparisons, use [the matched comparison
protocol](COMPARISON_PROTOCOL.md). The [2026-10-02 developer acceptance
record](../docs/DEVELOPER_TRIAL_2026-10-02.md) archives current CLI checks and
replay evidence while keeping human-study and live-provider gaps explicit.

`benchmark-demos.mjs` is a repeatable decision-quality harness, not a claim
that a shortlist by itself changes production behavior. Each scenario has a
pre-registered scenario rubric for its candidate IDs. Those labels are a
human-authored evaluation rubric, not external ground truth or a production
execution result. The script rotates candidate order, runs enough repetitions
to put every candidate first (at least five), and compares:

- the first candidate selected without comparison;
- JevRev's best handoff shortlist (strict survivors plus budget-filling review);
- JevRev's strict `selected` set;
- mean utility, precision, and recall, so a best-of-set score cannot hide extra
  low-value selections;
- the number of implementation slots relative to trying every candidate.

It records sample order-sensitivity standard deviation (`n - 1` denominator),
end-to-end CLI wall time (including Node startup and provider calls), provider-
reported prompt/completion tokens, and an explicit estimated token-cost
calculation. The first-idea baseline makes zero judge calls, so JevRev's
reported token count is also the measured decision-token delta versus that
baseline. Local inference has zero API spend in the report; hardware and
electricity are excluded. Hosted estimates use:

```powershell
$env:JEVREV_INPUT_USD_PER_MILLION = "0.20"
$env:JEVREV_OUTPUT_USD_PER_MILLION = "1.00"
npm run benchmark:demos
```

Rates are illustrative user inputs, not official Jev billing. The script writes
raw JSONL (including model, endpoint, run ID, timestamp, Node version, and CLI
hash) and one summary JSON per scenario to
`benchmarks/results/`. Those generated files are intentionally not required by
the package; rerun the harness after changing the provider, model, or request
cards. The harness replaces the fixed result files at the start of a run and
publishes all summaries only after every scenario completes; run one benchmark
process at a time. Each run carries a shared `benchmark_run_id` so raw rows and
summaries can be checked for consistency before being quoted in release notes.
