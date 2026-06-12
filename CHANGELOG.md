# Changelog

All notable changes to ai-workflow-engine are documented here.
Versions use the 4-digit MAJOR.MINOR.PATCH.MICRO format.

## [0.1.0.0] - 2026-06-12

### Added

- The engine is now embeddable as a library: import `runWorkflow`,
  `loadWorkflow`, the claude/codex adapter factories, and the escalation
  channel types from the package root. Host processes (such as a long-running
  dispatcher) can run workflows without the CLI.
- `RunOptions.cwd` sets the working directory for a whole run: agents spawn
  there by default (a per-call cwd still wins, and a relative one resolves
  against the run cwd), and permission defer rules are read from that
  directory's `.claude` settings. A nonexistent cwd fails fast at run start.
- Permission defer rules are now directory-scoped: a project's committed
  `.claude` rules only cover agents actually running inside that directory,
  and `escalation.trustCwdSettings: false` skips a checkout's settings
  entirely. The run log reports how many rules loaded and from where.

### Fixed

- The installed `ai-workflow-engine` bin now executes on unix (shebang was
  missing), and publishing always builds and tests first, so a stale `dist/`
  can never ship.
