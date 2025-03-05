// The module 'vscode' contains the VS Code extensibility API
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// Store current code block documents
let codeBlockDocuments: vscode.TextDocument[] = [];

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

  // Register command to remove a file
  context.subscriptions.push(
    vscode.commands.registerCommand('fileintegrator.removeFile', (item: FileItem) => {
      fileStorage.removeFile(item.path);
      fileIntegratorProvider.refresh();
      
      // Update any open code block document
      updateCodeBlockDocuments(fileStorage.files);
    })
  );

  // Register command to generate code block
  context.subscriptions.push(
    vscode.commands.registerCommand('fileintegrator.generateCodeBlock', async () => {
      if (fileStorage.files.length === 0) {
        vscode.window.showInformationMessage('No files selected. Please drag and drop files first.');
        return;
      }

      // Get only files with content (not directories)
      const fileEntries = fileStorage.files.filter(file => !file.isDirectory && file.content);
      
      if (fileEntries.length === 0) {
        vscode.window.showInformationMessage('No files with content to display. Please add some files first.');
        return;
      }

      // Create or show the code block document
      const codeBlockDoc = await showCodeBlockDocument(fileEntries);
      
      // Focus the document
      if (codeBlockDoc) {
        vscode.window.showTextDocument(codeBlockDoc, { preview: false });
      }
    })
  );

  // Register command to copy to clipboard
  context.subscriptions.push(
    vscode.commands.registerCommand('fileintegrator.copyToClipboard', async () => {
      if (fileStorage.files.length === 0) {
        vscode.window.showInformationMessage('No files selected. Please drag and drop files first.');
        return;
      }

      // Check if we have code block documents open
      if (codeBlockDocuments.length > 0) {
        // Get the content from the active code block document
        const activeDoc = codeBlockDocuments[0]; // Get first code block document
        const content = activeDoc.getText();
        await vscode.env.clipboard.writeText(content);
        vscode.window.showInformationMessage('Code block copied to clipboard!');
        return;
      }

      // If no code block document is open, generate one from storage
      let codeBlock = '';
      
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

      await vscode.env.clipboard.writeText(codeBlock);
      vscode.window.showInformationMessage('Code block copied to clipboard!');
    })
  );

  // Register command to clear all files
  context.subscriptions.push(
    vscode.commands.registerCommand('fileintegrator.clearFiles', () => {
      fileStorage.clearFiles();
      fileIntegratorProvider.refresh();
      
      // Close any open code block documents
      closeCodeBlockDocuments();
      
      vscode.window.showInformationMessage('All files cleared.');
    })
  );
}

// This method is called when your extension is deactivated
export function deactivate() {
  // Close all code block documents
  closeCodeBlockDocuments();
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
 * Shows or creates a code block document with contents from the files
 */
async function showCodeBlockDocument(files: { path: string; content: string | null }[]): Promise<vscode.TextDocument | undefined> {
  // Generate the content
  let content = '';
  
  files.forEach(file => {
    if (file.content) {
      const displayPath = getDisplayPath(file.path);
      content += displayPath + "\n```\n" + file.content + "\n```\n\n";
    }
  });
  
  // Check if we already have a code block document open
  if (codeBlockDocuments.length > 0) {
    const doc = codeBlockDocuments[0];
    
    // Create a WorkspaceEdit to update the document
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      doc.uri, 
      new vscode.Range(0, 0, doc.lineCount, 0), 
      content
    );
    
    // Apply the edit
    await vscode.workspace.applyEdit(edit);
    return doc;
  }
  
  // Create a new untitled document
  const doc = await vscode.workspace.openTextDocument({
    content: content,
    language: 'markdown'
  });
  
  // Add to our list of code block documents
  codeBlockDocuments.push(doc);
  
  // Set up document change handler
  const changeDisposable = vscode.workspace.onDidCloseTextDocument(closedDoc => {
    if (closedDoc === doc) {
      // Remove from our list of code block documents
      codeBlockDocuments = codeBlockDocuments.filter(d => d !== doc);
      changeDisposable.dispose();
    }
  });
  
  return doc;
}

/**
 * Updates all open code block documents with the latest file content
 */
async function updateCodeBlockDocuments(files: { path: string; content: string | null; isDirectory: boolean; parent?: string }[]): Promise<void> {
  if (codeBlockDocuments.length === 0) {
    return;
  }
  
  // Generate the content
  let content = '';
  
  // Get only files with content (not directories)
  const fileEntries = files.filter(file => !file.isDirectory && file.content);
  
  fileEntries.forEach(file => {
    if (file.content) {
      const displayPath = getDisplayPath(file.path);
      content += displayPath + "\n```\n" + file.content + "\n```\n\n";
    }
  });
  
  // Update all code block documents
  for (const doc of codeBlockDocuments) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      doc.uri, 
      new vscode.Range(0, 0, doc.lineCount, 0), 
      content
    );
    
    await vscode.workspace.applyEdit(edit);
  }
}

/**
 * Closes all code block documents
 */
async function closeCodeBlockDocuments(): Promise<void> {
  // Create a copy of the array since we'll be modifying it during iteration
  const docsToClose = [...codeBlockDocuments];
  
  for (const doc of docsToClose) {
    // Find all editors showing this document and close them
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === doc) {
        await vscode.window.showTextDocument(editor.document, editor.viewColumn);
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }
    }
  }
  
  // Clear the array
  codeBlockDocuments = [];
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
        
        // Update any open code block documents with the new files
        updateCodeBlockDocuments(this.fileStorage.files);
        
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
        
        // Update any open code block documents with the new files
        updateCodeBlockDocuments(this.fileStorage.files);
        
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
