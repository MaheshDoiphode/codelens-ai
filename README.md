# File Integrator for VS Code

This extension allows you to easily create markdown code blocks from multiple files by dragging and dropping them from your VS Code explorer.

## Installation

1. You can install this extension through the VS Code Marketplace:
   - Open VS Code
   - Go to Extensions (Ctrl+Shift+X)
   - Search for "File Integrator"
   - Click "Install"

2. Alternatively, you can install the VSIX file directly:
   - Download the latest `.vsix` file from the [releases page](https://github.com/MaheshDoiphode/vscode-file-integrator/releases)
   - Open VS Code
   - Go to Extensions (Ctrl+Shift+X)
   - Click on the "..." menu (top-right of the Extensions panel)
   - Select "Install from VSIX..."
   - Navigate to the downloaded file and select it

## Features

File Integrator simplifies the process of including code snippets from multiple files in documentation, discussions, or issue reports:

- Drag and drop files directly from the VS Code explorer
- Support for directories and subdirectories with hierarchical tree view
- Automatically formats the code into proper markdown code blocks
- Edit generated code blocks before copying them
- Easily copy the generated code blocks to clipboard with one click
- Dynamic updates when files are added or removed

## Usage

1. Open the File Integrator panel in the activity bar
2. Drag files or entire directories from the VS Code explorer into the drop zone
3. Navigate through the hierarchical directory tree to view your files
4. Click "Generate Code Block" to create an editable markdown document with all your files
5. Make any changes to the code blocks if needed
6. Use "Copy to Clipboard" to copy the code blocks
7. Use "Clear All" to start over with a new selection

## Why use File Integrator?

- **Perfect for sharing code**: When discussing code in issues, PRs, or documentation, easily include multiple files
- **Maintains context**: Each code block includes the filename for better context
- **Simple interface**: Drag, drop, generate, and copy - that's it!
- **Directory support**: Drop entire folders and maintain their structure for better organization
- **Edit before sharing**: Make modifications to the code blocks before copying them

## Requirements

No additional requirements or dependencies.

## Extension Settings

This extension does not add any VS Code settings.

## Known Issues

- Currently, the extension only works with text files that can be read as UTF-8
- Very large files might cause performance issues

## Release Notes

### 0.0.3

- Removed webview in favor of document-based editing
- Added support for dynamic updates when files are added or removed
- Improved code block generation and editing functionality

### 0.0.2

- Initial release of File Integrator
- Drag and drop files from VS Code explorer
- Generate and copy markdown code blocks

---

**Enjoy!**
