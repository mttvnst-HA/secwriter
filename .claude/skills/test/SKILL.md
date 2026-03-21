# Test Skill
1. Run `npx vitest run --pool forks` with NODE_OPTIONS='--max-old-space-size=4096'
2. If OOM occurs, try `--no-threads` flag
3. Report pass/fail counts and any failing test names
4. Never report success without actually running tests
