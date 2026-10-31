# Git Workflow

- Commit changes only to the branch active in the primary repository checkout. Do not commit to an auxiliary or Agent Manager worktree branch. If working in an auxiliary worktree, transfer the requested changes to the primary checkout first; if that cannot be done safely, stop and explain the blocker rather than committing to the worktree branch.
- After all changes and fixes requested by the user are implemented and verified, commit and push those task changes to the active branch's upstream. Do not include unrelated pre-existing changes, and respect an explicit user instruction not to commit or push.
- Before committing or pushing, verify the primary checkout, active branch, worktree list, and working tree status. Push to that branch's configured upstream.
