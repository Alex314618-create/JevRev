# Activation policy

`jevrev activation` is the first stage of the Sift activation work. It is a
deterministic, shadow-only check that answers one narrow question:

> Is opening a Sift campaign likely to pay for itself on this task?

It does not call Jev, start an agent, create candidates, or change the next
command. The host agent remains responsible for deciding whether to run
`jevrev sift`.

## Input

```json
{
  "kind": "jevrev.activation-request",
  "schema_version": "1",
  "task": {
    "goal": "Improve parser throughput without changing its public behavior",
    "context": "The parser is used in a latency-sensitive service."
  },
  "assessment": {
    "candidate_count": 5,
    "wrong_path_loss": 0.9,
    "exploration_cost": 0.25,
    "mechanism_diversity": 0.9,
    "constraint_interaction": 0.8,
    "uncertainty": 0.85,
    "probeability": 0.8,
    "reversibility": 0.2,
    "existing_evidence": 0.1
  }
}
```

The assessment is a host-agent estimate, not a fact claimed by JevRev. Every
value is in `[0, 1]`:

- `wrong_path_loss`: expected cost of choosing the wrong mechanism;
- `exploration_cost`: relative cost of generating and probing alternatives;
- `mechanism_diversity`: how materially different the available approaches are;
- `constraint_interaction`: how likely the constraints are to change which
  approach is viable;
- `uncertainty`: how much the agent does not know about the right mechanism;
- `probeability`: how cheaply a bounded probe can distinguish the approaches;
- `reversibility`: how cheaply the decision can be undone;
- `existing_evidence`: how much useful evidence already exists.

`candidate_count` is the number of materially different approaches the host
agent can name. One candidate is not a Sift problem.

## Run it

```bash
jevrev activation --input activation.json
jevrev activation --input activation.json --format json --output activation-result.json
cat activation.json | jevrev activate --input - --format json
```

The result includes the policy version, stable task/run IDs, the normalized
calculation, the `sift` or `bypass` recommendation, and reason codes. The
output always contains `"shadow": true` and says that the host agent still
chooses whether to call Sift.

## Policy and next steps

The current policy (`activation-v1`) uses a transparent weighted structural
factor and compares adjusted wrong-path loss with adjusted exploration cost.
It is intentionally a baseline for shadow evaluation, not an ML classifier.

The remaining work for issue #8 is empirical: collect a 30–50 task corpus,
record the host assessment and the human's eventual choice, inspect false
positive/negative activations, and decide whether an active or opt-in gate is
warranted. Do not turn this command into an automatic bypass until that study
has been completed.

## Workflow placement and late uncertainty

The component is JevSift; `activation` is its shadow assessment, not a Sift call.
The current policy requires an estimated candidate count and mechanism diversity,
so the host first names plausible mechanisms without building a full campaign.
Run the shadow assessment before paying for candidate elaboration/probes. The
host may accept or reject the recommendation; preserve its reason either way.

Reassess only when new evidence changes the mechanism choice, wrong-path cost,
constraints or probeability. Retain the prior assessment, source revision and
reason for reassessment under the same task ID. Do not resubmit unchanged inputs
each Loop round or interpret repeated shadow decisions as independent tasks.

Loop `replan` is a bounded instruction for the next round, not permission to
invoke Sift automatically or replace its frozen contract. If replan exposes
competing mechanisms, the host can record a new shadow assessment and optionally
prepare a Sift campaign. Any changed scope/acceptance still needs the existing
Loop approval boundary. Sift does not certify completion. Long can observe the
recorded outcome without turning it into trusted implementation evidence.

These are manual integration guidelines, not new CLI orchestration or a proven
trigger policy. [Developer trial annotations](DEVELOPER_TRIAL.md) define the
missing human evaluation; [matched comparisons](../benchmarks/COMPARISON_PROTOCOL.md)
define the cost and quality boundary. The 30–50 task study remains pending.
