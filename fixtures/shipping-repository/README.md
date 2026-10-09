# Sample shipping service

A one-function shipping quote used as fixture data for DevPilot AI's
model-escalation planner. It is not part of the DevPilot AI workspace build or
typecheck; `npm test` needs nothing but Node 22.6 or newer.

`npm test` deliberately fails one of three tests:
`ships free exactly at the threshold` (`500 !== 0`).

The failing value is computed from function parameters with a comparison, so
the rule planner finds no competing hypotheses: there is no earlier local, no
numeric constant, and no earlier assertion in the failing test to reason from.
