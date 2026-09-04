## Summary

<!-- Explain the user-visible or contract-level outcome. -->

## Related work

<!-- Link the issue or roadmap task, or write "None". -->

## Verification

<!-- List the exact checks performed and their results. -->

- [ ] `pnpm check`

## Checklist

- [ ] The change is narrowly scoped and does not pull later roadmap work forward.
- [ ] Behavior changes have focused tests.
- [ ] Public package APIs and affected documentation are current.
- [ ] New database changes use a forward-only numbered migration; applied migrations were not rewritten.
- [ ] SOAP namespace/order, bounded I/O, guarded state transitions, and credential-safe errors/logging remain intact where relevant.
- [ ] No passwords, tokens, private keys, link codes, household/device bindings, private URLs, request headers/bodies, server bodies, or real account identifiers are included.
