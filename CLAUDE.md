# doc-upload-site

A document upload/download hosting site with multi tenant access, 3 tier permission system (admin, user, reader), including vbersion traacking. hosted in cloudflare adn backed by d1 maybe? i am open to optinos, we are going to stroe files so it should be cheap! Heres the original specs: Document Upload/Download Portal (Outsourced Website) Purpose: Centralized repository for regulatory documents Security: High priority requirement Access Control: Three-tier login system Admin access User access Reader access Primary Objective: Shared workspace enabling manufacturers and vendors to independently manage their documents, including version tracking and updates/uploads as needed Agent Functionality: Database search capability based on document requests, with automated download and report generation for users

## Commands

- Install: `npm install`
- Build: `npm run build`
- Dev: `npm run dev`
- Test: `npm test`

## Code Style

- Language: TypeScript
- Use functional patterns where possible
- Keep functions small and focused
- Prefer explicit types over `any`

## Workflow

Use the slash commands for common tasks:
- `/up` — Start dev server
- `/down` — Stop services
- `/test` — Run test suite
- `/todo` — Capture a task
- `/plan` — Plan implementation from todo
- `/work` — Implement planned items

## Tracking Files

Four files track the lifecycle of work items:

| File | Purpose |
|------|---------|
| `todo.md` | Quick capture for ideas and tasks. Items are raw, unplanned. |
| `plan.md` | Detailed implementation plans with status, design, file lists, and steps. |
| `FEATURES.md` | Completed features — living changelog of what's been shipped. |
| `backlog.md` | Deferred ideas, long-term research, and items not in the daily workflow. |

**Flow:** `todo.md` (idea) -> `plan.md` (planned -> in-progress -> done) -> `FEATURES.md` (shipped)
**Deferred:** Items moved from `todo.md` to `backlog.md` when not prioritized.

When committing (`/commit`), update tracking files:
1. Remove completed items from `todo.md`
2. Set status to `done` in `plan.md`
3. Add/update entries in `FEATURES.md`

## Task Management

Use `TaskCreate` for concrete work items to track progress:
- Create tasks with clear, actionable subjects
- Set tasks to `in_progress` when starting, `completed` when done
- Use task dependencies (`blocks`/`blockedBy`) for ordering

## Interaction

When you need user input, prefer `AskUserQuestion` with clear options over open-ended questions. This renders a native chooser in the companion app rather than a wall of text.
