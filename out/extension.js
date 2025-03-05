"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
// The module 'vscode' contains the VS Code extensibility API
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
// This method is called when your extension is activated
function activate(context) {
    console.log('File Integrator extension is now active!');
    // File storage
    const fileStorage = new FileStorage();
    // Create the tree data provider for the view
    const fileIntegratorProvider = new FileIntegratorProvider(fileStorage);
    // Register the tree data provider
    const treeView = vscode.window.createTreeView('fileIntegratorView', {
        treeDataProvider: fileIntegratorProvider,
        dragAndDropController: fileIntegratorProvider,
        showCollapseAll: false,
    });
    context.subscriptions.push(treeView);
    // Register the command to open the file integrator webview
    context.subscriptions.push(vscode.commands.registerCommand('fileintegrator.openFileIntegrator', () => {
        FileIntegratorPanel.createOrShow(context.extensionUri, fileStorage);
    }));
    // Register command to remove a file
    context.subscriptions.push(vscode.commands.registerCommand('fileintegrator.removeFile', (item) => {
        fileStorage.removeFile(item.path);
        fileIntegratorProvider.refresh();
    }));
    // Register command to generate code block
    context.subscriptions.push(vscode.commands.registerCommand('fileintegrator.generateCodeBlock', () => {
        if (fileStorage.files.length === 0) {
            vscode.window.showInformationMessage('No files selected. Please drag and drop files first.');
            return;
        }
        FileIntegratorPanel.createOrShow(context.extensionUri, fileStorage);
        if (FileIntegratorPanel.currentPanel) {
            FileIntegratorPanel.currentPanel.generateCodeBlock();
        }
    }));
    // Register command to copy to clipboard
    context.subscriptions.push(vscode.commands.registerCommand('fileintegrator.copyToClipboard', () => {
        if (fileStorage.files.length === 0) {
            vscode.window.showInformationMessage('No files selected. Please drag and drop files first.');
            return;
        }
        let codeBlock = '';
        fileStorage.files.forEach(file => {
            if (file.content) {
                const displayPath = getDisplayPath(file.path);
                codeBlock += displayPath + "\n```\n" + file.content + "\n```\n\n";
            }
        });
        vscode.env.clipboard.writeText(codeBlock);
        vscode.window.showInformationMessage('Code block copied to clipboard!');
    }));
    // Register command to clear all files
    context.subscriptions.push(vscode.commands.registerCommand('fileintegrator.clearFiles', () => {
        fileStorage.clearFiles();
        fileIntegratorProvider.refresh();
        vscode.window.showInformationMessage('All files cleared.');
    }));
}
// This method is called when your extension is deactivated
function deactivate() { }
// Helper function to get relative path
function getDisplayPath(filePath) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
        // Try to make path relative to workspace root
        for (const folder of workspaceFolders) {
            const folderPath = folder.uri.fsPath;
            if (filePath.startsWith(folderPath)) {
                // Create relative path from workspace root
                return filePath.substring(folderPath.length + 1);
            }
        }
    }
    return filePath;
}
/**
 * File storage class to manage files across views
 */
class FileStorage {
    _files = [];
    get files() {
        return this._files;
    }
    addFile(filePath) {
        // Check if file already exists in the list
        if (!this._files.some(f => f.path === filePath)) {
            this._files.push({
                path: filePath,
                content: null
            });
            // Load file content
            try {
                const content = fs.readFileSync(filePath, 'utf8');
                const fileIndex = this._files.findIndex(f => f.path === filePath);
                if (fileIndex !== -1) {
                    this._files[fileIndex].content = content;
                }
            }
            catch (error) {
                vscode.window.showErrorMessage(`Error reading file ${filePath}: ${error}`);
            }
        }
    }
    removeFile(filePath) {
        const index = this._files.findIndex(f => f.path === filePath);
        if (index !== -1) {
            this._files.splice(index, 1);
        }
    }
    clearFiles() {
        this._files = [];
    }
}
/**
 * TreeItem representing a file in the view
 */
class FileItem extends vscode.TreeItem {
    path;
    collapsibleState;
    constructor(path, collapsibleState) {
        super(path, collapsibleState);
        this.path = path;
        this.collapsibleState = collapsibleState;
        this.tooltip = path;
        this.label = path.split(/[\\/]/).pop() || path; // Display just filename
        this.description = getDisplayPath(path);
        this.contextValue = 'file';
        this.iconPath = new vscode.ThemeIcon('file');
    }
}
/**
 * Tree data provider for the file integrator view
 */
class FileIntegratorProvider {
    fileStorage;
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    // Drag and drop capabilities
    dropMimeTypes = ['application/vnd.code.tree.fileIntegratorView', 'text/uri-list'];
    dragMimeTypes = ['text/uri-list'];
    constructor(fileStorage) {
        this.fileStorage = fileStorage;
    }
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
        if (element) {
            return Promise.resolve([]);
        }
        else {
            // Root of the tree, show all files
            return Promise.resolve(this.fileStorage.files.map(file => new FileItem(file.path, vscode.TreeItemCollapsibleState.None)));
        }
    }
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    // Handle drop events on the tree view
    handleDrop(target, sources, token) {
        const transferItem = sources.get('text/uri-list');
        if (!transferItem) {
            return Promise.resolve();
        }
        return transferItem.asString().then(uriList => {
            const uris = uriList.split('\n').filter(Boolean).map(uri => uri.trim());
            uris.forEach(uri => {
                // Remove "file://" prefix and decode URI
                let filePath = uri.replace(/^file:\/\//i, '');
                // Handle URL encoding
                try {
                    filePath = decodeURIComponent(filePath);
                }
                catch (error) {
                    console.error(`Failed to decode URI: ${filePath}`, error);
                }
                // Handle Windows drive letter format (/C:/path/to/file)
                if (process.platform === 'win32' && filePath.match(/^\/[A-Za-z]:/)) {
                    filePath = filePath.slice(1);
                }
                // Check if the path exists and is a file
                if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                    this.fileStorage.addFile(filePath);
                }
            });
            this.refresh();
            return Promise.resolve();
        });
    }
    // Handle drag from the tree view (not needed for this feature but required by interface)
    handleDrag(source, dataTransfer, token) {
        // Not implementing drag from tree view
    }
}
/**
 * Manages the webview panel for the File Integrator
 */
class FileIntegratorPanel {
    static currentPanel;
    _panel;
    _extensionUri;
    _disposables = [];
    _fileStorage;
    static createOrShow(extensionUri, fileStorage) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;
        // If we already have a panel, show it
        if (FileIntegratorPanel.currentPanel) {
            FileIntegratorPanel.currentPanel._panel.reveal(column);
            return;
        }
        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel('fileIntegrator', 'File Integrator', column || vscode.ViewColumn.One, {
            // Enable JavaScript in the webview
            enableScripts: true,
            // Restrict the webview to only load resources from the extension's directory
            localResourceRoots: [extensionUri],
            // Retain context when hidden
            retainContextWhenHidden: true,
        });
        FileIntegratorPanel.currentPanel = new FileIntegratorPanel(panel, extensionUri, fileStorage);
    }
    constructor(panel, extensionUri, fileStorage) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._fileStorage = fileStorage;
        // Set the webview's initial html content
        this._update();
        // Listen for when the panel is disposed
        // This happens when the user closes the panel or when the panel is closed programmatically
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        // Update the content based on view changes
        this._panel.onDidChangeViewState(() => {
            if (this._panel.visible) {
                this._update();
            }
        }, null, this._disposables);
        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'showInfo':
                    vscode.window.showInformationMessage(message.text);
                    break;
                case 'copyToClipboard':
                    vscode.env.clipboard.writeText(message.text);
                    vscode.window.showInformationMessage('Code block copied to clipboard!');
                    break;
                case 'removeFile':
                    this._fileStorage.removeFile(message.filePath);
                    this._update();
                    break;
            }
        }, null, this._disposables);
    }
    dispose() {
        FileIntegratorPanel.currentPanel = undefined;
        // Clean up our resources
        this._panel.dispose();
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
    generateCodeBlock() {
        if (this._panel.visible) {
            this._panel.webview.postMessage({ command: 'generateCodeBlock' });
        }
    }
    _update() {
        const webview = this._panel.webview;
        this._panel.title = 'File Integrator';
        this._panel.webview.html = this._getHtmlForWebview(webview);
    }
    _getHtmlForWebview(webview) {
        return `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>File Integrator</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
          padding: 20px;
          color: var(--vscode-foreground);
          background-color: var(--vscode-editor-background);
        }
        .container {
          display: flex;
          flex-direction: column;
          height: 100vh;
        }
        .file-list {
          flex: 1;
          overflow-y: auto;
          border: 1px solid var(--vscode-panel-border);
          border-radius: 5px;
          padding: 10px;
          margin-bottom: 20px;
          background-color: var(--vscode-editor-background);
        }
        .file-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px;
          border-bottom: 1px solid var(--vscode-panel-border);
        }
        .file-item:last-child {
          border-bottom: none;
        }
        .file-path {
          flex: 1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          margin-right: 10px;
        }
        .remove-btn {
          background-color: var(--vscode-button-secondaryBackground);
          color: var(--vscode-button-secondaryForeground);
          border: none;
          border-radius: 3px;
          padding: 4px 8px;
          cursor: pointer;
        }
        .remove-btn:hover {
          background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .actions {
          display: flex;
          justify-content: space-between;
          margin-top: 10px;
        }
        .btn {
          background-color: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          border: none;
          border-radius: 3px;
          padding: 8px 16px;
          cursor: pointer;
        }
        .btn:hover {
          background-color: var(--vscode-button-hoverBackground);
        }
        .btn-secondary {
          background-color: var(--vscode-button-secondaryBackground);
          color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover {
          background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .output {
          margin-top: 20px;
          border: 1px solid var(--vscode-panel-border);
          border-radius: 5px;
          padding: 10px;
          white-space: pre-wrap;
          font-family: monospace;
          background-color: var(--vscode-editor-background);
          max-height: 300px;
          overflow-y: auto;
        }
        .hidden {
          display: none;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>File Integrator</h1>
        <p>Files can be dragged and dropped into the File Integrator panel in the activity bar.</p>
        
        <h2>Selected Files</h2>
        <div class="file-list" id="fileList">
          <p id="emptyMessage">No files selected. Drag and drop files to the File Integrator panel to add them.</p>
        </div>
        
        <div class="actions">
          <button class="btn" id="generateBtn">Generate Code Block</button>
          <button class="btn btn-secondary" id="clearBtn">Clear All</button>
        </div>
        
        <div class="output hidden" id="output"></div>
      </div>
      
      <script>
        (function() {
          const vscode = acquireVsCodeApi();
          const fileList = document.getElementById('fileList');
          const emptyMessage = document.getElementById('emptyMessage');
          const generateBtn = document.getElementById('generateBtn');
          const clearBtn = document.getElementById('clearBtn');
          const output = document.getElementById('output');
          
          // Files array from the extension
          const files = ${JSON.stringify(this._fileStorage.files)};
          
          // Update file list when the webview is loaded
          updateFileList();
          
          // Remove a file from the list
          function removeFile(filePath) {
            vscode.postMessage({
              command: 'removeFile',
              filePath: filePath
            });
          }
          
          // Update the file list UI
          function updateFileList() {
            if (files.length === 0) {
              emptyMessage.classList.remove('hidden');
              fileList.innerHTML = '';
              fileList.appendChild(emptyMessage);
            } else {
              emptyMessage.classList.add('hidden');
              fileList.innerHTML = '';
              
              files.forEach((file) => {
                const fileItem = document.createElement('div');
                fileItem.className = 'file-item';
                
                const filePath = document.createElement('div');
                filePath.className = 'file-path';
                filePath.textContent = file.path;
                fileItem.appendChild(filePath);
                
                const removeBtn = document.createElement('button');
                removeBtn.className = 'remove-btn';
                removeBtn.textContent = 'Remove';
                removeBtn.addEventListener('click', () => removeFile(file.path));
                fileItem.appendChild(removeBtn);
                
                fileList.appendChild(fileItem);
              });
            }
          }
          
          // Generate the code block
          function generateCodeBlock() {
            if (files.length === 0) {
              vscode.postMessage({
                command: 'showInfo',
                text: 'No files selected. Please drag and drop files first.'
              });
              return;
            }
            
            let codeBlock = '';
            
            files.forEach(file => {
              if (file.content) {
                // Try to get workspace-relative path
                let displayPath = file.path;
                
                // Get relative path logic will be handled by the extension
                codeBlock += displayPath + "\n\`\`\`\n" + file.content + "\n\`\`\`\n\n";
              }
            });
            
            output.textContent = codeBlock;
            output.classList.remove('hidden');
            
            // Add copy button
            const copyBtn = document.createElement('button');
            copyBtn.className = 'btn';
            copyBtn.style.marginTop = '10px';
            copyBtn.textContent = 'Copy to Clipboard';
            copyBtn.addEventListener('click', () => {
              vscode.postMessage({
                command: 'copyToClipboard',
                text: codeBlock
              });
            });
            
            // Remove previous copy button if exists
            const existingCopyBtn = document.getElementById('copyBtn');
            if (existingCopyBtn) {
              existingCopyBtn.remove();
            }
            
            copyBtn.id = 'copyBtn';
            output.parentNode.insertBefore(copyBtn, output.nextSibling);
          }
          
          // Listen for generate code block message
          window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
              case 'generateCodeBlock':
                generateCodeBlock();
                break;
            }
          });
          
          // Set up event listeners
          generateBtn.addEventListener('click', generateCodeBlock);
          clearBtn.addEventListener('click', () => {
            vscode.postMessage({
              command: 'clearFiles'
            });
          });
        })();
      </script>
    </body>
    </html>`;
    }
}
//# sourceMappingURL=extension.js.map