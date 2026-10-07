# Verification

Release target: **0.1.2**, OpenCode **2.0.23**, tested on macOS arm64.

## Checks

- Typecheck, build, and 50 unit/integration tests.
- Full packaged-runtime terminal suite: tab keys and mouse input, file tree, groups, worktree creation/removal, native navigation, welcome/chat dock, saved placement across a fresh TUI, Git stage/unstage, generated and manually edited commit message, staged-only Commit.
- Git layout assertions verify adjacent compact filter/branch/message controls, one-line Generate/Commit actions, and one separator before each change group.
- Delayed diff responses are cancelled by Esc, switching tabs, and opening Ctrl+O. The test waits for rendered hit targets before clicking and for dialog focus restoration before editing.
- Micro opens a disposable file, edits it, saves it and exits. Equal chat/editor widths are checked at 150, 181 and 100 terminal columns; closing restores chat width.
- Editor-terminal suppression leaves native Ctrl+O and prompt width intact.
- Automatic naming: quarter thresholds, duplicate suppression, compaction reset, reload persistence, manual rename during generation, and a cancelled 25% refresh retried at 26%.

## Regression fixes for release

The former full-suite failures included fixture projects hidden by the intentional `/private` project filter, click targets inspected before the rendered hit grid was current, and native dialog focus restoration racing subsequent input. Fixture repositories now live under a dedicated user cache directory; test input synchronizes with rendering and focus. The local delay proxy requests uncompressed upstream responses.

The suite also exposed a real commit-message mouse-focus bug. Clicking that field now explicitly focuses it without changing the draft. Commit verification edits the generated message and checks that unstaged changes and untracked files remain outside the commit.

## Isolation and evidence

Tests launch private authenticated loopback servers with separate HOME/XDG paths and databases. Git mutations target disposable repositories. Generation uses a local model fixture rather than user credentials. Only test-owned processes are stopped.

Framebuffer PNGs and JSON frames are generated under ignored `artifacts/`. They are real terminal captures, not browser mockups. Naming verification targets the selected compiled server package and the source-imported client coordinator; separate terminal checks load the compiled TUI.

Global runtime copies, credentials, account stores, generated logs, screenshots, and rollback backups are not included in the repository or npm package.

## Not verified

- OpenCode versions other than 2.0.23.
- Remote client/server deployments.
- Interactive terminal behavior on Linux or Windows. CI checks build and unit tests separately.
