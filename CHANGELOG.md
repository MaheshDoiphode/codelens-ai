## Release Notes

### 1.0.3 (Latest)

- **⚡ Performance: Extension Optimization & Bundling!**
  - Implemented webpack bundling for significantly improved performance and faster load times.
  - **📊 Size Reduction:** Package size reduced by over 80%, now only 79.9 KB.
  - **🚀 Streamlined Structure:** Decreased from 167 files to just 19 files in the extension package.
  - **⏱️ Faster Loading:** All dependencies now bundled into a single minified JavaScript file.
  - **🧹 Cleaner Distribution:** Removed unnecessary development files from the published package.
### 1.0.2 (Latest)

-   **🎉 Project Renamed to CodeLens AI & Configuration Update!**
    *   "File Integrator" is now **CodeLens AI**, better reflecting its role in AI-assisted development.
    *   **⚠️ IMPORTANT:** Configuration settings in `settings.json` **must be updated**:
        *   `fileintegrator.exclude` is now **`codelensai.exclude`**.
        *   `fileintegrator.excludeFromTree` is now **`codelensai.excludeFromTree`**.
    *   Update your settings if you have custom configurations. Previous `fileintegrator.*` settings are no longer read.

### 1.0.1

-   **🎉 Project Renamed to CodeLens AI!**
    *   The extension has been renamed from "File Integrator" to "CodeLens AI" to better reflect its capabilities in assisting AI-driven development workflows.
    *   **Configuration Update:** Settings have been updated:
        *   `fileintegrator.exclude` is now `codelensai.exclude`.
        *   `fileintegrator.excludeFromTree` is now `codelensai.excludeFromTree`.
        *   Please update your `settings.json` if you have custom configurations.
-   **✨ Feature: Undo Last Removal!**
    *   Added "Undo Last Removal" functionality to restore recently removed files or directories. Accessible via the session's right-click context menu.
-   **✨ Feature: Expand All Subdirectories!**
    *   Introduced "Expand All Subdirectories" option for sessions, allowing easier navigation of nested structures (up to 3 levels deep). Accessible via the session's right-click context menu.
-   **🎨 UI: Improved Actions and Context Menus!**
    *   Refined user interface by reorganizing actions. Many common operations are now available as inline hover icons on tree items (Sessions, Directories, Files).
    *   More comprehensive actions remain in right-click context menus, providing a cleaner and more intuitive user experience.
-   **🛠️ Fix: Copy Directory Structure Accuracy!**
    *   Improved the "Copy Directory Structure" feature to more reliably copy the entire intended tree structure.

### 1.0.0

-   **🚀 Feature: Git Diff Integration!**
    *   Added actions to generate Git diffs compared to `HEAD`.
    *   Available for Sessions, Directories (recursive, tracked `file://` items), and individual Files.
    *   Options to view diff in a document (`$(git-compare)`) or copy to clipboard (`$(clippy)`).
    *   Actions appear as inline icons on hover for Sessions and Files, and inline/context menu for Directories.
    *   Requires the built-in `vscode.git` extension.
-   **✨ Feature: Copy Directory Structure!**
    *   Added action (`$(list-tree)`) to copy a text-based tree representation of a Session or Directory's contents.
    *   Output respects exclusions defined in the new `codelensai.excludeFromTree` setting (formerly `fileintegrator.excludeFromTree`).
    *   Available as inline icon on Directories and via context menu on Sessions.
-   **⚙️ Feature: New `excludeFromTree` Configuration!**
    *   Added `codelensai.excludeFromTree` setting (formerly `fileintegrator.excludeFromTree`) to control which files/folders (by relative path) are omitted from the "Copy Directory Structure" output.
-   **UI:** Moved Git Diff actions for Sessions and Files to be inline icons instead of context menu items for quicker access.
-   **Fix:** Corrected logic for Git diff calculation, especially for repository root diffs and reporting of "No Changes" vs "No Trackable Files".
-   **Build:** Added explicit dependency on `vscode.git` extension in `package.json`.
-   **Refactor:** Improved internal diff calculation logic and user feedback messages.

### 0.0.8

-   **✨ Feature: Add All Open Editors!** New inline button `🪟` on session items adds all unique open editor tabs to that specific session. Skips duplicates, already included items, and the session's own generated document.
-   **Refactor:** Moved "Add All Open Editors" command from view title to session item context menu (inline).
-   **Refactor:** Code comment cleanup for better readability.

### 0.0.7

-   **🚀 Feature: URI Support!** Can now add resources beyond simple files (e.g., files inside JARs/archives, untitled files) using the "Add Active Editor" button. Core logic updated to use URIs as primary identifiers.
-   **✨ Feature: Add Active Editor!** New inline button `➕` on session items to quickly add the current editor's content without prompts.
-   **✨ Feature: Click to Open!** Single-clicking file/resource items in the tree view now directly opens them in the editor.
-   **💾 Feature: Full Session Persistence!** Sessions now save and restore their complete state, including the list of resources (identified by URI), their hierarchy, and their user-defined order, across VS Code restarts. Persistence layer updated to store URIs; includes migration from older path-based versions (v1/v2). Storage key version bumped to v3.
-   **👓 UI: Improved Display:** Enhanced display for non-file URIs (like archives) in the tree view description and generated Markdown headers for better readability.
-   **UI: No Clear Confirmation:** Removed the confirmation dialog when clearing a session for faster workflow.
-   **Fix:** Tree view now reliably updates immediately when adding items via "Add Active Editor".
-   **Fix:** Compilation Errors:** Resolved TypeScript compilation errors related to persistence loading.
-   **Refactor: Async Content Generation:** Content generation (`generateMarkdownContent`) is now fully asynchronous and reads resource content on demand using VS Code APIs if not already loaded (e.g., after restart).
-   **Perf: Lazy Activation:** Changed activation event to `onView:fileIntegratorView` (internal ID, may change to `onView:codeLensAiView`) for faster VS Code startup.

### 0.0.6

-   **Added:** Drag-and-Drop Reordering (sibling level).
-   **Changed:** Internal storage switched to Array for order preservation.

### 0.0.5

-   **Added:** File & Directory Exclusion! Configure glob patterns via `codelensai.exclude` setting (formerly `fileintegrator.exclude`) to ignore unwanted items (e.g., `node_modules`, `.git`).
-   **Added:** Notification when items are skipped due to exclusion rules.
-   **Improved:** README updated with comprehensive usage and exclusion configuration details.

### 0.0.4

-   **Added:** Multiple Session Support! Create, rename, and remove independent file collections (Fixes #2).
-   **Added:** Session-specific actions (Generate, Copy, Clear) via inline icons and context menus.
-   **Changed:** Dragging files now only adds to the session list; the Markdown document is only created/updated/shown via the explicit "Generate" action.
-   **Improved:** Switched to asynchronous file operations for better performance.
-   **Added:** Session names and IDs are now persisted between VS Code restarts (content was not persisted in this version).
-   **Fixed:** Corrected issues with file and directory removal logic.

### 0.0.3

-   Removed webview in favor of document-based editing.
-   Added support for dynamic updates (behavior changed in 0.0.4).
-   Improved code block generation.

### 0.0.2

-   Initial release.
-   Drag and drop files.
-   Generate and copy markdown code blocks.