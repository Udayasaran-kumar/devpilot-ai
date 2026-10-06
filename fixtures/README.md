# Fixtures

Evaluation fixtures: small, real repositories with a reproducible failure, used
to measure DevPilot AI end-to-end.

Each fixture will live in its own directory and contain:

- the repository under investigation (or a script that materialises it),
- a `fixture.json` validated by `FixtureSchema` from `@devpilot/eval`, holding
  the input `Signal` and the `GroundTruth` (root-cause locations and the
  red-to-green verification command).

Ground truth belongs here, next to the fixture data. Engine, planner, tool, and
evaluator code must never contain fixture-specific answers, search terms, or
report text.

No fixtures exist yet.
