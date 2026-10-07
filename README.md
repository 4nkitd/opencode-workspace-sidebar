# OpenCode workspace sidebar

Projects, sessions, files and Git in one terminal sidebar for **OpenCode 2.0.23**. Works on the welcome screen and in chats, with three bottom tabs and a saved left/right position.

## Install

Add the package to the existing `plugins` array in your global `~/.config/opencode/opencode.json`:

```json
{
  "plugins": ["opencode-workspace-sidebar@0.1.2"]
}
```

Add it to `~/.config/opencode/cli.json` as well, and hide the native sidebar to avoid a duplicate:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["opencode-workspace-sidebar@0.1.2"],
  "session": { "sidebar": "hide" }
}
```

Merge these settings rather than replacing your existing configuration. Paths respect `XDG_CONFIG_HOME`. Open a fresh OpenCode TUI after installation; existing processes may retain their previous plugin snapshot.

Install [Micro](https://micro-editor.github.io/) on the OpenCode server for file editing:

```sh
brew install micro          # macOS
sudo apt-get install micro # Debian / Ubuntu
```

Both plugin entrypoints are included: `.` for the server and `./tui` for the terminal. Remote servers need the server half and Micro installed there. Remote operation has not been verified. The layout adapters are guarded for OpenCode **2.0.23**; other versions are unsupported until tested.

## Features

- **Projects & Sessions:** native Ctrl+O data and navigation, eight recent root sessions, search across a 50-session pool, grouped projects, and existing worktrees. Opening a project switches the working location; it does not start services.
- **Files:** expandable, folder-first tree with colored file icons. Filtering covers loaded entries, not a recursive filesystem search. Click a file to edit it in Micro.
- **Git:** staged, unstaged, conflict and untracked changes; diff previews; per-file stage/unstage; editable generated commit messages; staged-only commits. No automatic staging, discard or push.
- **Session status:** native running spinner and a steady blue current-session indicator.
- **Automatic titles:** refresh generated session names at context milestones without injecting chat prompts. See the model-usage notes below.

The visual sidebar is disabled in VS Code/VSCodium integrated terminals identified by `TERM_PROGRAM=vscode`. It registers no sidebar layout or shortcuts there. Automatic naming remains active, and native Ctrl+O is unchanged.

## Controls

| Key | Action |
| --- | --- |
| Alt+1 / Alt+2 / Alt+3 | Projects & Sessions / Files / Git |
| F6 | Next sidebar tab |
| Up / Down | Select entries while sidebar search is focused |
| Enter | Open selected entry |
| Right / Left | Expand/collapse folders or navigate their hierarchy |
| Esc | Return to chat or close a diff dialog |
| Ctrl+R | Refresh while sidebar search is focused |
| Ctrl+X, B | Toggle sidebar with the default leader key |
| `/sidebar` | Choose and save Left or Right placement |
| Ctrl+S / Ctrl+Q | Save / close Micro while the file pane is focused |

On macOS, Alt means Option. If Ghostty sends `¡`, `™`, and `£` instead, add these mappings to its configuration and reload it:

```ini
keybind = alt+1=csi:49;3u
keybind = alt+2=csi:50;3u
keybind = alt+3=csi:51;3u
```

The plugin does not modify your terminal configuration.

## File editing

Chat and the file pane share the available width **1:1**, excluding the workspace sidebar. The split follows window resizing, with at most one column of rounding. The native drag divider is hidden during this fixed split and restored when the editor closes or the plugin unloads. Other terminal panes are not resized.

Files open through OpenCode's persistent-PTY API. Paths are separate arguments, not interpolated shell commands. From home, opening a file creates an editor-only session without a model prompt. Switching panes does not kill existing terminal processes.

Click inside the file pane, then press **Ctrl+Q** to close it. Use **Ctrl+S** to save first.

## Project groups

Create `~/.config/opencode/workspace-sidebar.json`:

```json
{
  "groups": [
    {
      "name": "Services",
      "directories": ["~/projects/api", "~/projects/worker"]
    }
  ]
}
```

Group headings expand/collapse. Refresh rereads the JSON. The branch icon lists existing worktrees; native Ctrl+O provides worktree creation. Projects under `/private` are hidden from project lists, including grouped searches, without deleting their records or hiding associated sessions.

## Automatic titles and model usage

Newly auto-named root sessions refresh after crossing **25%, 50%, 75%, and 100%** of the model's context limit. The count comes from the latest completed assistant response, including cached tokens, not cumulative session usage. OpenCode usually compacts before 100%.

Refreshes wait for a successful idle turn. Several quarters crossed in one turn produce one refresh. Successful compaction starts a fresh cycle after another assistant response; compaction alone does not trigger a rename. Checkpoints survive plugin reloads and coordinate multiple connected TUIs. Failed or cancelled refreshes remain eligible on a later check.

Manually choosing a different title stops automatic updates for that session. Existing named sessions and subagents are not enrolled because native rename events do not identify who chose their names. A connected TUI is required; this is not a headless scheduler.

Title refreshes use OpenCode's selected title model with bounded conversation text and incur normal model usage. Git's **Generate** action uses the selected chat model and a bounded staged diff. Neither feature commits files automatically. Native title-generation safeguards preserve titles changed while generation is running.

## Development

Requires Bun 1.3.10, Git and Micro. Full terminal verification also requires OpenCode 2.0.23. Ghostty OS captures additionally require macOS and automation permissions.

```sh
bun install --frozen-lockfile
bun run check
bun run verify
bun scripts/verify-rename.ts
SIDEBAR_VERIFY_SPLIT=1 bun run verify
SIDEBAR_VERIFY_EDITOR=1 bun run verify
```

Tests use private server/database instances, disposable Git repositories and a local model fixture. They do not call paid models, commit in real projects, or restart the shared OpenCode service. `SIDEBAR_RUNTIME=/path/to/unpacked/package` targets a packaged build. Generated logs and screenshots stay in ignored `artifacts/`.

## Limits

- The dock reserves 42 terminal columns. Hide it to recover space in narrow windows.
- Layout uses the public app slot plus version/structure-guarded 2.0.23 adapters. Unknown host versions are not silently patched.
- Native project-home navigation uses a 2.0.23 router field omitted from the public plugin type declarations; it is covered by terminal integration tests.
- Previews are limited to 128 KiB and 2,000 displayed lines. Binary files and symlinks escaping the project are rejected. Git output is capped at 2 MiB.
- Git and Micro run on the connected OpenCode server, not on an unrelated client-side repository.

## License

MIT, copyright 2026 4nkitd.
