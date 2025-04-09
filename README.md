# File Integrator for VS Code

Easily collect, organize, order, and format content from multiple files and directories within VS Code! Perfect for creating context for LLMs, assembling documentation, or sharing code snippets.

[![Version](https://img.shields.io/visual-studio-marketplace/v/MaheshDoiphodeMSFT.fileintegrator?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=MaheshDoiphodeMSFT.fileintegrator)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/MaheshDoiphodeMSFT.fileintegrator)](https://marketplace.visualstudio.com/items?itemName=MaheshDoiphodeMSFT.fileintegrator)

## Why File Integrator? 🤔

Tired of manually copying and pasting code from various files? File Integrator streamlines this process:

-   **🧠 LLM Prompting:** Quickly gather all relevant code snippets and file contents into a single, ordered, formatted block to provide maximum context for AI assistants like ChatGPT, Claude, or Copilot Chat.
-   **📚 Documentation:** Assemble code examples from different parts of your project effortlessly, maintaining a logical order.
-   **💬 Code Sharing:** Share context-rich snippets in issues, pull requests, or team chats without hassle.
-   **📂 Organization:** Use independent **Sessions** to group files for different tasks, features, or bug reports. Your sessions and their contents **persist** across VS Code restarts!

## Features 🚀

-   **💾 Full Session Persistence:** Your sessions, the files/directories within them, their hierarchy, and their custom order are **saved and restored** automatically when you restart VS Code. Pick up right where you left off!
-   **✨ Multiple Sessions:** Create, rename, and manage independent sessions to organize different sets of files logically.
-   **🖱️ Drag & Drop Simplicity:** Add files or entire directories just by dragging them from the VS Code Explorer onto a session.
-   **↕️ Reorder Items:** Easily drag and drop files or folders *within* a session's level to change their order. This order is saved and used when generating output.
-   **🌲 Hierarchical View:** Added directories retain their structure within the session view, making navigation intuitive.
-   **⚙️ Customizable Exclusions:** Define glob patterns in your VS Code settings (`fileintegrator.exclude`) to automatically ignore unwanted files and folders (like `node_modules`, `.git`, build outputs, etc.) during drag-and-drop.
-   **⚡ Per-Session Actions:** Quickly Generate, Copy, or Clear content for specific sessions using inline icons or the context menu.
-   **📄 On-Demand Generation:** Create a clean, editable Markdown document showing file paths and content *only* when you click "Generate Code Block". No automatic pop-ups!
-   **📋 Easy Copying:** Copy the entire formatted Markdown block for a session (respecting the current order) to your clipboard with a single click.
-   **❌ Fine-Grained Removal:** Remove individual files or directories from a session easily.
-   **💨 Asynchronous & Responsive:** Built with async operations to keep your editor snappy, even when adding directories or generating content.

## Installation 💻

1.  Open **VS Code**.
2.  Go to the **Extensions** view (Ctrl+Shift+X or Cmd+Shift+X).
3.  Search for `File Integrator`.
4.  Click **Install** on the entry by Mahesh Doiphode.

*(Alternatively, download the `.vsix` from [Releases](https://github.com/MaheshDoiphode/vscode-file-integrator/releases) and install via `Extensions View > ... > Install from VSIX...`)*

## Getting Started & Usage 📖

1.  **Open the View:**
    *   Click the **File Integrator icon** (looks like stacked files) in the Activity Bar (usually on the left).
    *   You'll see the "Integration Sessions" view. A "Default Session" is created for you if none exist from previous use.

2.  **Manage Sessions:**
    *   **Create:** Click the `➕` (Add) icon in the view's title bar. Enter a name for your new session.
    *   **Rename:** Right-click on a session name in the list and select "Rename Session".
    *   **Remove:** Right-click on a session name and select "Remove Session" (requires confirmation).

3.  **Add Files & Folders:**
    *   Drag files or entire directories from the VS Code **Explorer** view.
    *   Drop them **directly onto the desired Session item** in the File Integrator view.
    *   Watch the item count next to the session name update! Files matching your exclusion patterns will be automatically skipped.

4.  **View & Reorder Items:**
    *   Click the arrow next to a session name to expand it and see the tree view of added files and directories.
    *   **To Reorder:** Click and drag a file or folder *within the same level* (e.g., two files directly under the session, or two files inside the same added folder) and drop it above or below another item at that level. The order will update visually and be saved.

5.  **Generate, Copy, Clear (Per Session):**
    *   Hover over a **Session item** to reveal inline action icons:
        *   📄 `$(markdown)` (Generate Code Block): Creates (if needed) and opens an editable Markdown document containing the paths and content for *this session*, respecting the current file order.
        *   📋 `$(copy)` (Copy to Clipboard): Copies the formatted Markdown content for *this session* (respecting order) directly to your clipboard.
        *   🗑️ `$(clear-all)` (Clear Session): Removes *all* tracked files and directories from *this session* (requires confirmation).
    *   You can also access these actions by right-clicking the Session item.

6.  **Remove Individual Items:**
    *   Expand a session.
    *   Hover over a specific file or directory *within* the session.
    *   Click the `❌` (Close) icon that appears to remove just that item and its children (if it's a directory).

7.  **Edit Generated Code (Optional):**
    *   After clicking "Generate Code Block", the Markdown file opens. Feel free to edit the content (e.g., remove irrelevant parts, add comments) before copying or saving it. The generated document is temporary; changes won't affect the session itself.

## Configuring Exclusions 🚫

Prevent common unwanted files/folders (like `node_modules`, `.git`, build artifacts) from being added automatically during drag-and-drop!

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
    "**/.vscode": true,       // VS Code workspace settings (usually don't want this in context)

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

-   Visual Studio Code version `1.97.0` or higher.

## Known Issues & Considerations

-   **External File Changes:** If you rename, move, or delete a file/folder *outside* of VS Code after adding it to a session, the link in the File Integrator view will become stale. Generating content or trying to open the file will likely show an error for that specific item. You will need to manually remove the stale item from the session using the `❌` icon.
-   **Binary Files:** Primarily designed for text files (UTF-8). Content display for binary files or files with other encodings may be incorrect or appear as garbled text in the generated output.
-   **Performance:** While generally fast, adding extremely large directories or generating content for sessions with many very large files might take a noticeable moment.
-   **Reordering Scope:** Drag-and-drop reordering currently works only between items at the *same level* (siblings). You cannot yet drag an item directly into a different folder within the view.

## Release Notes

### 0.0.7 (Latest)

-   **🚀 Feature:** **Full Session Persistence!** Sessions now save and restore their complete state, including the list of files/directories, their hierarchy, and their user-defined order, across VS Code restarts.
-   **⚙️ Refactor:** Updated persistence logic for robustness and added migration from older versions.
-   **⚙️ Refactor:** Content generation (`generateMarkdownContent`) is now fully asynchronous and reads file content on demand if not already loaded (e.g., after restart).
-   **Fix:** Resolved TypeScript compilation errors related to persistence loading.
-   **Perf:** Changed activation event to `onView:fileIntegratorView` for faster VS Code startup (lazy loading).
-   **Docs:** Updated README to reflect persistence and latest features.

### 0.0.6

-   **Added:** Drag-and-Drop Reordering! Prioritize files/directories within a session's view. The order is respected in generated/copied output. (Limited to sibling reordering).
-   **Changed:** Internal storage now uses an Array to maintain user-defined order.

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