# File Integrator for VS Code

Easily collect, organize, order, and format content from files, directories, **and other VS Code resources** within your editor! Perfect for creating context for LLMs, assembling documentation, sharing code snippets, **viewing scoped Git diffs**, or **copying directory structures**.

## Why File Integrator? 🤔

Tired of manually copying and pasting code, running separate `git diff` commands, or generating `tree` outputs? File Integrator streamlines these processes:

-   **🧠 LLM Prompting:** Quickly gather relevant code snippets and file contents (including from library sources) into a single, ordered, formatted block to provide maximum context for AI assistants like ChatGPT, Claude, or Copilot Chat.
-   **📚 Documentation:** Assemble code examples from different parts of your project or dependencies effortlessly, maintaining a logical order.
-   **💬 Code Sharing:** Share context-rich snippets in issues, pull requests, or team chats without hassle.
-   **✅ Code Review:** Generate focused `git diff` outputs for specific files, directories, or logical groups (sessions) directly within VS Code.
-   **📋 Structure Overview:** Copy clean, text-based directory tree structures for documentation or sharing, with configurable exclusions.
-   **📂 Organization:** Use independent **Sessions** to group resources for different tasks, features, or bug reports. Your sessions and their contents **persist** across VS Code restarts!

## Features 🚀

-   **💾 Full Session Persistence:** Your sessions, the resources within them (identified by URI), their hierarchy, and their custom order are **saved and restored** automatically when you restart VS Code.
-   **✨ Multiple Sessions:** Create, rename, and manage independent sessions to organize different sets of resources logically.
-   **➕ Add Active Editor:** Quickly add the currently focused editor tab to a session using an inline button.
-   **🪟 Add All Open Editors:** Add all unique open editor tabs to a specific session using an inline button (excludes duplicates and the session's own generated document).
-   **🖱️ Drag & Drop:** Add standard files or entire directories just by dragging them from the VS Code Explorer onto a session.
-   **↕️ Reorder Items:** Easily drag and drop resources *within* a session's level to change their order. This order is saved and used when generating output.
-   **🌲 Hierarchical View:** Added directories retain their structure within the session view.
-   **👓 Improved Display:** Resources in the tree view show their base name (e.g., `MyClass.java`) as the primary label and the contextual path (e.g., `my-library.jar!/.../mypackage`) as the description. Full path visible in tooltip.
-   **🖱️ Click to Open:** Single-click any file or resource item in the tree view to open it directly in the editor.
-   **⚙️ Configurable Exclusions:**
    *   Define glob patterns (`fileintegrator.exclude`) to ignore unwanted files/folders during **drag-and-drop** from the Explorer.
    *   Define glob patterns (`fileintegrator.excludeFromTree`) to ignore items when using the **Copy Directory Structure** feature.
-   ⚡ **Per-Item Actions:** Quickly perform actions directly on items:
    *   **Inline Icons (Hover):**
        *   **Session:** `➕` (Add Active Editor), `🪟` (Add All Editors), `📄` (Generate), `📋` (Copy Content), `🗑️` (Clear).
        *   **Directory:** `📄` (Generate Content), `📋` (Copy Content), `list-tree` (Copy Structure), `❌` (Remove).
        *   **File:** `❌` (Remove).
    *   **Right-Click Context Menu:**
        *   **Session:** Git Diff options, Undo Last Removal, Expand All Subdirectories, Copy Directory Structure, Rename, Remove Session.
        *   **Directory/File:** Git Diff options, Remove Item.
-   **🔄 Undo Functionality:** Easily restore recently removed files or directories using the "Undo Last Removal" option in the right-click menu.
-   **📂 Directory Management:** Expand all subdirectories within a session using right-click menu options for better navigation.
-   **📄 On-Demand Generation:** Create clean, editable documents for session content or Git diffs when needed.
-   **📋 Easy Copying:** Copy formatted Markdown content, Git diffs, or directory structures to your clipboard with single clicks.
-   **❌ Fine-Grained Removal:** Remove individual resources or directories (and their children) from a session easily via an inline icon.
-   **🌳 Copy Directory Structure (`tree`):** Copy a text-based tree view of the hierarchical structure within a session or a specific directory item (respecting `excludeFromTree` settings).
-   **↔️ Git Diff Integration:** Generate diffs (`git diff HEAD`) for tracked files within sessions, directories (`file://` scheme only, recursive), or individual files. View diffs in a document or copy directly to the clipboard. Requires the built-in `vscode.git` extension.
-   **💨 Asynchronous & Responsive:** Built with async operations to keep your editor snappy.

## Installation 💻

1.  Open **VS Code**.
2.  Go to the **Extensions** view (Ctrl+Shift+X or Cmd+Shift+X).
3.  Search for `File Integrator`.
4.  Click **Install** on the entry by Mahesh Doiphode.
5.  *(Recommended)* Ensure the built-in **Git** extension (`vscode.git`) is enabled for Diff features.

*(Alternatively, download the `.vsix` from [Releases](https://github.com/MaheshDoiphode/vscode-file-integrator/releases) and install via `Extensions View > ... > Install from VSIX...`)*

## Getting Started & Usage 📖

1.  **Open the View:**
    *   Click the **File Integrator icon** in the Activity Bar.
    *   You'll see the "Integration Sessions" view. A "Default Session" is created if none exist.

2.  **Manage Sessions:**
    *   **Create:** Click the `➕` (New Session) icon in the view's title bar.
    *   **Rename:** Right-click a session name -> "Rename Session".
    *   **Remove:** Right-click a session name -> "Remove Session" (requires confirmation).

3.  **Add Resources:**
    *   **Method 1: Drag & Drop (Files/Folders):**
        *   Drag files or directories from the VS Code **Explorer**.
        *   Drop them onto the desired **Session item** or into the view's empty space (adds to the first session).
        *   Exclusions defined in `fileintegrator.exclude` settings will apply here.
    *   **Method 2: Add Active Editor (Single Resource):**
        *   Open the file or resource you want to add in a VS Code editor tab.
        *   In the File Integrator view, hover over the desired **Session item**.
        *   Click the `➕` (Add Active Editor) icon that appears inline.
        *   (`fileintegrator.exclude` settings do *not* apply here).
    *   **Method 3: Add All Open Editors (Multiple Resources):**
        *   Have multiple relevant files open in editor tabs.
        *   In the File Integrator view, hover over the desired **Session item**.
        *   Click the `🪟` (Add All Open Editors) icon that appears inline.
        *   All unique open editors (excluding duplicates, items already in the session, and the session's generated document) will be added to the session root.
        *   (`fileintegrator.exclude` settings do *not* apply here).

4.  **Interact with Items:**
    *   Expand/Collapse Session or Directory: Click `▶`/`▼` or the item label.
    *   The primary label shows the resource name (e.g., `MyClass.java`).
    *   The grey text description next to it shows context (e.g., `my-library.jar!/.../mypackage` or relative path).
    *   **Open Item:** Single-click any file or resource item (non-directory) to open it in the editor.
    *   **Reorder:** Drag an item within the same level (Session root or inside a Directory) and drop it above/below another item to change the order used for content generation.

5.  **Session Actions:**
    *   **Inline Icons (Hover):**
        *   `➕` (Add Active Editor)
        *   `🪟` (Add All Open Editors)
        *   `📄` (Generate Code Block Document)
        *   `📋` (Copy Code Block Content)
        *   `🗑️` (Clear Session - **Immediately** removes all items)
    *   **Right-Click Context Menu:**
        *   Generate Git Diff Document vs HEAD
        *   Copy Git Diff vs HEAD
        *   Undo Last Removal (restores recently removed files)        *   Expand All Subdirectories
        *   Copy Directory Structure
        *   Rename Session
        *   Remove Session

6.  **Resource Item Actions:**
    *   **Directory Items (`resourceDirectory`) - Inline Icons (Hover):**
        *   `📄` (Generate Code Block for Directory Content)
        *   `📋` (Copy Code Block for Directory Content)
        *   `list-tree` (Copy Directory Structure)
    *   **Directory Items - Right-Click Context Menu:**
        *   Generate Git Diff Document for Directory vs HEAD
        *   Copy Git Diff for Directory vs HEAD
        *   Remove Directory and its children from session
    *   **File Items (`resourceFile`) - Right-Click Context Menu:**
        *   Generate Git Diff Document for File vs HEAD
        *   Copy Git Diff for File vs HEAD
        *   Remove File from session

7.  **Advanced Directory Management:**

    *   **Expand All Subdirectories:** Right-click on a session and select this option to expand all directories to show their full content (up to 3 levels deep as per VS Code limitations).
    *   **Undo Last Removal:** Accidentally removed files or directories? Right-click on the session and select "Undo Last Removal" to restore the most recently removed items.

8.  **Using Git Diff:**
    *   Requires the built-in `vscode.git` extension to be enabled.
    *   Operates on resources with the `file://` scheme that are tracked by Git.
    *   Compares the state of tracked files against `HEAD`.
    *   **Session Scope:** Diffs all tracked `file://` resources within the session.
    *   **Directory Scope:** Recursively diffs all tracked `file://` resources under that directory *within the session*.
    *   **File Scope:** Diffs the single tracked file.
    *   Untracked files or non-`file://` resources are skipped.
    *   `Generate Diff` opens the output in a new `.diff` editor tab.
    *   `Copy Diff` copies the output directly to the clipboard.

9.  **Copying Directory Structure (`list-tree` on Directory/Session):**
    *   Generates a text-based tree representation similar to the `tree` command.
    *   Copies the structure to the clipboard.
    *   Files/folders matching patterns in `fileintegrator.excludeFromTree` (based on their path *relative* to the copied root) will be omitted from the output.
    *   Available via inline icon on Directory items and context menu on Session items.

10. **Edit Generated Code/Diff (Optional):**
    *   Documents opened by "Generate Code Block" or "Generate Diff" are standard editor tabs. Edit them freely before copying/saving. Changes here don't affect the session or your Git history.

## Configuring Exclusions 🚫

There are two types of exclusions:

### 1. Content Exclusions (Drag & Drop - `fileintegrator.exclude`)

Prevent unwanted files/folders from being added **when dragging from the Explorer**.
*   Operates on **full file system paths**.
*   Does **not** apply when using "Add Active Editor" or "Add All Open Editors".

**Example `settings.json`:**

```json
{
  // ... other settings ...
  "fileintegrator.exclude": {
    "**/.git": true,          // Ignore .git folders anywhere
    "**/node_modules": true,  // Ignore node_modules anywhere
    "**/target": true,
    "**/build": true,
    "**/*.log": true,         // Ignore all .log files
    "**/.DS_Store": true,
    "**/dist": true,          // Ignore dist folders
    ".vscode/**": true       // Ignore files inside .vscode folder at root
  }
}
```

### 2. Structure Copy Exclusions (`fileintegrator.excludeFromTree`)

Prevent specific files/folders from appearing in the output of the **"Copy Directory Structure"** action.
*   Operates on paths **relative to the root** of the structure being copied (either the session root or the selected directory).
*   Use standard glob patterns.

**Example `settings.json`:**

```json
{
  // ... other settings ...
  "fileintegrator.excludeFromTree": {
    // Common patterns (often match defaults in .gitignore)
    ".git": true,
    "node_modules": true,
    "target": true,
    "build": true,
    "dist": true,
    "*.log": true,         // Exclude log files at any level within the copied structure
    "__pycache__": true,
    ".DS_Store": true,
    "*.lock": true,        // Exclude lock files
    "temp/**": true       // Exclude everything inside a 'temp' folder within the structure
  }
}
```

**Glob Pattern Tips:**

-   `**` : Matches multiple directory levels (`**/node_modules` matches it anywhere).
-   `*` : Matches zero or more characters except `/`.
-   Use `/` as the path separator in patterns.
-   Patterns in `excludeFromTree` match relative to the item you clicked "Copy Structure" on.

## Requirements

-   Visual Studio Code version `1.97.0` or higher.
-   **Git Extension (`vscode.git`):** The built-in Git extension must be enabled for Git Diff functionality.

## Known Issues & Considerations

-   **External Resource Changes:** If a resource added to a session is changed, moved, or deleted *externally*, the link in the File Integrator view becomes stale. Generating content, diffing, or opening it may fail. Remove stale items manually (`❌`).
-   **Git Diff Scope:** Diff functionality only applies to `file://` URIs that are part of a Git repository recognized by the `vscode.git` extension. Untracked files and non-file resources are ignored. Performance on very large repositories or diffs may vary.
-   **Structure Copy Relative Paths:** The relative path calculation for `excludeFromTree` works best for standard `file://` URIs within a workspace. Its behavior for non-file URIs or complex nested structures might be less precise.
-   **Binary Files:** Content display/diffing for binary files may be incorrect or skipped.
-   **Performance:** Adding huge directories or generating content/diffs for sessions with many very large files might take time.
-   **Reordering Scope:** Drag-and-drop reordering only works between items at the same level (siblings within the session root or within the same parent directory).

## Release Notes

### 1.0.0 (Latest)

-   **🚀 Feature: Git Diff Integration!**
    *   Added actions to generate Git diffs compared to `HEAD`.
    *   Available for Sessions, Directories (recursive, tracked `file://` items), and individual Files.
    *   Options to view diff in a document (`$(git-compare)`) or copy to clipboard (`$(clippy)`).
    *   Actions appear as inline icons on hover for Sessions and Files, and inline/context menu for Directories.
    *   Requires the built-in `vscode.git` extension.
-   **✨ Feature: Copy Directory Structure!**
    *   Added action (`$(list-tree)`) to copy a text-based tree representation of a Session or Directory's contents.
    *   Output respects exclusions defined in the new `fileintegrator.excludeFromTree` setting.
    *   Available as inline icon on Directories and via context menu on Sessions.
-   **⚙️ Feature: New `excludeFromTree` Configuration!**
    *   Added `fileintegrator.excludeFromTree` setting to control which files/folders (by relative path) are omitted from the "Copy Directory Structure" output.
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
-   **Perf: Lazy Activation:** Changed activation event to `onView:fileIntegratorView` for faster VS Code startup.

### 0.0.6

-   **Added:** Drag-and-Drop Reordering (sibling level).
-   **Changed:** Internal storage switched to Array for order preservation.

### 0.0.5

-   **Added:** File & Directory Exclusion! Configure glob patterns via `fileintegrator.exclude` setting to ignore unwanted items (e.g., `node_modules`, `.git`).
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

## Feedback & Contributions

Found a bug or have a feature request? Please open an issue on the [GitHub repository](https://github.com/MaheshDoiphode/vscode-file-integrator/issues)! Contributions are welcome.

---

**Enjoy streamlining your code aggregation and review workflow!** 🎉