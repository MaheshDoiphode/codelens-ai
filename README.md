# File Integrator for VS Code

This extension allows you to easily aggregate content from multiple files and directories into markdown code blocks by dragging and dropping them into manageable sessions.

## Installation

1.  You can install this extension through the VS Code Marketplace:
    *   Open VS Code
    *   Go to Extensions (Ctrl+Shift+X or Cmd+Shift+X)
    *   Search for "File Integrator"
    *   Click "Install"

2.  Alternatively, you can install the VSIX file directly:
    *   Download the latest `.vsix` file from the [releases page](https://github.com/MaheshDoiphode/vscode-file-integrator/releases)
    *   Open VS Code
    *   Go to Extensions (Ctrl+Shift+X or Cmd+Shift+X)
    *   Click on the "..." menu (top-right of the Extensions panel)
    *   Select "Install from VSIX..."
    *   Navigate to the downloaded file and select it

## Features

File Integrator simplifies collecting code snippets and file contents for documentation, LLM prompts, discussions, or issue reports:

-   **Multiple Sessions:** Create, rename, and manage independent sessions to organize different sets of files.
-   **Drag and Drop:** Easily add files or entire directories from the VS Code explorer into a specific session.
-   **Directory Support:** Handles directories and subdirectories, displaying them in a hierarchical tree view within each session.
-   **Session-Specific Actions:** Generate code blocks, copy content, or clear files on a per-session basis using convenient inline icons or the context menu.
-   **Generate Code Block:** Creates or updates a dedicated, editable Markdown document for the selected session, containing the paths and contents of its files.
-   **Copy to Clipboard:** Quickly copy the formatted Markdown code block for the selected session.
-   **Individual File Removal:** Remove specific files or directories from a session using the inline 'x' icon.
-   **Persistence:** Session names and IDs are saved and restored between VS Code restarts (file lists are not persisted).
-   **Improved Performance:** Uses asynchronous file operations for a more responsive UI.

## Usage

1.  **Open the View:** Click the File Integrator icon in the Activity Bar. You'll see your sessions listed (a "Default Session" is created initially).
2.  **Manage Sessions:**
    *   Click the `+` icon in the view's title bar to create a new session.
    *   Right-click a session name to Rename or Remove it.
3.  **Add Files:** Drag files or directories from the VS Code Explorer *onto a specific session item* in the File Integrator view. The session's item count will update.
4.  **View Files:** Expand a session item to see the tree structure of the files and directories you've added to it.
5.  **Generate/Copy/Clear:**
    *   Hover over a session item to see inline icons:
        *   `$(markdown)` (Generate Code Block): Opens/updates the dedicated Markdown document for *this session*.
        *   `$(copy)` (Copy to Clipboard): Copies the generated Markdown for *this session*.
        *   `$(clear-all)` (Clear Session): Removes all files tracked within *this session* (requires confirmation).
    *   Alternatively, right-click the session for these and other options.
6.  **Remove Items:** Click the `x` icon next to a file or directory *within* a session to remove just that item.
7.  **Edit (Optional):** After clicking "Generate Code Block", the Markdown document opens. You can edit it like any other file before copying or saving.

## Why use File Integrator?

-   **Organize Context:** Group related files for different tasks (e.g., a feature, a bug report, documentation examples) into separate sessions.
-   **Perfect for LLMs & Sharing:** Easily gather all necessary code context to paste into prompts or share in issues, PRs, or documentation.
-   **Maintains Context:** Each code block includes the relative file path for clarity.
-   **Simple Interface:** Drag, drop, and click icons for core actions.
-   **Directory Support:** Drop entire folders and maintain their structure within a session.
-   **Edit Before Sharing:** Use the "Generate Code Block" feature to review and modify content before copying.

## Requirements

No additional requirements or dependencies.

## Extension Settings

This extension does not currently add any VS Code settings.

## Known Issues

-   The extension primarily works with text files readable as UTF-8. Binary files or files with unsupported encodings might not display content correctly.
-   Very large files or extremely deep directory structures might impact performance during drag-and-drop processing.
-   Session persistence only stores session names/IDs. The list of files within each session is **not** saved when VS Code closes.

## Release Notes

### 0.0.4

-   **Added:** Multiple Session Support! Create, rename, and remove independent file collections (Fixes #2).
-   **Added:** Session-specific actions (Generate, Copy, Clear) via inline icons and context menus.
-   **Changed:** Dragging files now only adds to the session list; the Markdown document is only created/updated/shown via the explicit "Generate" action, not automatically on drop.
-   **Improved:** Switched to asynchronous file operations for better performance and UI responsiveness.
-   **Added:** Session names and IDs are now persisted between VS Code restarts.
-   **Fixed:** Corrected issues with file and directory removal logic and UI updates.

### 0.0.3

-   Removed webview in favor of document-based editing.
-   Added support for dynamic updates when files are added or removed (Note: behavior changed in 0.0.4).
-   Improved code block generation and editing functionality.

### 0.0.2

-   Initial release of File Integrator.
-   Drag and drop files from VS Code explorer.
-   Generate and copy markdown code blocks.

---

**Enjoy!**