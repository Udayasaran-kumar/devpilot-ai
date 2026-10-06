# Sample checkout service

A tiny checkout and payment service used as fixture data for DevPilot AI's
repository tools. It is not part of the DevPilot AI workspace build or
typecheck.

Its source uses `.ts` import specifiers so Node can run it directly with
`--experimental-strip-types`; `npm test` needs nothing but Node 22.6 or newer.

`npm test` deliberately fails one of three tests:
`applies tax to the discounted amount` (`200 !== 180`).
