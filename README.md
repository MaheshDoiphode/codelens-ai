# File Integrator for VS Code

Easily collect, organize, and format content from multiple files and directories within VS Code! Perfect for creating context for LLMs, assembling documentation, or sharing code snippets.


## Why File Integrator? 🤔

Tired of manually copying and pasting code from various files? File Integrator streamlines this process:

-   **🧠 LLM Prompting:** Quickly gather all relevant code snippets and file contents into a single, formatted block to provide maximum context for AI assistants like ChatGPT, Claude, or Copilot Chat.
-   **📚 Documentation:** Assemble code examples from different parts of your project effortlessly.
-   **💬 Code Sharing:** Share context-rich snippets in issues, pull requests, or team chats without hassle.
-   **📂 Organization:** Use independent **Sessions** to group files for different tasks, features, or bug reports.

## Features 🚀

-   **✨ Multiple Sessions:** Create, rename, and manage independent sessions to organize different sets of files logically.
-   **🖱️ Drag & Drop Simplicity:** Add files or entire directories just by dragging them from the VS Code Explorer onto a session.
-   **🌲 Hierarchical View:** Added directories retain their structure within the session view, making navigation intuitive.
-   **⚙️ Customizable Exclusions:** Define glob patterns in your VS Code settings (`fileintegrator.exclude`) to automatically ignore unwanted files and folders (like `node_modules`, `.git`, build outputs, etc.).
-   **⚡ Per-Session Actions:** Quickly Generate, Copy, or Clear content for specific sessions using inline icons or the context menu.
-   **📄 On-Demand Generation:** Create a clean, editable Markdown document showing file paths and content *only* when you click "Generate Code Block". No automatic pop-ups!
-   **📋 Easy Copying:** Copy the entire formatted Markdown block for a session to your clipboard with a single click.
-   **❌ Fine-Grained Removal:** Remove individual files or directories from a session easily.
-   **💾 Session Persistence:** Your created session names are saved and restored when you restart VS Code.
-   **💨 Asynchronous & Responsive:** Built with async operations to keep your editor snappy.

## Installation 💻

1.  Open **VS Code**.
2.  Go to the **Extensions** view (Ctrl+Shift+X or Cmd+Shift+X).
3.  Search for `File Integrator`.
4.  Click **Install**.

*(Alternatively, download the `.vsix` from [Releases](https://github.com/MaheshDoiphode/vscode-file-integrator/releases) and install via `Extensions View > ... > Install from VSIX...`)*

## Getting Started & Usage 📖

1.  **Open the View:**
    *   Click the **File Integrator icon** (looks like stacked files) in the Activity Bar (usually on the left).
    *   You'll see the "Integration Sessions" view. A "Default Session" is created for you if none exist.

2.  **Manage Sessions:**
    *   **Create:** Click the `➕` (Add) icon in the view's title bar. Enter a name for your new session.
    *   **Rename:** Right-click on a session name in the list and select "Rename Session".
    *   **Remove:** Right-click on a session name and select "Remove Session" (requires confirmation).

3.  **Add Files & Folders:**
    *   Drag files or entire directories from the VS Code **Explorer** view.
    *   Drop them **directly onto the desired Session item** in the File Integrator view.
    *   Watch the item count next to the session name update! Files matching your exclusion patterns will be automatically skipped.

4.  **View Added Items:**
    *   Click the arrow next to a session name to expand it and see the tree view of added files and directories.

5.  **Generate, Copy, Clear (Per Session):**
    *   Hover over a **Session item** to reveal inline action icons:
        *   📄 `$(markdown)` (Generate Code Block): Creates (if needed) and opens an editable Markdown document containing the paths and content for *this session*.
        *   📋 `$(copy)` (Copy to Clipboard): Copies the formatted Markdown content for *this session* directly to your clipboard.
        *   🗑️ `$(clear-all)` (Clear Session): Removes *all* tracked files and directories from *this session* (requires confirmation).
    *   You can also access these actions by right-clicking the Session item.

6.  **Remove Individual Items:**
    *   Expand a session.
    *   Hover over a specific file or directory *within* the session.
    *   Click the `❌` (Close) icon that appears to remove just that item and its children (if it's a directory).

7.  **Edit Generated Code (Optional):**
    *   After clicking "Generate Code Block", the Markdown file opens. Feel free to edit the content (e.g., remove irrelevant parts, add comments) before copying or saving it.

## Configuring Exclusions 🚫

Prevent common unwanted files/folders (like `node_modules`, `.git`, build artifacts) from being added automatically!

1.  Open your VS Code Settings (Ctrl+, or Cmd+,).
2.  You can edit either your global **User `settings.json`** or your project-specific **Workspace `.vscode/settings.json`**.
3.  Search for `"File Integrator Exclude"` or directly add/edit the `fileintegrator.exclude` object.
4.  Use **glob patterns** (similar to `.gitignore`) as keys and set the value to `true` to exclude matching items.

**Example `settings.json`:**

```json
{
  // ... other settings ...

  "fileintegrator.exclude": {
    // --- Common Defaults (Feel free to customize!) ---
    "**/.git": true,           // Git repository metadata
    "**/.svn": true,           // Subversion metadata
    "**/.hg": true,           // Mercurial metadata
    "**/CVS": true,           // CVS metadata
    "**/.DS_Store": true,     // macOS specific
    "**/node_modules": true,  // Node.js dependencies
    "**/bower_components": true,// Bower dependencies
    "**/__pycache__": true,  // Python bytecode cache
    "**/*.pyc": true,         // Python compiled files
    "**/target": true,        // Common Java/Maven build output
    "**/bin": true,           // Common compiled output/scripts
    "**/build": true,         // Common build output folder
    "**/.gradle": true,       // Gradle cache/metadata
    "**/.idea": true,         // IDE metadata (IntelliJ)
    "**/.vscode": true,       // VS Code workspace settings

    // --- Custom Examples ---
    "**/dist": true,          // Exclude common distribution folders
    "**/*.log": true,         // Exclude all log files anywhere
    "**/temp/**": true,       // Exclude anything under any 'temp' folder
    ".env": true,             // Exclude .env file at the root
    "**/secrets.json": true,  // Exclude specific file name anywhere
    "docs/internal": true     // Exclude a specific folder relative to workspace root
  }
}
```

**Glob Pattern Tips:**

-   `**` : Matches any number of directories (including zero).
-   `*` : Matches any number of characters except `/`.
-   `?` : Matches a single character except `/`.
-   Use `/` as the path separator (even on Windows).

## Requirements

None! Works out-of-the-box with VS Code.

## Known Issues

-   Primarily designed for text files (UTF-8). Content display for binary files or other encodings may be incorrect.
-   Extremely large files or deeply nested directories might slow down processing during drag-and-drop.
-   Session persistence only saves session names/IDs. The actual list of files within sessions is **not** saved when VS Code is closed and must be re-added.

## Release Notes

### 0.0.5

-   **Added:** File & Directory Exclusion! Configure glob patterns via `fileintegrator.exclude` setting to ignore unwanted items (e.g., `node_modules`, `.git`).
-   **Added:** Notification when items are skipped due to exclusion rules.
-   **Improved:** README updated with comprehensive usage and exclusion configuration details.

### 0.0.4

-   **Added:** Multiple Session Support! Create, rename, and remove independent file collections (Fixes #2).
-   **Added:** Session-specific actions (Generate, Copy, Clear) via inline icons and context menus.
-   **Changed:** Dragging files now only adds to the session list; the Markdown document is only created/updated/shown via the explicit "Generate" action.
-   **Improved:** Switched to asynchronous file operations for better performance.
-   **Added:** Session names and IDs are now persisted between VS Code restarts.
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

Found a bug or have a feature request? Please open an issue on the [GitHub repository](https://github.com/MaheshDoiphode/vscode-file-integrator/issues)!

---

**Enjoy streamlining your code aggregation workflow!** 🎉
