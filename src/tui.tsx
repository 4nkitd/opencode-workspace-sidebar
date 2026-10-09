import { Plugin } from "@opencode/plugin/tui"
import type { FileSystemEntry, SessionInfo } from "@opencode/client"
import { InputRenderable, MouseButton, Renderable, ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { extend, getComponentCatalogue } from "@opentui/solid/components"
import { SpinnerRenderable } from "opentui-spinner"
import type {} from "opentui-spinner/solid"
import { watchFile, unwatchFile } from "node:fs"
import { createEffect, createMemo, For, onCleanup, onMount, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { basename, clean, fileIcon, labels, projectsForSearch, recentSessions, sortedFiles, statusTone, tabIcons, tabs, type Tab, type Tone } from "./model"
import type { Change } from "./git"
import { groupProjects, readProjectGroups, type Group } from "./groups"
import { openMicro, stopMicroLayout } from "./micro"
import { animationsEnabled, cliConfigPath } from "./appearance"
import { editorTerminal } from "./terminal"
import { autoRenameClient } from "./auto-rename-client"
import { supportsOpenCodeLayout } from "./layout-version"

type Row = { id: string; title: string; detail?: string; indent?: number; status?: string; heading?: boolean; directory?: boolean; group?: string; expanded?: boolean; current?: boolean; running?: boolean; hidden?: boolean; pinned?: boolean; icon?: { glyph: string; tone: Tone }; tone?: Tone; run?: () => void; hide?: (hidden: boolean) => Promise<void> | void; pin?: (pinned: boolean) => Promise<void> | void; stage?: () => void; unstage?: () => void; worktrees?: () => void }
type Side = "left" | "right" | "hidden"
type GitState = { root: string; branch: string; changes: Change[] }
type HiddenState = { sessions: string[]; projects: string[] }
type FavoritesState = { projects: string[]; collapsed: boolean }

export default Plugin.define({
  id: "local.workspace-sidebar",
  setup(context) {
    const stopRenaming = autoRenameClient(context)
    if (editorTerminal()) return stopRenaming
    if (!getComponentCatalogue().spinner) extend({ spinner: SpinnerRenderable })
    const [state, update] = context.storage.memory("tabs", { initial: { tab: "projects" as Tab, opened: true } })
    const [settings, saveSettings] = context.storage.store("settings", { initial: { side: "left" as Side } })
    const [hidden, saveHidden] = context.storage.store("hidden", { initial: { sessions: [], projects: [] } as HiddenState })
    const [favorites, saveFavorites] = context.storage.store("favorites", { initial: { projects: [], collapsed: false } as FavoritesState })
    let disposed = false
    let focus: (() => void) | undefined
    let returnToChat: (() => void) | undefined
    let pendingFocus = false
    let focusTimer: ReturnType<typeof setTimeout> | undefined
    const select = (tab: Tab) => {
      pendingFocus = true
      update((draft) => { draft.tab = tab; draft.opened = true })
      if (focus) { pendingFocus = false; return focus() }
    }
    context.keymap.layer(() => ({
      priority: 50,
      commands: [
        ...tabs.map((tab, index) => ({
          id: `workspace-sidebar.${tab}`, title: `Sidebar: ${labels[tab]}`, group: "Workspace sidebar",
           bind: `ctrl+${index + 1}`, palette: true as const, run: () => select(tab),
        })),
        { id: "workspace-sidebar.next", title: "Next sidebar tab", group: "Workspace sidebar", bind: "f6", palette: true, run: () => select(tabs[(tabs.indexOf(state.tab) + 1) % tabs.length]) },
        { id: "workspace-sidebar.toggle", title: "Toggle workspace sidebar", group: "Workspace sidebar", bind: "alt+shift+b", palette: true, run: () => {
          if (state.opened ?? true) { returnToChat?.(); update((draft) => { draft.opened = false }); return }
          select(state.tab)
        } },
      ],
    }))
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{ id: "workspace-sidebar.settings", title: "Sidebar position", group: "Workspace sidebar", palette: true, slash: { name: "sidebar" }, run: async () => {
          const side = await context.ui.dialog.select({
            title: "Sidebar position", current: settings.side,
            options: [{ title: "Left", value: "left" as const }, { title: "Right", value: "right" as const }, { title: "Hidden", value: "hidden" as const }],
          })
          if (disposed || !side) return
          await saveSettings((draft) => { draft.side = side }).catch((error: unknown) => {
            if (!disposed) context.ui.toast.show({ message: `Could not save sidebar position: ${clean(String(error))}`, variant: "error" })
          })
        } }],
    }))
    context.ui.slot({
      append: "app",
      render: () => <Dock context={context} tab={state.tab} side={settings.side} hidden={hidden} saveHidden={saveHidden} favorites={favorites} saveFavorites={saveFavorites} opened={state.opened ?? true} onSelect={select} onFocus={(value, blur) => {
        focus = value
        returnToChat = blur
        if (!value || !pendingFocus) return
        pendingFocus = false
        value()
        // Native route/dialog refocus runs after mounting; preserve the explicitly requested sidebar focus.
        focusTimer = setTimeout(() => {
          if (focus === value && context.keymap.mode.current() === "base") value()
        }, 10)
      }} />,
    })
    return () => { disposed = true; stopRenaming(); stopMicroLayout(context); if (focusTimer) clearTimeout(focusTimer) }
  },
})

function Dock(props: { context: Plugin.Context; tab: Tab; side: Side; hidden: HiddenState; saveHidden: (mutation: (draft: HiddenState) => void) => Promise<void>; favorites: FavoritesState; saveFavorites: (mutation: (draft: FavoritesState) => void) => Promise<void>; opened: boolean; onSelect: (tab: Tab) => void; onFocus: (focus?: () => void, blur?: () => void) => void }) {
  const context = props.context
  const dimensions = useTerminalDimensions()
  const route = () => context.ui.router.current()
  const sessionID = () => { const current = route(); return current.type === "session" ? current.sessionID : undefined }
  let dock: Renderable | undefined
  let host: Renderable | undefined
  const [layout, setLayout] = createStore({ supported: false })
  onMount(() => {
    const parent = dock?.parent
    if (!supportsOpenCodeLayout(context.app.version) || !parent || parent.getChildren()[0] === dock || parent.getLayoutNode().getFlexDirection() !== 0) {
      context.ui.toast.show({ message: "Workspace sidebar layout is unsupported by this OpenCode version", variant: "warning" })
      return
    }
    // The app slot shares the main column. Reflow its siblings; never reparent or patch host render methods.
    host = parent
    setLayout("supported", true)
    onCleanup(() => { if (!parent.isDestroyed) parent.flexDirection = "column" })
  })
  createEffect(() => {
    if (layout.supported && host && !host.isDestroyed) host.flexDirection = props.side === "right" ? "row" : "row-reverse"
  })
  return <box id="workspace-sidebar-dock" ref={(value) => { dock = value }} width={Math.min(42, dimensions().width)} flexShrink={0} height="100%"
    visible={layout.supported && props.opened && props.side !== "hidden" && route().type !== "plugin"}
    paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2} backgroundColor={context.theme.background.raised.base}>
    <Show when={layout.supported && props.opened && props.side !== "hidden" && route().type !== "plugin"}>
      <scrollbox flexGrow={1} minHeight={0} horizontalScrollbarOptions={{ visible: false }}>
        <Sidebar context={context} sessionID={sessionID()} tab={props.tab} hidden={props.hidden} saveHidden={props.saveHidden} favorites={props.favorites} saveFavorites={props.saveFavorites} onFocus={props.onFocus} />
      </scrollbox>
      <box flexShrink={0} gap={1} paddingTop={1}>
          <box flexDirection="row" gap={1}>
            <For each={tabs}>{(tab, index) => (
              <box id={`workspace-tab-${tab}`} flexGrow={1} alignItems="center" paddingTop={1} paddingBottom={1}
                backgroundColor={props.tab === tab ? context.theme.background.raised.high : context.theme.background.raised.base}
                onMouseUp={(event) => { event.stopPropagation(); props.onSelect(tab) }}>
                <text fg={props.tab === tab ? context.theme.text.base : context.theme.text.muted}>
                  <span style={{ fg: tone(context, tabIcons[tab].tone) }}>{tabIcons[tab].glyph}</span> {tab === "projects" ? "Open" : tab === "files" ? "Files" : "Git"}
                </text>
                <text fg={props.tab === tab ? tone(context, tabIcons[tab].tone) : context.theme.text.muted}>Ctrl+{index() + 1}</text>
              </box>
            )}</For>
          </box>
          <text fg={context.theme.text.muted}>F6 tabs · Esc returns to chat</text>
      </box>
    </Show>
  </box>
}

function Sidebar(props: { context: Plugin.Context; sessionID?: string; tab: Tab; hidden: HiddenState; saveHidden: (mutation: (draft: HiddenState) => void) => Promise<void>; favorites: FavoritesState; saveFavorites: (mutation: (draft: FavoritesState) => void) => Promise<void>; onFocus: (focus?: () => void, blur?: () => void) => void }) {
  const context = props.context
  const [state, set] = createStore({
    query: "", selected: "", sessions: [] as SessionInfo[], error: "", busy: false,
    commitMessage: "", gitAction: false, generating: false, openingEditor: false, animations: true,
    files: {} as Record<string, FileSystemEntry[]>, expanded: {} as Record<string, boolean>,
    git: undefined as GitState | undefined, worktrees: {} as Record<string, string[]>,
    project: "", groups: [] as Group[], groupExpanded: {} as Record<string, boolean>, groupsError: "",
  })
  const currentSession = () => props.sessionID ? context.data.session.get(props.sessionID) : undefined
  const directory = () => currentSession()?.location.directory ?? context.location?.directory ?? context.data.location.default().directory
  let input: InputRenderable | undefined
  let commitInput: InputRenderable | undefined
  let previous: Renderable | null = null
  let disposed = false
  let generation = 0
  let draftVersion = 0
  let actionVersion = 0
  let previewGeneration = 0
  let editorVersion = 0
  const nodes = new Map<string, Renderable>()
  const focus = () => {
    if (!input?.focused) previous = context.renderer.currentFocusedRenderable
    input?.focus()
  }
  const blur = () => {
    previewGeneration++
    input?.blur()
    commitInput?.blur()
    if (previous && !previous.isDestroyed) previous.focus()
  }
  onMount(() => props.onFocus(focus, blur))
  onCleanup(() => { disposed = true; generation++; previewGeneration++; actionVersion++; editorVersion++; props.onFocus(undefined) })
  const updateAnimations = () => void animationsEnabled().then((value) => { if (!disposed) set("animations", value) }).catch(() => {})
  updateAnimations()
  watchFile(cliConfigPath(), { interval: 1000, persistent: false }, updateAnimations)
  onCleanup(() => unwatchFile(cliConfigPath(), updateAnimations))

  const fail = (error: unknown) => set("error", clean(error instanceof Error ? error.message : String(error)))
  const setHidden = async (kind: keyof HiddenState, id: string, hidden: boolean) => {
    try {
      await props.saveHidden((draft) => {
        const items = draft[kind]
        const index = items.indexOf(id)
        if (hidden && index < 0) items.push(id)
        if (!hidden && index >= 0) items.splice(index, 1)
      })
    } catch (error) {
      context.ui.toast.show({ message: `Could not update hidden item: ${clean(String(error))}`, variant: "error" })
    }
  }
  const setPinned = async (path: string, pinned: boolean) => {
    try {
      await props.saveFavorites((draft) => {
        const index = draft.projects.indexOf(path)
        if (pinned && index < 0) draft.projects.push(path)
        if (!pinned && index >= 0) draft.projects.splice(index, 1)
      })
    } catch (error) {
      context.ui.toast.show({ message: `Could not update pinned project: ${clean(String(error))}`, variant: "error" })
    }
  }
  const setFavoritesCollapsed = async (collapsed: boolean) => {
    try {
      await props.saveFavorites((draft) => { draft.collapsed = collapsed })
    } catch (error) {
      context.ui.toast.show({ message: `Could not update Favorites section: ${clean(String(error))}`, variant: "error" })
    }
  }
  const showRowMenu = async (row: Row) => {
    const options = [
      ...(row.pin ? [{ title: row.pinned ? "Unpin" : "Pin", value: "pin" as const }] : []),
      ...(row.hide ? [{ title: row.hidden ? "Show" : "Hide", value: "visibility" as const }] : []),
    ]
    if (!options.length) return
    const action = await context.ui.dialog.select({
      title: clean(row.title).replace(/\s/g, " "),
      options,
    })
    if (disposed || !action) return
    if (action === "pin") await row.pin?.(!row.pinned)
    if (action === "visibility") await row.hide?.(!row.hidden)
  }
  const rpc = async (method: string, data: Record<string, string | boolean | { providerID: string; id: string; variant?: string }> = {}) => {
    const result = await context.client.rpc.call({ rpcID: "workspace-sidebar", method, location: { directory: directory() }, input: data })
    return result.output as unknown
  }
  const gitAction = async (method: "stage" | "unstage", path: string) => {
    if (state.gitAction || state.generating || state.busy) return
    const version = ++actionVersion
    set("gitAction", true)
    try {
      await rpc(method, { path })
      if (disposed || version !== actionVersion) return
      await refresh()
    } catch (error) {
      if (!disposed && version === actionVersion) context.ui.toast.show({ message: `Could not ${method} ${path}: ${clean(String(error))}`, variant: "error" })
    } finally {
      if (!disposed && version === actionVersion) set("gitAction", false)
    }
  }
  const generateMessage = async () => {
    if (state.generating || state.gitAction || state.busy) return
    if (!state.git?.changes.some((change) => change.group === "Staged")) {
      context.ui.toast.show({ message: "Stage changes before generating a commit message", variant: "error" })
      return
    }
    const selected = context.ui.model.current()
    if (!selected) {
      context.ui.toast.show({ message: "Select a model before generating a commit message", variant: "error" })
      return
    }
    const version = ++actionVersion
    const draft = ++draftVersion
    const location = directory()
    set("generating", true)
    try {
      const output = await rpc("generateCommitMessage", { model: { providerID: selected.providerID, id: selected.modelID, ...(selected.variant ? { variant: selected.variant } : {}) } })
      if (disposed || version !== actionVersion || directory() !== location || typeof output !== "string") return
      if (draftVersion === draft) {
        set("commitMessage", output)
        if (commitInput && !commitInput.isDestroyed) commitInput.cursorOffset = 0
      }
    } catch (error) {
      if (!disposed && version === actionVersion) context.ui.toast.show({ message: `Could not generate commit message: ${clean(String(error))}`, variant: "error" })
    } finally {
      if (!disposed && version === actionVersion) set("generating", false)
    }
  }
  const commit = async () => {
    const message = state.commitMessage.trim()
    if (!message || state.gitAction || state.generating || state.busy || !state.git?.changes.some((change) => change.group === "Staged")) return
    const version = ++actionVersion
    set("gitAction", true)
    try {
      const output = await rpc("commit", { message })
      if (disposed || version !== actionVersion) return
      set("commitMessage", "")
      context.ui.toast.show({ message: `Committed ${typeof output === "string" ? output.slice(0, 10) : "changes"}`, variant: "success" })
      await refresh()
    } catch (error) {
      if (!disposed && version === actionVersion) context.ui.toast.show({ message: `Could not commit: ${clean(String(error))}`, variant: "error" })
    } finally {
      if (!disposed && version === actionVersion) set("gitAction", false)
    }
  }
  const openSession = (sessionID: string) => {
    editorVersion++
    blur()
    context.ui.router.navigate({ type: "session", sessionID })
  }
  const openProject = (path: string) => {
    editorVersion++
    blur()
    // OpenCode 2.0.23 passes this through to its native router; the public Destination type omits location.
    const target = { type: "home" as const, location: { directory: path } }
    context.ui.router.navigate(target)
  }
  const loadFolder = async (path: string) => {
    const version = generation
    const location = directory()
    const response = await context.client.file.list({ location: { directory: location }, path })
    if (disposed || version !== generation || directory() !== location) return
    set("files", path, sortedFiles(response.data))
  }
  const toggleFolder = (path: string) => {
    set("expanded", path, !state.expanded[path])
    if (state.expanded[path] && !state.files[path]) void loadFolder(path).catch(fail)
  }
  const showPreview = async (path: string, staged?: boolean) => {
    const version = ++previewGeneration
    const location = directory()
    const output = await rpc(staged === undefined ? "preview" : "diff", staged === undefined ? { path } : { path, staged }).catch((error) => {
      if (!disposed && version === previewGeneration) context.ui.toast.show({ message: clean(String(error)), variant: "error" })
    })
    if (disposed || version !== previewGeneration || directory() !== location || context.keymap.mode.current() !== "base" || !input?.focused || typeof output !== "string") return
    context.ui.dialog.show(() => <Preview context={context} title={path} content={output || "No diff available"} diff={staged !== undefined} />)
    context.ui.dialog.set({ size: "xlarge" })
  }
  const editFile = async (path: string) => {
    if (state.openingEditor) return
    const version = ++editorVersion
    const location = directory()
    const cancelled = () => disposed || editorVersion !== version
    set("openingEditor", true)
    try {
      await openMicro(context, location, path, props.sessionID, cancelled)
    } catch (error) {
      if (!cancelled()) context.ui.toast.show({ message: `Could not open Micro: ${clean(String(error))}`, variant: "error" })
    } finally {
      if (!disposed && editorVersion === version) set("openingEditor", false)
    }
  }
  createEffect(() => {
    props.tab
    context.keymap.mode.current()
    previewGeneration++
  })
  const worktreeRuns = new Map<string, number>()
  const loadWorktrees = async (projectID: string) => {
    const run = (worktreeRuns.get(projectID) ?? 0) + 1
    worktreeRuns.set(projectID, run)
    const project = context.data.project.get(projectID)
    if (!project) return
    const list = await context.client.worktree.list({ projectID })
    if (disposed || worktreeRuns.get(projectID) !== run) return
    set("worktrees", projectID, [...new Set([project.canonical, ...list.map((item) => item.directory)])])
  }
  const refresh = async () => {
    const version = ++generation
    const tab = props.tab
    set({ error: "", busy: true })
    try {
      if (tab === "projects") {
        const [response, , groups] = await Promise.all([
          context.client.session.list({ limit: 50, order: "desc", parentID: null }),
          context.data.project.sync(),
          readProjectGroups(),
        ])
        if (disposed || version !== generation) return
        set("sessions", response.data)
        set({ groups: groups.groups, groupsError: groups.error ?? "" })
        if (state.project) await loadWorktrees(state.project)
      }
      if (tab === "files") {
        await Promise.all([loadFolder(""), ...Object.keys(state.expanded).filter((path) => state.expanded[path]).map(loadFolder)])
      }
      if (tab === "git") {
        const output = await rpc("status")
        if (disposed || version !== generation) return
        if (!output || typeof output !== "object" || !("changes" in output) || !Array.isArray(output.changes) || !("root" in output) || typeof output.root !== "string" || !("branch" in output) || typeof output.branch !== "string") throw new Error("Invalid Git response")
        set("git", output as GitState)
      }
    } catch (error) {
      if (!disposed && version === generation) {
        if (tab === "git") set("git", undefined)
        fail(error)
      }
    } finally {
      if (!disposed && version === generation) set("busy", false)
    }
  }
  createEffect(() => {
    directory()
    actionVersion++
    set({ files: {}, expanded: {}, git: undefined, project: "", generating: false, gitAction: false, commitMessage: "" })
  })
  createEffect(() => {
    props.tab
    directory()
    actionVersion++
    set({ generating: false, gitAction: false })
    set({ query: "", selected: "" })
    untrack(() => { void refresh() })
  })
  const interval = setInterval(() => { if (props.tab === "git" && !state.busy) void refresh() }, 5000)
  let eventTimer: ReturnType<typeof setTimeout> | undefined
  const stop = context.data.listen(({ details }) => {
    if (!["session.created", "session.renamed", "session.moved", "session.deleted", "session.execution.succeeded", "session.execution.failed", "project.updated", "worktree.updated", "filesystem.changed", "vcs.branch.updated"].includes(details.type)) return
    generation++
    if (eventTimer) clearTimeout(eventTimer)
    eventTimer = setTimeout(() => { void refresh() }, 250)
  })
  onCleanup(() => { stop(); clearInterval(interval); if (eventTimer) clearTimeout(eventTimer) })

  const rows = createMemo<Row[]>(() => {
    const query = state.query.toLowerCase().trim()
    if (props.tab === "projects") {
      const recent = recentSessions(context.data.session.list(), state.sessions, query,
        context.ui.tabs.enabled() ? context.ui.tabs.list().map((tab) => tab.sessionID) : [], props.hidden.sessions)
      const projects = context.data.project.list()
      const pinned = new Set(props.favorites.projects)
      const pinnedProjects = projectsForSearch(projects, query).filter((project) => pinned.has(project.canonical) && (Boolean(query) || !props.hidden.projects.includes(project.canonical)))
      const grouped = groupProjects(projects, state.groups, query, props.hidden.projects, props.favorites.projects)
      const projectRows = (path: string, indent: number, project?: ReturnType<typeof context.data.project.get>): Row[] => [{
        id: project?.id ?? `directory:${path}`, title: project?.name || basename(path),
        current: currentSession()?.projectID === project?.id && project !== undefined || path === directory() || !!project?.sandboxes.includes(directory()),
        icon: fileIcon(path, true), detail: `${context.ui.format.path(path)}${props.hidden.projects.includes(path) ? " · Hidden" : ""}`, indent,
        run: () => openProject(path),
        hidden: props.hidden.projects.includes(path), pinned: props.favorites.projects.includes(path), hide: (value) => setHidden("projects", path, value),
        ...(project ? { pin: (value: boolean) => setPinned(path, value) } : {}),
        ...(project?.vcs === "git" ? { worktrees: () => {
          set("project", state.project === project.id ? "" : project.id)
          if (state.project) void loadWorktrees(project.id).catch(fail)
        } } : {}),
      }, ...(project && state.project === project.id ? (state.worktrees[project.id] ?? [path]).map((worktree) => ({
        id: `worktree:${worktree}`, title: basename(worktree), detail: context.ui.format.path(worktree), indent: indent + 1,
        current: worktree === directory(), icon: { glyph: "\ue702", tone: "orange" as Tone }, run: () => openProject(worktree),
      })) : [])]
      const favoriteRows = pinnedProjects.length || (props.favorites.projects.length && query) ? [
        { id: "favorites", title: `Favorites (${pinnedProjects.length})`, heading: true, group: "favorites", expanded: !props.favorites.collapsed || !!query, icon: { glyph: "\uf005", tone: "yellow" as Tone }, run: () => void setFavoritesCollapsed(!props.favorites.collapsed) },
        ...(!props.favorites.collapsed || query ? pinnedProjects.flatMap((project) => projectRows(project.canonical, 1, project)) : []),
      ] : []
      return [
        ...favoriteRows,
        { id: "sessions", title: "Sessions", heading: true, icon: { glyph: "\uf086", tone: "purple" } },
        ...recent.map((session): Row => {
          const running = context.data.session.status(session.id) === "running" || context.data.session.family(session.id).some((id) => context.data.session.status(id) === "running")
          return {
            id: session.id, title: session.title || "Untitled session",
            detail: `${basename(session.location.directory)} · ${age(session.time.updated)}${running ? " · Running" : ""}${props.hidden.sessions.includes(session.id) ? " · Hidden" : ""}`,
            running, current: props.sessionID !== undefined && context.data.session.root(props.sessionID) === session.id,
            icon: { glyph: running ? "\uf0e7" : "\uf075", tone: running ? "green" : "purple" },
            run: () => openSession(session.id),
            hidden: props.hidden.sessions.includes(session.id), hide: (value) => setHidden("sessions", session.id, value),
          }
        }),
        { id: "projects", title: "Projects", heading: true, icon: { glyph: "\uf07c", tone: "purple" } },
        ...grouped.groups.flatMap((group): Row[] => {
          const current = group.projects.some((project) => project.id === currentSession()?.projectID || project.canonical === directory()) || group.directories.includes(directory())
          const expanded = !!query || (state.groupExpanded[`group:${group.name}`] ?? current)
          return [{
            id: `group:${group.name}`, title: `${group.name} (${group.projects.length + group.directories.length})`, group: group.name,
            current, icon: { glyph: expanded ? "\uf07c" : "\uf07b", tone: "purple" },
            run: () => set("groupExpanded", `group:${group.name}`, !expanded),
          }, ...(expanded ? [...group.projects.flatMap((project) => projectRows(project.canonical, 1, project)), ...group.directories.flatMap((path) => projectRows(path, 1))] : [])]
        }),
        ...grouped.ungrouped.flatMap((project) => projectRows(project.canonical, 0, project)),
      ]
    }
    if (props.tab === "git") {
      return (["Conflicts", "Staged", "Changes"] as const).flatMap((group): Row[] => {
        const changes = state.git?.changes.filter((item) => item.group === group && item.path.toLowerCase().includes(query)) ?? []
        if (!changes.length) return []
        return [{ id: group, title: `${group}  ${changes.length}`, heading: true, tone: group === "Conflicts" ? "red" : group === "Staged" ? "green" : "yellow", icon: { glyph: group === "Conflicts" ? "\uf071" : group === "Staged" ? "\uf00c" : "\uf044", tone: group === "Conflicts" ? "red" : group === "Staged" ? "green" : "yellow" } }, ...changes.map((item) => ({
           id: `${group}:${item.path}`, title: basename(item.path), detail: item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : undefined,
           icon: fileIcon(item.path, false), status: item.status === "?" ? "U" : item.status, tone: statusTone(item.status), run: () => void showPreview(item.path, group === "Staged"),
           ...(group === "Changes" && item.status !== "U" ? { stage: () => void gitAction("stage", item.path) } : {}),
           ...(group === "Staged" && item.status !== "U" ? { unstage: () => void gitAction("unstage", item.path) } : {}),
        }))]
      })
    }
    const walk = (path: string, indent: number): Row[] => (state.files[path] ?? []).flatMap((item): Row[] => [
      ...(!query || item.path.toLowerCase().includes(query) ? [{
        id: item.path, title: basename(item.path), icon: fileIcon(item.path, item.type === "directory", !!state.expanded[item.path]),
        indent, directory: item.type === "directory", run: () => item.type === "directory" ? toggleFolder(item.path) : void editFile(item.path),
      }] : []),
      ...(item.type === "directory" && state.expanded[item.path] ? walk(item.path, indent + 1) : []),
    ])
    return walk("", 0)
  })
  const selectable = createMemo(() => rows().filter((row) => row.run))
  createEffect(() => {
    if (!selectable().some((row) => row.id === state.selected)) set("selected", selectable()[0]?.id ?? "")
  })
  const move = (delta: number) => {
    const list = selectable()
    const index = list.findIndex((row) => row.id === state.selected)
    const row = list[Math.max(0, Math.min(list.length - 1, index + delta))]
    if (!row) return
    set("selected", row.id)
    const node = nodes.get(row.id)
    if (!node) return
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (!(parent instanceof ScrollBoxRenderable)) continue
      parent.scrollTo(Math.max(0, node.y - parent.content.y - 3))
      break
    }
  }
  context.keymap.layer(() => ({
    target: () => input, priority: 30,
    commands: [
      { bind: "down", run: () => move(1) }, { bind: "up", run: () => move(-1) },
      { bind: "return", run: () => selectable().find((row) => row.id === state.selected)?.run?.() },
      { bind: "escape", run: blur },
      { bind: "right", enabled: () => props.tab === "files" && !state.query, run: () => {
        const row = selectable().find((row) => row.id === state.selected)
        if (!row?.directory) return
        if (!state.expanded[row.id]) return row.run?.()
        move(1)
      } },
      { bind: "left", enabled: () => props.tab === "files" && !state.query, run: () => {
        if (state.expanded[state.selected]) return toggleFolder(state.selected)
        const path = state.selected.replace(/\/$/, "")
        const parent = path.slice(0, path.lastIndexOf("/") + 1)
        if (parent && nodes.has(parent)) set("selected", parent)
      } },
      { bind: "ctrl+r", run: () => { void refresh() } },
    ],
  }))
  context.keymap.layer(() => ({
    target: () => commitInput, enabled: () => props.tab === "git" && state.git !== undefined,
    commands: [{ bind: "escape", run: blur }],
  }))

  return (
    <box gap={props.tab === "git" ? 0 : 1}>
      <text marginBottom={props.tab === "git" ? 1 : 0} fg={tone(context, tabIcons[props.tab].tone)}><b>{tabIcons[props.tab].glyph} {labels[props.tab]}</b></text>
      <input id="workspace-search" ref={(value) => { input = value }} value={state.query}
        on:blur={() => { previewGeneration++ }}
        placeholder={props.tab === "projects" ? "Search sessions and projects…" : props.tab === "files" ? "Filter visible files…" : "Filter changes…"}
        onInput={(value) => set("query", value)}
        onMouseDown={() => { if (!input?.focused) previous = context.renderer.currentFocusedRenderable }}
        backgroundColor={context.theme.background.raised.high} textColor={context.theme.text.base}
        focusedBackgroundColor={context.theme.background.raised.high} focusedTextColor={context.theme.text.base} />
      <Show when={props.tab === "files"}><text fg={context.theme.text.muted} truncate wrapMode="none">{basename(directory())}</text></Show>
      <Show when={state.openingEditor}><text fg={context.theme.text.muted}>Opening Micro…</text></Show>
       <Show when={props.tab === "git" && state.git}>
         <text fg={context.theme.text.base} truncate wrapMode="none">{basename(state.git!.root)} <span style={{ fg: tone(context, "orange") }}>{tabIcons.git.glyph} {state.git?.branch}</span></text>
       </Show>
      <Show when={props.tab === "git" && state.git}>
         <input id="workspace-commit-message" value={state.commitMessage} onInput={(value) => { draftVersion++; set("commitMessage", value) }} ref={(value) => { commitInput = value }}
           onMouseDown={(event) => { event.stopPropagation(); if (context.renderer.currentFocusedRenderable !== input && context.renderer.currentFocusedRenderable !== commitInput) previous = context.renderer.currentFocusedRenderable; commitInput?.focus() }}
           placeholder="Commit message" backgroundColor={context.theme.background.raised.high} textColor={context.theme.text.base} focusedBackgroundColor={context.theme.background.raised.high} focusedTextColor={context.theme.text.base} />
        <box flexDirection="row" gap={1}>
          <box id="workspace-generate-message" paddingLeft={1} paddingRight={1} onMouseUp={(event) => { event.stopPropagation(); void generateMessage() }}>
            <text fg={state.generating || state.gitAction || !state.git?.changes.some((change) => change.group === "Staged") ? context.theme.text.muted : tone(context, "purple")}>{state.generating ? "Generating…" : "\uf0d0 Generate"}</text>
          </box>
          <box id="workspace-commit" paddingLeft={1} paddingRight={1} onMouseUp={(event) => { event.stopPropagation(); void commit() }}>
            <text fg={state.commitMessage.trim() && !state.gitAction && !state.generating && state.git?.changes.some((change) => change.group === "Staged") ? tone(context, "green") : context.theme.text.muted}>{state.gitAction ? "Working…" : "\uf00c Commit"}</text>
          </box>
        </box>
      </Show>
      <Show when={state.error}><text fg={context.theme.text.feedback.error.base}>{state.error}{"\n"}Ctrl+R to retry</text></Show>
      <Show when={props.tab === "projects" && state.groupsError}><text fg={context.theme.text.feedback.error.base}>{state.groupsError}</text></Show>
      <Show when={state.busy && !rows().length}><text fg={context.theme.text.muted}>Loading…</text></Show>
      <box>
        <For each={rows()}>{(row) => (
          <box id={`workspace-row-${row.id}`} ref={(value) => { nodes.set(row.id, value); onCleanup(() => nodes.delete(row.id)) }}
             paddingLeft={Math.min(row.indent ?? 0, 8) * 2} paddingTop={row.heading ? 1 : 0} flexDirection="row"
             backgroundColor={row.current && row.id.startsWith("ses_") ? (context.themeMode === "dark" ? "#1f3041" : "#d9eafa") : row.id === state.selected ? context.theme.background.raised.high : undefined}
             onMouseUp={row.run || row.hide ? (event) => {
               event.stopPropagation()
               if (event.button === MouseButton.RIGHT && row.hide) { focus(); set("selected", row.id); void showRowMenu(row); return }
               if (event.button === MouseButton.LEFT && row.run) { focus(); set("selected", row.id); row.run() }
             } : undefined}>
              <Show when={!row.heading}>
              <box width={1} flexShrink={0}>
                 <text fg={row.current ? tone(context, "blue") : tone(context, "green")}>{row.running || row.current ? "▎" : " "}</text>
                 <Show when={row.detail && row.id.startsWith("ses_")}><text fg={row.current ? tone(context, "blue") : tone(context, "green")}>{row.running || row.current ? "▎" : " "}</text></Show>
              </box>
            </Show>
              <box flexGrow={1} minWidth={0}>
              <box flexDirection="row" justifyContent="space-between">
                <box flexDirection="row" flexShrink={1} minWidth={0}>
                   <Show when={row.directory}><text fg={context.theme.text.muted}>{state.expanded[row.id] ? "▾ " : "▸ "}</text></Show>
                <Show when={row.group}><text fg={context.theme.text.muted}>{row.expanded !== undefined ? (row.expanded ? "▾ " : "▸ ") : state.query || state.groupExpanded[row.id] || (state.groupExpanded[row.id] === undefined && row.current) ? "▾ " : "▸ "}</text></Show>
                   <Show when={row.icon}>
                     <Show when={row.running} fallback={<text fg={tone(context, row.icon!.tone)} flexShrink={0}>{row.icon!.glyph} </text>}>
                       <box width={2} flexShrink={0}>
                         <Show when={state.animations} fallback={<text fg={context.theme.text.feedback.success.base}>⋯</text>}>
                           <spinner frames={["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]} interval={80} color={context.theme.text.feedback.success.base} />
                         </Show>
                       </box>
                     </Show>
                   </Show>
                   <text fg={row.heading ? (row.tone ? tone(context, row.tone) : context.theme.hue.accent[200]) : props.tab === "git" && row.tone ? tone(context, row.tone) : context.theme.text.base} truncate wrapMode="none" flexShrink={1}>{clean(row.title).replace(/\s/g, " ")}</text>
                   <Show when={row.detail && props.tab === "git"}><text fg={context.theme.text.muted} truncate wrapMode="none" flexShrink={2}> {clean(row.detail!).replace(/\s/g, " ")}</text></Show>
                 </box>
                 <Show when={row.stage || row.unstage}>
                   <box id={`workspace-${row.stage ? "stage" : "unstage"}-${row.id}`} paddingLeft={1} paddingRight={1} flexShrink={0}
                     onMouseUp={(event) => { event.stopPropagation(); (row.stage ?? row.unstage)?.() }}>
                     <text fg={state.gitAction || state.generating ? context.theme.text.muted : tone(context, row.stage ? "green" : "yellow")}>{row.stage ? "+" : "−"}</text>
                   </box>
                 </Show>
                  <Show when={row.worktrees}><box id={`workspace-worktrees-${row.id}`} paddingLeft={1} paddingRight={1} flexShrink={0} onMouseUp={(event) => { event.stopPropagation(); row.worktrees?.() }}><text fg={tone(context, "orange")}>{tabIcons.git.glyph}</text></box></Show>
                 <Show when={row.status}><text fg={tone(context, row.tone ?? statusTone(row.status!))} flexShrink={0}> {row.status}</text></Show>
               </box>
               <Show when={row.detail && props.tab !== "git"}><text fg={context.theme.text.muted} truncate wrapMode="none">{clean(row.detail!).replace(/\s/g, " ")}</text></Show>
            </box>
          </box>
        )}</For>
      </box>
      <Show when={!state.busy && !state.error && !selectable().length}>
        <text fg={props.tab === "git" && !state.query ? tone(context, "green") : context.theme.text.muted}>{props.tab === "git" && !state.query ? "\uf00c Working tree clean" : "No matching entries"}</text>
      </Show>
      <box marginTop={props.tab === "git" ? 1 : 0} onMouseUp={() => { void refresh() }}><text fg={context.theme.text.muted}>↻ Refresh · Ctrl+R when focused</text></box>
    </box>
  )
}

function Preview(props: { context: Plugin.Context; title: string; content: string; diff: boolean }) {
  let scroll: ScrollBoxRenderable | undefined
  const lines = () => clean(props.content.slice(0, 128 * 1024)).split("\n").slice(0, 2000)
  props.context.keymap.layer(() => ({
    mode: "modal", commands: [
      { bind: "down", run: () => scroll?.scrollBy(1) }, { bind: "up", run: () => scroll?.scrollBy(-1) },
      { bind: "pagedown", run: () => scroll?.scrollBy(16) }, { bind: "pageup", run: () => scroll?.scrollBy(-16) },
    ],
  }))
  return <box padding={1} gap={1}>
    <text fg={props.context.theme.text.base}><b>{clean(props.title).replace(/\s/g, " ")}</b></text>
    <scrollbox height={Math.max(4, Math.min(26, props.context.renderer.height - 10))} ref={(value) => { scroll = value }}>
      <text fg={props.context.theme.text.base}>
        <For each={lines()}>{(line) => <span style={{ fg: props.diff && line.startsWith("+") ? props.context.theme.diff.text.added : props.diff && line.startsWith("-") ? props.context.theme.diff.text.removed : props.diff && line.startsWith("@@") ? props.context.theme.diff.text.hunkHeader : props.context.theme.text.base }}>{line}{"\n"}</span>}</For>
        <Show when={props.content.length > 128 * 1024 || props.content.split("\n").length > 2000}>[Preview truncated]</Show>
      </text>
    </scrollbox>
    <text fg={props.context.theme.text.muted}>↑↓ scroll · Esc close</text>
  </box>
}

function age(timestamp: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000))
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / 1440)}d`
}

function tone(context: Plugin.Context, name: Tone) {
  if (name === "muted") return context.theme.text.muted
  const dark = { blue: "#75bfff", yellow: "#e8c46a", purple: "#bb9af7", green: "#7bd88f", orange: "#f4a66b", red: "#ff7c89", teal: "#65d5d5" }
  const light = { blue: "#1866a7", yellow: "#826200", purple: "#7043ad", green: "#28753c", orange: "#a54d13", red: "#b52b43", teal: "#087a7a" }
  return (context.themeMode === "dark" ? dark : light)[name]
}
