# Repo conventions for AI assistants

## Pull requests

Every merge to `main` is a production build on Vercel, and every push to a PR branch is a CI run, so
keep both to the pushes that matter.

- Push follow-up fixes to the existing branch. Don't open a new PR to fix an open one.
- Open PRs as drafts, and mark them ready for review only once they are.
- Don't push "merge main into branch" commits just to sync. Rebase, or leave the branch alone if it
  still merges cleanly.
- When several PRs are ready, merge them together rather than minutes apart, so `main` builds
  production once instead of once per merge.
