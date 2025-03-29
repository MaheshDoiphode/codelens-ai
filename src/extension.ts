// The module 'vscode' contains the VS Code extensibility API
import * as vscode from 'vscode';
import * as path from 'path';
// Use fs-extra for easier async operations and promises by default
import * as fs from 'fs-extra';
import { v4 as uuidv4 } from 'uuid'; // For unique session IDs

// --- Core Data Structures ---

interface FileEntry {
  path: string;
  content: string | null; // Content might be null if reading failed
  isDirectory: boolean;
  parent?: string; // Path of the parent directory within the session
  sessionId: string; // Link back to the session it belongs to
}

/**
 * Manages file storage for a single session using asynchronous operations.
 */
class SessionFileStorage {
  private _files: Map<string, FileEntry> = new Map(); // Use Map for efficient path lookup/update/delete
  public readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  // Get all entries currently stored
  get files(): FileEntry[] {
    return Array.from(this._files.values());
  }

  // Get only entries that represent files (not directories)
  get filesOnly(): { path: string; content: string | null }[] {
    return this.files.filter(f => !f.isDirectory).map(f => ({ path: f.path, content: f.content }));
  }

  // Add a single file asynchronously
  async addFile(filePath: string, parentPath?: string): Promise<boolean> {
    const normalizedPath = path.normalize(filePath);
    if (this._files.has(normalizedPath)) return false;
    let content: string | null = null;
    try {
      content = await fs.readFile(normalizedPath, 'utf8');
    } catch (error: any) {
      vscode.window.showErrorMessage(`Error reading file ${path.basename(normalizedPath)}: ${error.message}`);
      console.error(`[Storage] Error reading file ${normalizedPath}:`, error);
    }
    const fileEntry: FileEntry = { path: normalizedPath, content: content, isDirectory: false, parent: parentPath ? path.normalize(parentPath) : undefined, sessionId: this.sessionId };
    this._files.set(normalizedPath, fileEntry);
    return true;
  }

  // Add a directory and its contents recursively and asynchronously
  async addDirectory(dirPath: string, parentPath?: string): Promise<boolean> {
    const normalizedPath = path.normalize(dirPath);
    if (this._files.has(normalizedPath) && this._files.get(normalizedPath)?.isDirectory) return false;
    const dirEntry: FileEntry = { path: normalizedPath, content: null, isDirectory: true, parent: parentPath ? path.normalize(parentPath) : undefined, sessionId: this.sessionId };
    this._files.set(normalizedPath, dirEntry);
    try {
      const entries = await fs.readdir(normalizedPath, { withFileTypes: true });
      const processingPromises: Promise<boolean>[] = [];
      for (const entry of entries) {
        const fullPath = path.join(normalizedPath, entry.name);
        if (entry.isDirectory()) processingPromises.push(this.addDirectory(fullPath, normalizedPath));
        else if (entry.isFile()) processingPromises.push(this.addFile(fullPath, normalizedPath));
      }
      await Promise.all(processingPromises);
    } catch (error: any) {
      vscode.window.showErrorMessage(`Error reading directory ${path.basename(normalizedPath)}: ${error.message}`);
      console.error(`[Storage] Error reading directory ${normalizedPath}:`, error);
      return false;
    }
    return true;
  }

  /** Remove a file or directory (and all its descendants within the storage). */
  removeEntry(entryPath: string): boolean {
    const normalizedPath = path.normalize(entryPath);
    const entryToRemove = this._files.get(normalizedPath);
    if (!entryToRemove) return false;
    let itemsRemovedCount = 0;
    if (this._files.delete(normalizedPath)) itemsRemovedCount++;
    if (entryToRemove.isDirectory) {
      const prefix = normalizedPath + path.sep;
      const currentKeys = Array.from(this._files.keys());
      currentKeys.forEach(key => { if (key.startsWith(prefix) && this._files.delete(key)) itemsRemovedCount++; });
    }
    return itemsRemovedCount > 0;
  }

  /** Clear all files and directories from this session's storage */
  clearFiles(): number {
    const count = this._files.size;
    this._files.clear();
    return count;
  }
}

// --- Session Class ---
class Session {
  public readonly id: string;
  public name: string;
  public readonly storage: SessionFileStorage;
  public associatedDocument: vscode.TextDocument | null = null;
  private docCloseListener: vscode.Disposable | null = null;

  constructor(name: string, id: string = uuidv4()) {
    this.id = id;
    this.name = name;
    this.storage = new SessionFileStorage(this.id);
  }

  dispose() {
    this.closeAssociatedDocument(false);
    this.docCloseListener?.dispose(); this.docCloseListener = null;
    this.storage.clearFiles();
  }

  setAssociatedDocument(doc: vscode.TextDocument) {
    this.docCloseListener?.dispose();
    this.associatedDocument = doc;
    this.docCloseListener = vscode.workspace.onDidCloseTextDocument(closedDoc => {
      if (closedDoc === this.associatedDocument) {
        this.associatedDocument = null; this.docCloseListener?.dispose(); this.docCloseListener = null;
      }
    });
  }

  async closeAssociatedDocument(attemptEditorClose: boolean = true): Promise<void> {
    const docToClose = this.associatedDocument;
    this.associatedDocument = null; this.docCloseListener?.dispose(); this.docCloseListener = null;
    if (attemptEditorClose && docToClose) {
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document === docToClose) {
          try {
            await vscode.window.showTextDocument(docToClose, { viewColumn: editor.viewColumn, preserveFocus: false });
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); break;
          } catch (error) { console.error(`Session "${this.name}": Error closing editor:`, error); }
        }
      }
    }
  }
}


// --- Session Manager Class ---
class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private static readonly STORAGE_KEY = 'fileIntegratorSessions';
  constructor(private context: vscode.ExtensionContext) { }
  createSession(name?: string): Session { const n = name || `Session ${this.sessions.size + 1}`; const s = new Session(n); this.sessions.set(s.id, s); this.persistSessions(); return s; }
  getSession(id: string): Session | undefined { return this.sessions.get(id); }
  getAllSessions(): Session[] { return Array.from(this.sessions.values()).sort((a, b) => a.name.localeCompare(b.name)); }
  removeSession(id: string): boolean { const s = this.sessions.get(id); if (s) { s.dispose(); const d = this.sessions.delete(id); if (d) this.persistSessions(); return d; } return false; }
  renameSession(id: string, newName: string): boolean { const s = this.sessions.get(id); if (s) { s.name = newName; this.persistSessions(); return true; } return false; }
  persistSessions() { try { const m = this.getAllSessions().map(s => ({ id: s.id, name: s.name })); this.context.workspaceState.update(SessionManager.STORAGE_KEY, m); } catch (e) { console.error("Persist error:", e); } }
  loadSessions() { try { const m = this.context.workspaceState.get<{ id: string, name: string }[]>(SessionManager.STORAGE_KEY, []); this.sessions.clear(); m.forEach(meta => { this.sessions.set(meta.id, new Session(meta.name, meta.id)); }); } catch (e) { console.error("Load error:", e); this.sessions.clear(); } if (this.sessions.size === 0) this.createSession("Default Session"); }
  dispose() { this.getAllSessions().forEach(s => s.dispose()); this.sessions.clear(); }
}

// --- Tree View Items ---
type IntegratorTreeItem = SessionItem | FileSystemItem;
class SessionItem extends vscode.TreeItem {
  constructor(public readonly session: Session, collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Collapsed) {
    super(session.name, collapsibleState); this.id = session.id; this.contextValue = 'session'; this.iconPath = new vscode.ThemeIcon('folder-library'); this.tooltip = `Session: ${session.name}`; this.description = `(${session.storage.files.length} items)`;
  }
}
class FileSystemItem extends vscode.TreeItem {
  constructor(public readonly entry: FileEntry, collapsibleState: vscode.TreeItemCollapsibleState) {
    const basename = path.basename(entry.path); super(basename, collapsibleState); this.id = `${entry.sessionId}::${entry.path}`; this.resourceUri = vscode.Uri.file(entry.path); this.tooltip = `${entry.isDirectory ? 'Directory' : 'File'}:\n${entry.path}`; this.description = getDisplayPath(entry.path, true); this.contextValue = entry.isDirectory ? 'directory' : 'file'; this.iconPath = entry.isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
  }
  get sessionId(): string { return this.entry.sessionId; } get path(): string { return this.entry.path; } get isDirectory(): boolean { return this.entry.isDirectory; }
}

// --- Tree Data Provider ---
class FileIntegratorProvider implements vscode.TreeDataProvider<IntegratorTreeItem>, vscode.TreeDragAndDropController<IntegratorTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<IntegratorTreeItem | undefined | null | void> = new vscode.EventEmitter();
  readonly onDidChangeTreeData: vscode.Event<IntegratorTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;
  readonly dropMimeTypes = ['text/uri-list']; readonly dragMimeTypes: readonly string[] = [];
  constructor(private sessionManager: SessionManager) { }
  getTreeItem(element: IntegratorTreeItem): vscode.TreeItem { return element; }
  getChildren(element?: IntegratorTreeItem): vscode.ProviderResult<IntegratorTreeItem[]> {
    const sortEntries = (a: FileEntry, b: FileEntry) => (a.isDirectory === b.isDirectory) ? path.basename(a.path).localeCompare(path.basename(b.path)) : (a.isDirectory ? -1 : 1);
    if (!element) { return Promise.resolve(this.sessionManager.getAllSessions().map(s => new SessionItem(s, s.storage.files.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None))); }
    if (element instanceof SessionItem) { const s = this.sessionManager.getSession(element.session.id); if (!s) return []; const r = s.storage.files.filter(f => !f.parent).sort(sortEntries); return Promise.resolve(r.map(e => new FileSystemItem(e, e.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None))); }
    if (element instanceof FileSystemItem && element.isDirectory) { const s = this.sessionManager.getSession(element.sessionId); if (!s) return []; const c = s.storage.files.filter(f => f.parent === element.path).sort(sortEntries); return Promise.resolve(c.map(e => new FileSystemItem(e, e.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None))); }
    return Promise.resolve([]);
  }
  refresh(element?: IntegratorTreeItem): void { this._onDidChangeTreeData.fire(element); }

  // --- Drag and Drop Handler ---
  async handleDrop(target: IntegratorTreeItem | undefined, sources: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
    const transferItem = sources.get('text/uri-list');
    if (!transferItem || token.isCancellationRequested) return;

    // Determine target session
    let targetSession: Session | undefined;
    if (target instanceof SessionItem) targetSession = target.session;
    else if (target instanceof FileSystemItem) targetSession = this.sessionManager.getSession(target.sessionId);
    else {
      const sessions = this.sessionManager.getAllSessions(); targetSession = sessions.length > 0 ? sessions[0] : undefined;
      if (targetSession && sessions.length > 1) vscode.window.showInformationMessage(`Added files to session: "${targetSession.name}" (Dropped on view background)`);
      else if (!targetSession) { vscode.window.showErrorMessage("Cannot add files: No sessions exist."); return; }
    }
    if (!targetSession) { vscode.window.showErrorMessage("Could not determine target session."); return; }

    const uriList = await transferItem.asString();
    const uris = uriList.split('\n').map(u => u.trim()).filter(Boolean);
    if (uris.length === 0) return;

    // Process files with progress
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Adding files to session "${targetSession.name}"...`, cancellable: true }, async (progress, progressToken) => {
      progressToken.onCancellationRequested(() => { console.log("User cancelled file adding."); });
      for (let i = 0; i < uris.length; i++) {
        if (progressToken.isCancellationRequested) break;
        const uri = uris[i]; let filePath = '';
        try {
          filePath = uriToPath(uri);
          progress.report({ message: `(${i + 1}/${uris.length}) ${path.basename(filePath)}`, increment: 100 / uris.length });
          await this.processPath(filePath, targetSession, progressToken);
        } catch (err: any) { vscode.window.showErrorMessage(`Error processing ${filePath || uri}: ${err.message}`); console.error(`Error processing URI ${uri}:`, err); }
      }
    });

    // Refresh view ONLY
    this.refresh();
    console.log("Tree view refreshed after drop. Document update skipped intentionally.");

    // ** REMOVED THE CALL TO updateCodeBlockDocument HERE **
    // await updateCodeBlockDocument(targetSession); // <-- This line was removed
  }

  private async processPath(filePath: string, session: Session, token: vscode.CancellationToken): Promise<void> {
    if (token.isCancellationRequested) return;
    try {
      const exists = await fs.pathExists(filePath); if (!exists) return;
      if (token.isCancellationRequested) return;
      const stats = await fs.stat(filePath); if (token.isCancellationRequested) return;
      if (stats.isDirectory()) await session.storage.addDirectory(filePath);
      else if (stats.isFile()) await session.storage.addFile(filePath);
    } catch (err: any) { vscode.window.showErrorMessage(`Error processing path ${path.basename(filePath)}: ${err.message}`); console.error(`Error processing path ${filePath}:`, err); }
  }
}


// --- Global Variables & Activation ---
let sessionManager: SessionManager;
let fileIntegratorProvider: FileIntegratorProvider;
let treeView: vscode.TreeView<IntegratorTreeItem>;

export function activate(context: vscode.ExtensionContext) {
  sessionManager = new SessionManager(context); sessionManager.loadSessions();
  fileIntegratorProvider = new FileIntegratorProvider(sessionManager);
  treeView = vscode.window.createTreeView('fileIntegratorView', { treeDataProvider: fileIntegratorProvider, dragAndDropController: fileIntegratorProvider, showCollapseAll: true, canSelectMany: true });
  context.subscriptions.push(treeView); registerCommands(context); context.subscriptions.push({ dispose: () => sessionManager.dispose() });
  console.log('File Integrator activated.');
}

// --- Command Registration ---
function registerCommands(context: vscode.ExtensionContext) {
  const register = (commandId: string, callback: (...args: any[]) => any) => { context.subscriptions.push(vscode.commands.registerCommand(commandId, callback)); };

  // Session Management
  register('fileintegrator.addSession', async () => { const n = await vscode.window.showInputBox({ prompt: "Session name", value: `Session ${sessionManager.getAllSessions().length + 1}` }); if (n && n.trim()) { const s = sessionManager.createSession(n.trim()); fileIntegratorProvider.refresh(); treeView.reveal(new SessionItem(s), { select: true, focus: true, expand: true }); } });
  register('fileintegrator.removeSession', async (item?: SessionItem) => { const s = item?.session ?? await selectSession('Select session to remove'); if (!s) return; const c = await vscode.window.showWarningMessage(`Remove session "${s.name}"?`, { modal: true }, 'Yes'); if (c === 'Yes') { await s.closeAssociatedDocument(true); if (sessionManager.removeSession(s.id)) fileIntegratorProvider.refresh(); } });
  register('fileintegrator.renameSession', async (item?: SessionItem) => { const s = item?.session ?? await selectSession('Select session to rename'); if (!s) return; const n = await vscode.window.showInputBox({ prompt: `New name for "${s.name}"`, value: s.name }); if (n && n.trim() && sessionManager.renameSession(s.id, n.trim())) fileIntegratorProvider.refresh(); });

  // Session Content
  register('fileintegrator.clearSession', async (item?: SessionItem) => { const s = item?.session ?? await selectSession('Select session to clear'); if (!s || s.storage.files.length === 0) return; const c = await vscode.window.showWarningMessage(`Clear all files from "${s.name}"?`, { modal: true }, 'Yes'); if (c === 'Yes') { s.storage.clearFiles(); fileIntegratorProvider.refresh(); await updateCodeBlockDocument(s); } }); // Keep update here
  register('fileintegrator.generateCodeBlock', async (item?: SessionItem) => { const s = item?.session ?? await selectSession('Select session to generate'); if (!s) return; if (s.storage.filesOnly.length === 0) { vscode.window.showInformationMessage("No file content."); return; } const doc = await showCodeBlockDocument(s); if (doc) await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false }); });
  register('fileintegrator.copyToClipboard', async (item?: SessionItem) => { const s = item?.session ?? await selectSession('Select session to copy'); if (!s) return; if (s.storage.filesOnly.length === 0) { vscode.window.showInformationMessage("No file content."); return; } let c = (s.associatedDocument && !s.associatedDocument.isClosed) ? s.associatedDocument.getText() : generateMarkdownContent(s); if (c) { await vscode.env.clipboard.writeText(c); vscode.window.showInformationMessage(`Session "${s.name}" copied!`); } else { vscode.window.showWarningMessage("No content generated."); } });

  // File/Directory Item
  register('fileintegrator.removeFile', (item: FileSystemItem) => { if (!item || !(item instanceof FileSystemItem)) return; const s = sessionManager.getSession(item.sessionId); if (s) { if (s.storage.removeEntry(item.path)) { fileIntegratorProvider.refresh(); updateCodeBlockDocument(s); } else { fileIntegratorProvider.refresh(); } } }); // Keep update here

  // Utility
  register('fileintegrator.refreshView', () => { fileIntegratorProvider.refresh(); vscode.window.showInformationMessage("View refreshed."); });
}

// --- Deactivation ---
export function deactivate() { console.log('Deactivating File Integrator...'); }

// --- Helper Functions ---

/** Converts URI string to normalized file system path. */
function uriToPath(uriString: string): string { try { const u = vscode.Uri.parse(uriString, true); if (u.scheme === 'file') return u.fsPath; return path.normalize(decodeURIComponent(u.path)); } catch (e) { let p = uriString.replace(/^file:\/\//i, ''); try { p = decodeURIComponent(p); } catch { /* Ignore */ } if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.substring(1); return path.normalize(p); } }
/** Prompts user to select a session via Quick Pick. */
async function selectSession(placeHolder: string): Promise<Session | undefined> { const s = sessionManager.getAllSessions(); if (s.length === 0) { vscode.window.showErrorMessage("No sessions."); return; } if (s.length === 1) return s[0]; const p = s.map(x => ({ label: x.name, description: `(${x.storage.files.length} items)`, session: x })); const sel = await vscode.window.showQuickPick(p, { placeHolder, canPickMany: false }); return sel?.session; }
/** Generates aggregated Markdown content for a session. */
function generateMarkdownContent(session: Session): string { let c = ''; const f = session.storage.filesOnly.sort((a, b) => a.path.localeCompare(b.path)); if (f.length === 0) return `<!-- No file content in session "${session.name}" -->\n`; f.forEach(file => { const d = getDisplayPath(file.path); c += `${d}\n\`\`\`\n${file.content ?? `--- Error reading file content ---`}\n\`\`\`\n\n`; }); return c.trimEnd(); }
/** Shows/Updates the code block document for a session. */
async function showCodeBlockDocument(session: Session): Promise<vscode.TextDocument | undefined> { const content = generateMarkdownContent(session); if (session.associatedDocument && !session.associatedDocument.isClosed) { const doc = session.associatedDocument; try { const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), content); if (!await vscode.workspace.applyEdit(edit)) throw new Error("ApplyEdit failed"); return doc; } catch (e) { console.error(`Error updating doc ${doc.uri}:`, e); vscode.window.showErrorMessage("Failed to update doc."); session.closeAssociatedDocument(false); return; } } try { const doc = await vscode.workspace.openTextDocument({ content: content, language: 'markdown' }); session.setAssociatedDocument(doc); return doc; } catch (e: any) { console.error(`Failed to create doc:`, e); vscode.window.showErrorMessage(`Failed to create doc: ${e.message}`); return; } }
/** Updates associated document IF it exists and is open. */
async function updateCodeBlockDocument(session: Session): Promise<void> { if (session.associatedDocument && !session.associatedDocument.isClosed) { const d = session.associatedDocument; const c = generateMarkdownContent(session); try { const e = new vscode.WorkspaceEdit(); e.replace(d.uri, new vscode.Range(0, 0, d.lineCount, 0), c); if (!await vscode.workspace.applyEdit(e)) { console.warn(`ApplyEdit failed for ${d.uri}. Detaching.`); session.closeAssociatedDocument(false); } } catch (err) { console.error(`Error applying edit to ${d.uri}:`, err); vscode.window.showErrorMessage("Error updating code block."); session.closeAssociatedDocument(false); } } if (session.associatedDocument && session.associatedDocument.isClosed) { session.associatedDocument = null; } }
/** Generates display-friendly path, preferably relative. */
function getDisplayPath(filePath: string, short: boolean = false): string { const wf = vscode.workspace.workspaceFolders; let rp: string | undefined; if (wf) { const sf = [...wf].sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length); for (const f of sf) { const fp = f.uri.fsPath; if (filePath.startsWith(fp + path.sep)) { rp = path.relative(fp, filePath); break; } } } if (rp) return rp.replace(/\\/g, '/'); const p = filePath.split(/[\\/]/); const pc = p.length; if (!short && pc > 2) return '...' + path.sep + p.slice(-2).join(path.sep); else if (pc > 1) return p.slice(-2).join(path.sep); else return p[0] ?? filePath; }