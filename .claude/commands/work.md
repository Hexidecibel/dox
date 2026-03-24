# Work on Planned Items

Implement items from plan.md using TDD. If multiple items can be parallelized, spawn worker sessions.

## Instructions

1. Read plan.md

2. Find ALL items with **Status: planned** or **Status: in-progress**

3. **If 2+ planned items exist, analyze parallelism:**

   a. For each item, look at the "Files to Modify" section
   b. Compare file lists between items — items with NO shared files can run in parallel
   c. Group items into:
      - **Parallel group**: Items with non-overlapping files
      - **Sequential group**: Items that share files with another item

   d. Present the analysis via AskUserQuestion:
      - Show which items can be parallelized and why
      - Show which items must be sequential and why (list shared files)
      - Options: [Parallelize] [Work sequentially] [Let me choose]

   e. If user approves parallelization, spawn worker sessions by calling the
      companion daemon API with a \`spawn_work_group\` message via curl to
      \`http://localhost:9877\`. Include the token from config, a group name,
      the current session ID, the parent directory, and a workers array with
      each worker's taskSlug, taskDescription, planSection, and files list.

   f. After spawning, continue working on sequential items (if any) using TDD
   g. When done with sequential items, check worker status and report

4. **If only 1 item, or user chose sequential:** Follow TDD for each item:

   a. **Write tests first**
      - Create/update test files based on "Tests Needed" section
      - Run tests - they should fail (red)

   b. **Implement the feature**
      - Follow the "Implementation Steps" from plan
      - Make tests pass (green)
      - Run type check: `npx tsc --noEmit`

   c. **Refactor if needed**
      - Clean up code while keeping tests green

   d. **Commit**
      - Commit with descriptive message
      - Update plan.md status to "done"

5. When ALL items are done (including parallel workers), merge if needed by
   calling the daemon API with a \`merge_work_group\` message.

## Rules

- Tests first, always
- Commit after each completed item
- NO push without explicit approval
- Ask if stuck or unclear
- When spawning workers, each worker handles ONE plan item only
- Workers should not modify files outside their scope
