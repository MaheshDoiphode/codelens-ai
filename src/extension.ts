// The module 'vscode' contains the VS Code extensibility API
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {
  // File storage
  const fileStorage = new FileStorage();

  // Create the tree data provider for the view
  const fileIntegratorProvider = new FileIntegratorProvider(fileStorage);
  
  // Register the tree data provider with drag and drop support
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('fileIntegratorView', fileIntegratorProvider)
  );

  // Then create the tree view
  const treeView = vscode.window.createTreeView('fileIntegratorView', { 
    treeDataProvider: fileIntegratorProvider,
    dragAndDropController: fileIntegratorProvider,
    showCollapseAll: true,
    canSelectMany: true,  // Allow multiple selection
  });

  // Register the tree view as a valid drop target
  context.subscriptions.push(
    treeView
  );
  
  context.subscriptions.push(treeView);

  // Register the command to open the file integrator webview
  context.subscriptions.push(
    vscode.commands.registerCommand('fileintegrator.openFileIntegrator', () => {
      FileIntegratorPanel.createOrShow(context.extensionUri, fileStorage);
    })
  );

  // Register command to remove a file
  context.subscriptions.push(
    vscode.commands.registerCommand('fileintegrator.removeFile', (item: FileItem) => {
      fileStorage.removeFile(item.path);
      fileIntegratorProvider.refresh();
      
      // Notify the webview that file list has been updated
      if (FileIntegratorPanel.currentPanel) {
        FileIntegratorPanel.currentPanel.updateFileList();
      }
    })
  );

  // Register command to generate code block
  context.subscriptions.push(
    vscode.commands.registerCommand('fileintegrator.generateCodeBlock', () => {
      if (fileStorage.files.length === 0) {
        vscode.window.showInformationMessage('No files selected. Please drag and drop files first.');
        return;
      }

      FileIntegratorPanel.createOrShow(context.extensionUri, fileStorage);
      if (FileIntegratorPanel.currentPanel) {
        FileIntegratorPanel.currentPanel.generateCodeBlock();
      }
    })
  );

  // Register command to copy to clipboard
  context.subscriptions.push(
    vscode.commands.registerCommand('fileintegrator.copyToClipboard', () => {
      if (fileStorage.files.length === 0) {
        vscode.window.showInformationMessage('No files selected. Please drag and drop files first.');
        return;
      }

      let codeBlock = '';
      
      // Only process actual files (not directories) with content
      // Make sure we're only getting files that exist in the current storage
      const fileEntries = fileStorage.files.filter(file => !file.isDirectory && file.content);
      
      if (fileEntries.length === 0) {
        vscode.window.showInformationMessage('No files with content to copy. Please add some files first.');
        return;
      }
      
      fileEntries.forEach(file => {
        if (file.content) {
          const displayPath = getDisplayPath(file.path);
          codeBlock += displayPath + "\n```\n" + file.content + "\n```\n\n";
        }
      });

      vscode.env.clipboard.writeText(codeBlock);
      vscode.window.showInformationMessage('Code block copied to clipboard!');
    })
  );

  // Register command to clear all files
  context.subscriptions.push(
    vscode.commands.registerCommand('fileintegrator.clearFiles', () => {
      fileStorage.clearFiles();
      fileIntegratorProvider.refresh();
      
      // Notify the webview that all files have been cleared
      if (FileIntegratorPanel.currentPanel) {
        FileIntegratorPanel.currentPanel.updateFileList();
      }
      
      vscode.window.showInformationMessage('All files cleared.');
    })
  );
}

// This method is called when your extension is deactivated
export function deactivate() {
}

// Helper function to get relative path
function getDisplayPath(filePath: string): string {
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

  // If not in workspace, try to extract project-relevant part of the path
  // Look for 'vscodedragger/fileintegrator' or similar pattern in the path
  const projectMatch = filePath.match(/(?:\/|\\)([\w-]+\/[\w-]+\/[\w.-]+)$/);
  if (projectMatch && projectMatch[1]) {
    return projectMatch[1].replace(/\\/g, '/'); // Normalize to forward slashes
  }
  
  // Extract just the last two directory names and the filename
  const parts = filePath.split(/[\\\/]/);
  if (parts.length > 3) {
    return parts.slice(-3).join('/');
  }
  
  return path.basename(filePath); // Fallback to just the filename
}

/**
 * File storage class to manage files across views
 */
class FileStorage {
  private _files: { path: string; content: string | null; isDirectory: boolean; parent?: string }[] = [];

  get files(): { path: string; content: string | null; isDirectory: boolean; parent?: string }[] {
    return this._files;
  }

  // Get only the files (not directories)
  get filesOnly(): { path: string; content: string | null }[] {
    return this._files.filter(f => !f.isDirectory).map(f => ({ path: f.path, content: f.content }));
  }

  // Add a file to storage
  addFile(filePath: string) {
    
    // Check if file already exists in the list
    if (!this._files.some(f => f.path === filePath)) {
      this._files.push({
        path: filePath,
        content: null,
        isDirectory: false
      });

      // Load file content
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const fileIndex = this._files.findIndex(f => f.path === filePath);
        if (fileIndex !== -1) {
          this._files[fileIndex].content = content;
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Error reading file ${filePath}: ${error}`);
      }
    }
  }

  // Add a directory and all its files
  addDirectory(dirPath: string, parentPath?: string) {
    
    // Check if directory already exists
    if (this._files.some(f => f.path === dirPath && f.isDirectory)) {
      return; // Directory already added
    }

    // Add the directory itself
    this._files.push({
      path: dirPath,
      content: null,
      isDirectory: true,
      parent: parentPath // Set the parent directory if provided
    });

    // Read directory contents
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      
      // Process each entry
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        if (entry.isDirectory()) {
          // Recursively add subdirectories with current directory as parent
          this.addDirectory(fullPath, dirPath);
        } else if (entry.isFile()) {
          // Add file with parent reference
          this._files.push({
            path: fullPath,
            content: null,
            isDirectory: false,
            parent: dirPath
          });

          // Load file content
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            const fileIndex = this._files.findIndex(f => f.path === fullPath);
            if (fileIndex !== -1) {
              this._files[fileIndex].content = content;
            }
          } catch (error) {
            console.error(`Error reading file ${fullPath}:`, error);
          }
        }
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Error reading directory ${dirPath}: ${error}`);
    }
  }

  // Remove file or directory
  removeFile(filePath: string) {
    
    const fileToRemove = this._files.find(f => f.path === filePath);
    
    if (!fileToRemove) {
      return;
    }
    
    if (fileToRemove.isDirectory) {
      
      // Normalize path separators for consistent comparison
      const normalizedDirPath = filePath.replace(/\\/g, '/');
      
      // Find ALL paths that will be removed (for logging)
      const pathsToRemove = this._files
        .filter(f => {
          const normalizedFilePath = f.path.replace(/\\/g, '/');
          return normalizedFilePath === normalizedDirPath || 
                 normalizedFilePath.startsWith(normalizedDirPath + '/');
        })
        .map(f => f.path);
      
      
      // Simple filter: keep only files that are NOT within this directory
      this._files = this._files.filter(f => {
        const normalizedFilePath = f.path.replace(/\\/g, '/');
        const shouldRemove = normalizedFilePath === normalizedDirPath || 
                             normalizedFilePath.startsWith(normalizedDirPath + '/');
        return !shouldRemove;
      });
    } else {
      // Remove individual file
      
      const index = this._files.findIndex(f => f.path === filePath);
      if (index !== -1) {
        this._files.splice(index, 1);
      }
    }
    
    // Debug check: Verify the file is actually gone
    const stillExists = this._files.some(f => f.path === filePath);
    
    // Debug check: Log all file paths after removal
  }

  clearFiles() {
    this._files = [];
  }
}

/**
 * TreeItem representing a file or directory in the view
 */
class FileItem extends vscode.TreeItem {
  constructor(
    public readonly path: string,
    public readonly isDirectory: boolean,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly parent?: string
  ) {
    super(path, collapsibleState);
    
    // Set the appropriate label and icon
    const basename = path.split(/[\\/]/).pop() || path;
    this.label = basename;
    
    if (isDirectory) {
      this.tooltip = `Directory: ${path}`;
      this.contextValue = 'directory';
      this.iconPath = new vscode.ThemeIcon('folder');
      this.description = getDisplayPath(path);
    } else {
      this.tooltip = `File: ${path}`;
      this.contextValue = 'file';
      this.iconPath = new vscode.ThemeIcon('file');
      this.description = getDisplayPath(path);
    }
  }
}

/**
 * Tree data provider for the file integrator view
 */
class FileIntegratorProvider implements vscode.TreeDataProvider<FileItem>, vscode.TreeDragAndDropController<FileItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<FileItem | undefined | null | void> = new vscode.EventEmitter<FileItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<FileItem | undefined | null | void> = this._onDidChangeTreeData.event;
  
  // Restore original working dropMimeTypes
  readonly dropMimeTypes = ['application/vnd.code.tree.fileIntegratorView', 'text/uri-list'];
  readonly dragMimeTypes = ['text/uri-list'];

  constructor(private fileStorage: FileStorage) {}

  getTreeItem(element: FileItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: FileItem): Thenable<FileItem[]> {
    // If an element is provided, we're looking for its children
    if (element) {
      // Return children of this directory
      const directoryPath = element.path;
      const children = this.fileStorage.files.filter(file => file.parent === directoryPath);
      
      return Promise.resolve(
        children.map(file => 
          new FileItem(
            file.path, 
            file.isDirectory, 
            file.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
            file.parent
          )
        )
      );
    } else {
      // Root level - show top-level items (files without parents and root directories)
      const rootItems = this.fileStorage.files.filter(file => !file.parent);
      
      return Promise.resolve(
        rootItems.map(file => 
          new FileItem(
            file.path, 
            file.isDirectory, 
            file.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
          )
        )
      );
    }
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  // Handle drop events on the tree view
  handleDrop(target: FileItem | undefined, sources: vscode.DataTransfer, token: vscode.CancellationToken): Thenable<void> {
    // Try both 'files' and 'text/uri-list' mime types
    const filesItem = sources.get('files');
    const uriListItem = sources.get('text/uri-list');
    
    if (filesItem) {
      return filesItem.asString().then(async (filesData) => {
        try {
          const files = JSON.parse(filesData);
          for (const file of files) {
            const filePath = file.fsPath || file;
            await this.processPath(filePath);
          }
        } catch (err) {
          vscode.window.showErrorMessage(`Error processing files: ${err instanceof Error ? err.message : String(err)}`);
          this.processPath(filesData);
        }
        this.refresh();
        return Promise.resolve();
      });
    } else if (uriListItem) {
      return uriListItem.asString().then(async (uriList) => {
        const uris = uriList.split('\n').filter(Boolean).map(uri => uri.trim());

        for (const uri of uris) {
          let filePath = uri.replace(/^file:\/\//i, '');
          try {
            filePath = decodeURIComponent(filePath);
            
            // Handle Windows drive letter format (/C:/path/to/file)
            if (process.platform === 'win32' && filePath.match(/^\/[A-Za-z]:/)) {
              filePath = filePath.slice(1);
            }
            
            await this.processPath(filePath);
          } catch (err) {
            vscode.window.showErrorMessage(`Error processing URI: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        
        this.refresh();
        return Promise.resolve();
      });
    }

    return Promise.resolve();
  }

  // Helper method to process a file or directory path
  private async processPath(path: string): Promise<void> {
    try {
      if (fs.existsSync(path)) {
        const stats = fs.statSync(path);
        
        if (stats.isDirectory()) {
          this.fileStorage.addDirectory(path);
        } else if (stats.isFile()) {
          this.fileStorage.addFile(path);
        }
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Error processing path: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Manages the webview panel for the File Integrator
 */
class FileIntegratorPanel {
  public static currentPanel: FileIntegratorPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _fileStorage: FileStorage;

  public static createOrShow(extensionUri: vscode.Uri, fileStorage: FileStorage) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // If we already have a panel, show it
    if (FileIntegratorPanel.currentPanel) {
      FileIntegratorPanel.currentPanel._panel.reveal(column);
      return;
    }

    // Otherwise, create a new panel
    const panel = vscode.window.createWebviewPanel(
      'fileIntegrator',
      'File Integrator',
      column || vscode.ViewColumn.One,
      {
        // Enable JavaScript in the webview
        enableScripts: true,
        // Restrict the webview to only load resources from the extension's directory
        localResourceRoots: [extensionUri],
        // Retain context when hidden
        retainContextWhenHidden: true,
      }
    );

    FileIntegratorPanel.currentPanel = new FileIntegratorPanel(panel, extensionUri, fileStorage);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, fileStorage: FileStorage) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._fileStorage = fileStorage;

    // Set the webview's initial html content
    this._update();

    // Listen for when the panel is disposed
    // This happens when the user closes the panel or when the panel is closed programmatically
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Update the content based on view changes
    this._panel.onDidChangeViewState(
      () => {
        if (this._panel.visible) {
          this._update();
        }
      },
      null,
      this._disposables
    );

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        
        switch (message.command) {
          case 'showInfo':
            vscode.window.showInformationMessage(message.text);
            break;
          case 'copyToClipboard':
            // For copy to clipboard, we'll use the current fileStorage state
            // rather than whatever might be in the WebView
            if (this._fileStorage.files.length === 0) {
              vscode.window.showInformationMessage('No files selected. Please drag and drop files first.');
              return;
            }
            
            let codeBlock = '';
            
            // Only process actual files (not directories) with content
            const fileEntries = this._fileStorage.files.filter(file => !file.isDirectory && file.content);
            
            if (fileEntries.length === 0) {
              vscode.window.showInformationMessage('No files with content to copy.');
              return;
            }
            
            fileEntries.forEach(file => {
              if (file.content) {
                const displayPath = getDisplayPath(file.path);
                codeBlock += displayPath + "\n```\n" + file.content + "\n```\n\n";
              }
            });
            
            vscode.env.clipboard.writeText(codeBlock);
            vscode.window.showInformationMessage('Code block copied to clipboard!');
            break;
          case 'removeFile':
            this._fileStorage.removeFile(message.filePath);
            
            // Update both the TreeView and the WebView
            vscode.commands.executeCommand('workbench.view.extension.fileIntegratorView');
            
            // Update the WebView with the latest files
            this.updateFileList();
            break;
        }
      },
      null,
      this._disposables
    );
  }

  public dispose() {
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

  public generateCodeBlock() {
    if (this._panel.visible) {
      this._panel.webview.postMessage({ command: 'generateCodeBlock' });
    }
  }

  // Add this method to update the file list in the WebView
  public updateFileList() {
    if (this._panel.visible) {
      this._panel.webview.postMessage({ 
        command: 'fileListUpdated',
        files: this._fileStorage.files 
      });
    }
  }

  private _update() {
    const webview = this._panel.webview;
    this._panel.title = 'File Integrator';
    
    // Make sure we're using the latest file list
    this._panel.webview.html = this._getHtmlForWebview(webview);
    
    // Immediately after updating the HTML, send the latest file list
    // This ensures the WebView always has the most current file data
    this.updateFileList();
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
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
        .directory {
          font-weight: bold;
          color: var(--vscode-symbolIcon-folderForeground);
        }
        .file {
          color: var(--vscode-foreground);
        }
        .nested-files {
          margin-left: 20px;
          padding-left: 10px;
          border-left: 1px solid var(--vscode-panel-border);
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
        .icon {
          margin-right: 5px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>File Integrator</h1>
        <p>Files and directories can be dragged and dropped into the File Integrator panel in the activity bar.</p>
        
        <h2>Selected Files</h2>
        <div class="file-list" id="fileList">
          <p id="emptyMessage">No files selected. Drag and drop files or directories to the File Integrator panel to add them.</p>
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
          let files = ${JSON.stringify(this._fileStorage.files)};
          
          // Update file list when the webview is loaded
          updateFileList();
          
          // Remove a file from the list
          function removeFile(filePath) {
            vscode.postMessage({
              command: 'removeFile',
              filePath: filePath
            });
            
            // Also remove it locally for immediate UI update
            const isDirectory = files.find(f => f.path === filePath)?.isDirectory || false;
            
            if (isDirectory) {
              // Remove directory and all children
              files = files.filter(f => !f.path.startsWith(filePath + '/') && 
                                      !f.path.startsWith(filePath + '\\') && 
                                      f.path !== filePath);
            } else {
              // Remove single file
              files = files.filter(f => f.path !== filePath);
            }
            
            updateFileList();
            
            // If we have the output displayed, update it too
            if (!output.classList.contains('hidden')) {
              generateCodeBlock();
            }
          }
          
          // Handle clearFiles command
          clearBtn.addEventListener('click', () => {
            vscode.postMessage({
              command: 'clearFiles'
            });
            
            // Also clear locally
            files = [];
            updateFileList();
            
            // Clear output if shown
            output.classList.add('hidden');
            output.textContent = '';
            
            // Remove copy button if exists
            const copyBtn = document.getElementById('copyBtn');
            if (copyBtn) {
              copyBtn.remove();
            }
          });
          
          // Update the file list UI
          function updateFileList() {
            if (files.length === 0) {
              emptyMessage.classList.remove('hidden');
              fileList.innerHTML = '';
              fileList.appendChild(emptyMessage);
              return;
            }
            
            emptyMessage.classList.add('hidden');
            fileList.innerHTML = '';
            
            // Create a hierarchical structure
            const rootItems = files.filter(file => !file.parent);
            
            // Render top-level items
            rootItems.forEach(item => {
              renderFileItem(item, fileList);
            });
          }
          
          // Render a single file/directory item
          function renderFileItem(item, container) {
            const fileItem = document.createElement('div');
            fileItem.className = 'file-item';
            
            const filePathContainer = document.createElement('div');
            filePathContainer.className = 'file-path ' + (item.isDirectory ? 'directory' : 'file');
            
            // Add icon
            const icon = document.createElement('span');
            icon.className = 'icon';
            icon.innerHTML = item.isDirectory ? '📁' : '📄';
            filePathContainer.appendChild(icon);
            
            // Display only the filename or directory name
            const pathParts = item.path.split(/[\\\/]/);
            filePathContainer.appendChild(document.createTextNode(pathParts[pathParts.length - 1]));
            
            // Add tooltip with full path
            filePathContainer.title = item.path;
            
            fileItem.appendChild(filePathContainer);
            
            const removeBtn = document.createElement('button');
            removeBtn.className = 'remove-btn';
            removeBtn.textContent = 'Remove';
            removeBtn.addEventListener('click', () => removeFile(item.path));
            fileItem.appendChild(removeBtn);
            
            container.appendChild(fileItem);
            
            // If this is a directory, add its children
            if (item.isDirectory) {
              const childContainer = document.createElement('div');
              childContainer.className = 'nested-files';
              container.appendChild(childContainer);
              
              // Find all direct children
              const children = files.filter(file => file.parent === item.path);
              
              if (children.length > 0) {
                children.forEach(child => {
                  renderFileItem(child, childContainer);
                });
              }
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
            
            // Get only file entries (not directories) that still exist in the current files array
            const fileEntries = files.filter(file => !file.isDirectory && file.content);
            
            fileEntries.forEach(file => {
              if (file.content) {
                // Use relative path for display
                const displayPath = getDisplayPath(file.path);
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
          
          // Get a more user-friendly display path
          function getDisplayPath(filePath) {
            // Look for project pattern in path
            const projectMatch = filePath.match(/(?:\/|\\)([\w-]+\/[\w-]+\/[\w.-]+)$/);
            if (projectMatch && projectMatch[1]) {
              return projectMatch[1].replace(/\\/g, '/');
            }
            
            // Extract just the last two directory names and the filename
            const parts = filePath.split(/[\\\/]/);
            if (parts.length > 3) {
              return parts.slice(-3).join('/');
            }
            
            return parts[parts.length - 1]; // Just filename as fallback
          }
          
          // Listen for messages from the extension
          window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
              case 'generateCodeBlock':
                generateCodeBlock();
                break;
              case 'fileListUpdated':
                // Update our local file list when the extension updates it
                files = message.files || [];
                updateFileList();
                break;
            }
          });
          
          // Set up event listeners
          generateBtn.addEventListener('click', generateCodeBlock);
        })();
      </script>
    </body>
    </html>`;
  }
}
