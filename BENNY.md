# Working on Benny

- Source is in src/, tests in test/. Node runs the TypeScript directly, so `npm run dev` tries a change without building.
- Check every change with `npm run typecheck` and `npm test`. The tests use a fake model and cost no tokens.
- Never run `npm run spike`, `npm publish`, or anything that pushes to git.
- Match the existing style: small files, comments that explain why, no new dependencies without asking.
