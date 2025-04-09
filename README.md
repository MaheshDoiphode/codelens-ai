# File Integrator for VS Code

Easily collect, organize, order, and format content from files, directories, **and other VS Code resources** within your editor! Perfect for creating context for LLMs, assembling documentation, or sharing code snippets.

## Why File Integrator? 🤔

Tired of manually copying and pasting code from various files and sources? File Integrator streamlines this process:

-   **🧠 LLM Prompting:** Quickly gather relevant code snippets and file contents (including from library sources) into a single, ordered, formatted block to provide maximum context for AI assistants like ChatGPT, Claude, or Copilot Chat.
-   **📚 Documentation:** Assemble code examples from different parts of your project or dependencies effortlessly, maintaining a logical order.
-   **💬 Code Sharing:** Share context-rich snippets in issues, pull requests, or team chats without hassle.
-   **📂 Organization:** Use independent **Sessions** to group resources for different tasks, features, or bug reports. Your sessions and their contents **persist** across VS Code restarts!

## Features 🚀

-   **💾 Full Session Persistence:** Your sessions, the resources within them (identified by URI), their hierarchy, and their custom order are **saved and restored** automatically when you restart VS Code.
-   **✨ Multiple Sessions:** Create, rename, and manage independent sessions to organize different sets of resources logically.
-   **🔗 Add Active Editor:** Quickly add the currently focused editor tab (including library files, decompiled sources, etc.) to a session using a dedicated inline button.
-   **🖱️ Drag & Drop:** Add standard files or entire directories just by dragging them from the VS Code Explorer onto a session.
-   **↕️ Reorder Items:** Easily drag and drop resources *within* a session's level to change their order. This order is saved and used when generating output.
-   **🌲 Hierarchical View:** Added directories retain their structure within the session view.
-   **👓 Improved Display:** URIs for library files (e.g., inside JARs/ZIPs) are shown concisely in the tree view and informatively in generated output.
-   **⚙️ Customizable Exclusions:** Define glob patterns (`fileintegrator.exclude`) to ignore unwanted files/folders during **drag-and-drop** from the Explorer.
-   ⚡ **Per-Session Actions:** Quickly Add Active Editor, Generate, Copy, or Clear content for specific sessions using inline icons.
-   **📄 On-Demand Generation:** Create a clean, editable Markdown document showing resource identifiers and content *only* when you click "Generate Code Block".
-   **📋 Easy Copying:** Copy the entire formatted Markdown block for a session (respecting order) to your clipboard with a single click.
-   **❌ Fine-Grained Removal:** Remove individual resources or directories from a session easily.
-   **💨 Asynchronous & Responsive:** Built with async operations to keep your editor snappy.

## Installation 💻

1.  Open **VS Code**.
2.  Go to the **Extensions** view (Ctrl+Shift+X or Cmd+Shift+X).
3.  Search for `File Integrator`.
4.  Click **Install** on the entry by Mahesh Doiphode.

*(Alternatively, download the `.vsix` from [Releases](https://github.com/MaheshDoiphode/vscode-file-integrator/releases) and install via `Extensions View > ... > Install from VSIX...`)*

## Getting Started & Usage 📖

1.  **Open the View:**
    *   Click the **File Integrator icon** in the Activity Bar.
    *   You'll see the "Integration Sessions" view. A "Default Session" is created if none exist.

2.  **Manage Sessions:**
    *   **Create:** Click the `➕` icon in the view's title bar.
    *   **Rename:** Right-click a session name -> "Rename Session".
    *   **Remove:** Right-click a session name -> "Remove Session" (requires confirmation).

3.  **Add Resources:**
    *   **Method 1: Drag & Drop (Files/Folders):**
        *   Drag files or directories from the VS Code **Explorer**.
        *   Drop them onto the desired **Session item**.
        *   Exclusions defined in settings will apply here.
    *   **Method 2: Add Active Editor (Any Resource):**
        *   Open the file or resource you want to add in a VS Code editor tab (e.g., a local file, a Java library source).
        *   In the File Integrator view, hover over the desired **Session item**.
        *   Click the `➕` (Add Active Editor) icon that appears inline.
        *   The active editor's resource will be added to the session root. (Exclusions do *not* apply here).

4.  **View & Reorder Items:**
    *   Expand a session (`▶`) to see its contents.
    *   **Reorder:** Drag an item within the same level and drop it above/below another item. The order is saved.

5.  **Session Actions (Inline Icons):**
    *   Hover over a **Session item** to see icons:
        *   `➕` (Add Active Editor): Adds the currently active editor tab to *this* session.
        *   `📄` (Generate Code Block): Creates/opens an editable Markdown document for *this* session (respecting item order).
        *   `📋` (Copy to Clipboard): Copies the formatted Markdown content for *this* session (respecting order) to the clipboard.
        *   `🗑️` (Clear Session): **Immediately** removes *all* items from *this* session (no confirmation).

6.  **Remove Individual Items:**
    *   Expand a session.
    *   Hover over a specific item within the session.
    *   Click the `❌` (Remove Item) icon that appears.

7.  **Edit Generated Code (Optional):**
    *   The document opened by "Generate Code Block" is temporary. Edit it freely before copying/saving. Changes here don't affect the session.

## Configuring Exclusions (Drag & Drop Only) 🚫

Prevent unwanted files/folders from being added **when dragging from the Explorer**. Note: Exclusions do **not** apply when using the "Add Active Editor" button.

1.  Open VS Code Settings (Ctrl+, or Cmd+,).
2.  Edit User or Workspace `settings.json`.
3.  Add/edit the `fileintegrator.exclude` object. Use glob patterns as keys and `true` as the value.

**Example `settings.json`:**

```json
{
  // ... other settings ...

  "fileintegrator.exclude": {
    "**/.git": true,
    "**/node_modules": true,
    "**/target": true,
    "**/build": true,
    "**/*.log": true
    // Add your own patterns...
  }
}
```

**Glob Pattern Tips:**

-   `**` : Matches multiple directories.
-   `*` : Matches characters except `/`.
-   Use `/` as the path separator.

## Requirements

-   Visual Studio Code version `1.97.0` or higher.

## Known Issues & Considerations

-   **External Resource Changes:** If a resource (file, folder, item in an archive) added to a session is changed, moved, or deleted *externally*, the link in the File Integrator view becomes stale. Generating content or opening it may fail. Remove stale items manually (`❌`).
-   **Binary Files:** Content display for binary files may be incorrect.
-   **Performance:** Adding large directories or generating content for sessions with many very large files might take time.
-   **Reordering Scope:** Drag-and-drop reordering only works between items at the same level (siblings).

## Release Notes

### 0.0.8 (Latest)

-   **🚀 Feature:** **URI Support!** Can now add resources beyond simple files (e.g., files inside JARs/archives) using the "Add Active Editor" button.
-   **✨ Feature:** **Add Active Editor!** New inline button `➕` on session items to quickly add the current editor's content.
-   **👓 UI:** Improved display for non-file URIs (like archives) in tree view and generated output.
-   **UI:** Removed confirmation dialog when clearing a session.
-   **Fix:** Tree view now reliably updates when adding items via "Add Active Editor".
-   **Refactor:** Core logic updated to use URIs as primary identifiers.
-   **Refactor:** Persistence layer updated to store URIs; includes migration from v1/v2. Storage key version bumped to v3.

### 0.0.7

-   **Feature:** Full Session Persistence (Path-based in this version). Sessions saved/restored their file list, hierarchy, and order.
-   **Refactor:** Content generation became async, loading content on demand.
-   **Fix:** Resolved TypeScript compilation errors.
-   **Perf:** Changed activation event to `onView:fileIntegratorView`.

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

**Enjoy streamlining your code aggregation workflow!** 🎉