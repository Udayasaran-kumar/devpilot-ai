# Fixtures

Small, real repositories used to exercise and evaluate DevPilot AI.

## `sample-repository/`

A tiny TypeScript checkout and payment service (cart, discounts, money
helpers, a payment gateway interface, and a fake gateway). It exists to test
the repository tools: reading files, searching for symbols, listing files,
safe path handling, and sandboxed command execution.

It has one deliberate regression: checkout charges tax on the pre-discount
subtotal, so `npm test` fails `applies tax to the discounted amount` with
`200 !== 180`. There is no ground-truth file for it yet.

Tests copy it into a temporary directory before adding hostile entries
(escaping symlinks, binary files, ignored directories), so the committed copy
stays plain files only.

## `shipping-repository/`

A one-function shipping quote whose `npm test` fails
`ships free exactly at the threshold` (`500 !== 0`). The rule planner cannot
form competing hypotheses for it, so it is the fixture for the model-escalation
planner in `@devpilot/planner-bedrock`. Tests answer for the model with a fake
client; the fixture holds no expected answer.

## Future evaluation fixtures

Each evaluation fixture will live in its own directory and contain:

- the repository under investigation (or a script that materialises it),
- a `fixture.json` validated by `FixtureSchema` from `@devpilot/eval`, holding
  the input `Signal` and the `GroundTruth` (root-cause locations and the
  red-to-green verification command).

Ground truth belongs here, next to the fixture data. Engine, planner, tool, and
evaluator code must never contain fixture-specific answers, search terms, or
report text.
