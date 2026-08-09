# We let an AI change payments, migrations, and deployment files. Then we restored the project files exactly.

We ran VibeRevert against three real AI coding sessions: Stripe code in Next.js, a database migration in Laravel, and deployment files in FastAPI.

In every project, we deliberately left our own work uncommitted before the AI started.

After rollback, we independently compared the Git state, staged changes, unstaged changes, and untracked files with the state from before the session.

**3 runs. 3 exact project-file restorations. Our pre-existing work survived every one.**

"Project files" is deliberate: VibeRevert does not reverse external effects such as a database migration that already ran, an actual deployment, an API call, or a package publish.

## What we tried

Three realistic tasks, the kind you would actually hand to an AI agent:

- **Next.js** — add Stripe card-payment checkout: a client button, a checkout API route, and a Stripe webhook route.
- **Laravel** — add a database migration that creates an `invoices` table.
- **FastAPI** — add a production `Dockerfile` and a GitHub Actions deployment workflow.

Before each session we planted the case people actually worry about: our own **unfinished and uncommitted** work, sitting in the repository alongside whatever the AI would do — one change staged for commit, another edit in progress, and an untracked file. A tool only earns trust if it can hand that back untouched.

## What happened

In each project we let the AI make its changes, asked VibeRevert what it saw, rolled back, and then independently compared the project-file state before and after.

- **Payments (Next.js)** — flagged **critical / payments**. Rollback restored our modified files and removed the AI's new checkout and webhook code.
- **Migration (Laravel)** — flagged **high / database**. Rollback removed the new migration file.
- **Deployment (FastAPI)** — flagged **high / deployment + infrastructure**. Rollback removed the new Dockerfile and workflow.

The independent comparison covered the committed state, staged changes, unstaged changes, and untracked files. **The project-file state matched exactly in all three runs. Our pre-existing work survived every one.**

## The bug dogfooding found

In the previous build, the rollback **preview** — the summary of what rollback is about to change, which you read before committing to it — left `package.json` off its list in the payment scenario, even though applying the rollback would have restored it. A preview you cannot fully trust is a real problem. We treated it as a release blocker, fixed it, rebuilt, and re-ran the same payment scenario. This time the preview listed `package.json` exactly as it should.

So this is not "three tests passed." We used the product on ourselves, found a defect that mattered, fixed it, and confirmed the fix on the same scenario.

A smaller note from that same run: the dependency check reported *two* new packages when the AI had added only one (`stripe`). It also named `react-dom`, because it reads the change line by line and the AI had nudged `react-dom`'s line while inserting `stripe`. Harmless here, and on our list to sharpen.

## Known limitations

Two boundaries worth stating plainly:

1. **External side effects are out of scope.** If a migration actually ran against a database, if something was actually deployed, or if a paid API was actually called, VibeRevert cannot bring those back. It restores your files, not the world outside them.
2. **Rollback can leave empty folders.** When it deletes files the AI created inside brand-new folders — a fresh `.github/workflows/`, for example — the now-empty folder can remain. In these three runs, the project-file state restored exactly; a leftover empty directory is a known, cosmetic limitation.

### Validation details

```
Candidate:                        0.7.1-beta.3
Source / CI-qualified commit:     101e5d2
Environment:                      Windows, Node 24.13.1
Scenarios:                        3 (Next.js payments, Laravel migration, FastAPI deployment)
Exact project-file restorations:  3 / 3
```
