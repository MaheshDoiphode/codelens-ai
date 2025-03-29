// The module 'vscode' contains the VS Code extensibility API
import * as vscode from 'vscode';
import * as path from 'path';
// Use fs-extra for easier async operations and promises by default
import * as fs from 'fs-extra';
import { v4 as uuidv4 } from 'uuid'; // For unique session IDs
import { minimatch } from 'minimatch'; // <-- Import minimatch

// --- Core Data Structures (FileEntry, SessionFileStorage, Session, SessionManager) ---
// ... (Keep these classes exactly the same as the previous version) ...
interface FileEntry { path: string; content: string | null; isDirectory: boolean; parent?: string; sessionId: string; }
class SessionFileStorage { /* ... No changes needed ... */
    private _files: Map<string, FileEntry> = new Map(); public readonly sessionId: string;
    constructor(sessionId: string) { this.sessionId = sessionId; }
    get files(): FileEntry[] { return Array.from(this._files.values()); }
    get filesOnly(): { path: string; content: string | null }[] { return this.files.filter(f => !f.isDirectory).map(f => ({ path: f.path, content: f.content })); }
    async addFile(filePath: string, parentPath?: string): Promise<boolean> { const n = path.normalize(filePath); if (this._files.has(n)) return false; let c: string | null = null; try { c = await fs.readFile(n, 'utf8'); } catch (e: any) { vscode.window.showErrorMessage(`Read file error: ${e.message}`); console.error(`Read file error ${n}:`, e); } const f: FileEntry = { path: n, content: c, isDirectory: false, parent: parentPath ? path.normalize(parentPath) : undefined, sessionId: this.sessionId }; this._files.set(n, f); return true; }
    async addDirectory(dirPath: string, parentPath?: string): Promise<boolean> { const n = path.normalize(dirPath); if (this._files.has(n) && this._files.get(n)?.isDirectory) return false; const d: FileEntry = { path: n, content: null, isDirectory: true, parent: parentPath ? path.normalize(parentPath) : undefined, sessionId: this.sessionId }; this._files.set(n, d); try { const es = await fs.readdir(n, { withFileTypes: true }); const ps: Promise<boolean>[] = []; for (const e of es) { const fp = path.join(n, e.name); if (e.isDirectory()) ps.push(this.addDirectory(fp, n)); else if (e.isFile()) ps.push(this.addFile(fp, n)); } await Promise.all(ps); } catch (e: any) { vscode.window.showErrorMessage(`Read dir error: ${e.message}`); console.error(`Read dir error ${n}:`, e); return false; } return true; }
    removeEntry(entryPath: string): boolean { const n = path.normalize(entryPath); const e = this._files.get(n); if (!e) return false; let rc = 0; if (this._files.delete(n)) rc++; if (e.isDirectory) { const p = n + path.sep; const k = Array.from(this._files.keys()); k.forEach(key => { if (key.startsWith(p) && this._files.delete(key)) rc++; }); } return rc > 0; }
    clearFiles(): number { const c = this._files.size; this._files.clear(); return c; }
}
class Session { /* ... No changes needed ... */
    public readonly id: string; public name: string; public readonly storage: SessionFileStorage; public associatedDocument: vscode.TextDocument | null = null; private docCloseListener: vscode.Disposable | null = null;
    constructor(name: string, id: string = uuidv4()) { this.id = id; this.name = name; this.storage = new SessionFileStorage(this.id); }
    dispose() { this.closeAssociatedDocument(false); this.docCloseListener?.dispose(); this.docCloseListener = null; this.storage.clearFiles(); }
    setAssociatedDocument(doc: vscode.TextDocument) { this.docCloseListener?.dispose(); this.associatedDocument = doc; this.docCloseListener = vscode.workspace.onDidCloseTextDocument(d => { if (d === this.associatedDocument) { this.associatedDocument = null; this.docCloseListener?.dispose(); this.docCloseListener = null; } }); }
    async closeAssociatedDocument(attemptEditorClose: boolean = true): Promise<void> { const d = this.associatedDocument; this.associatedDocument = null; this.docCloseListener?.dispose(); this.docCloseListener = null; if (attemptEditorClose && d) { for (const e of vscode.window.visibleTextEditors) { if (e.document === d) { try { await vscode.window.showTextDocument(d, { viewColumn: e.viewColumn, preserveFocus: false }); await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); break; } catch (err) { console.error(`Error closing editor:`, err); } } } } }
}
class SessionManager { /* ... No changes needed ... */
    private sessions: Map<string, Session> = new Map(); private static readonly STORAGE_KEY = 'fileIntegratorSessions'; constructor(private context: vscode.ExtensionContext) {}
    createSession(name?: string): Session { const n = name || `Session ${this.sessions.size + 1}`; const s = new Session(n); this.sessions.set(s.id, s); this.persistSessions(); return s; }
    getSession(id: string): Session | undefined { return this.sessions.get(id); } getAllSessions(): Session[] { return Array.from(this.sessions.values()).sort((a, b) => a.name.localeCompare(b.name)); }
    removeSession(id: string): boolean { const s = this.sessions.get(id); if (s) { s.dispose(); const d = this.sessions.delete(id); if (d) this.persistSessions(); return d; } return false; }
    renameSession(id: string, newName: string): boolean { const s = this.sessions.get(id); if(s) { s.name = newName; this.persistSessions(); return true; } return false; }
    persistSessions() { try { const m = this.getAllSessions().map(s => ({ id: s.id, name: s.name })); this.context.workspaceState.update(SessionManager.STORAGE_KEY, m); } catch (e) { console.error("Persist error:", e); } }
    loadSessions() { try { const m = this.context.workspaceState.get<{ id: string, name: string }[]>(SessionManager.STORAGE_KEY, []); this.sessions.clear(); m.forEach(meta => { this.sessions.set(meta.id, new Session(meta.name, meta.id)); }); } catch (e) { console.error("Load error:", e); this.sessions.clear(); } if (this.sessions.size === 0) this.createSession("Default Session"); }
    dispose() { this.getAllSessions().forEach(s => s.dispose()); this.sessions.clear(); }
}


// --- Tree View Items (SessionItem, FileSystemItem) ---
// ... (Keep these classes exactly the same as the previous version) ...
type IntegratorTreeItem = SessionItem | FileSystemItem;
class SessionItem extends vscode.TreeItem { constructor(public readonly session: Session, collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Collapsed) { super(session.name, collapsibleState); this.id = session.id; this.contextValue = 'session'; this.iconPath = new vscode.ThemeIcon('folder-library'); this.tooltip = `Session: ${session.name}`; this.description = `(${session.storage.files.length} items)`; } }
class FileSystemItem extends vscode.TreeItem { constructor(public readonly entry: FileEntry, collapsibleState: vscode.TreeItemCollapsibleState) { const b = path.basename(entry.path); super(b, collapsibleState); this.id = `${entry.sessionId}::${entry.path}`; this.resourceUri = vscode.Uri.file(entry.path); this.tooltip = `${entry.isDirectory ? 'Directory' : 'File'}:\n${entry.path}`; this.description = getDisplayPath(entry.path, true); this.contextValue = entry.isDirectory ? 'directory' : 'file'; this.iconPath = entry.isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File; } get sessionId(): string { return this.entry.sessionId; } get path(): string { return this.entry.path; } get isDirectory(): boolean { return this.entry.isDirectory; } }


// --- Tree Data Provider ---
class FileIntegratorProvider implements vscode.TreeDataProvider<IntegratorTreeItem>, vscode.TreeDragAndDropController<IntegratorTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<IntegratorTreeItem | undefined | null | void> = new vscode.EventEmitter();
    readonly onDidChangeTreeData: vscode.Event<IntegratorTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;
    readonly dropMimeTypes = ['text/uri-list']; readonly dragMimeTypes: readonly string[] = [];
    constructor(private sessionManager: SessionManager) {}
    getTreeItem(element: IntegratorTreeItem): vscode.TreeItem { return element; }
    getChildren(element?: IntegratorTreeItem): vscode.ProviderResult<IntegratorTreeItem[]> { /* ... (No changes needed) ... */
        const sortEntries = (a: FileEntry, b: FileEntry) => (a.isDirectory === b.isDirectory) ? path.basename(a.path).localeCompare(path.basename(b.path)) : (a.isDirectory ? -1 : 1);
        if (!element) { return Promise.resolve(this.sessionManager.getAllSessions().map(s => new SessionItem(s, s.storage.files.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None))); }
        if (element instanceof SessionItem) { const s = this.sessionManager.getSession(element.session.id); if (!s) return []; const r = s.storage.files.filter(f => !f.parent).sort(sortEntries); return Promise.resolve(r.map(e => new FileSystemItem(e, e.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None))); }
        if (element instanceof FileSystemItem && element.isDirectory) { const s = this.sessionManager.getSession(element.sessionId); if (!s) return []; const c = s.storage.files.filter(f => f.parent === element.path).sort(sortEntries); return Promise.resolve(c.map(e => new FileSystemItem(e, e.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None))); }
        return Promise.resolve([]);
     }
    refresh(element?: IntegratorTreeItem): void { this._onDidChangeTreeData.fire(element); }

    // --- Drag and Drop Handler ---
    async handleDrop(target: IntegratorTreeItem | undefined, sources: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> { /* ... (No changes needed) ... */
        const transferItem = sources.get('text/uri-list'); if (!transferItem || token.isCancellationRequested) return;
        let targetSession: Session | undefined; if (target instanceof SessionItem) targetSession = target.session; else if (target instanceof FileSystemItem) targetSession = this.sessionManager.getSession(target.sessionId); else { const s = this.sessionManager.getAllSessions(); targetSession = s.length > 0 ? s[0] : undefined; if(targetSession && s.length > 1) vscode.window.showInformationMessage(`Added files to session: "${targetSession.name}" (Dropped on view background)`); else if (!targetSession) { vscode.window.showErrorMessage("Cannot add files: No sessions exist."); return; } } if (!targetSession) { vscode.window.showErrorMessage("Could not determine target session."); return; }
        const uriList = await transferItem.asString(); const uris = uriList.split('\n').map(u => u.trim()).filter(Boolean); if (uris.length === 0) return;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Adding files to session "${targetSession.name}"...`, cancellable: true }, async (progress, progressToken) => {
            progressToken.onCancellationRequested(() => { console.log("User cancelled file adding."); }); let skippedCount = 0;
            for (let i = 0; i < uris.length; i++) {
                if (progressToken.isCancellationRequested) break;
                const uri = uris[i]; let filePath = '';
                 try {
                    filePath = uriToPath(uri);
                    progress.report({ message: `(${i+1}/${uris.length}) ${path.basename(filePath)}`, increment: 100/uris.length });
                    // ** Pass token to processPath **
                    const processed = await this.processPath(filePath, targetSession, progressToken);
                    if (!processed) { skippedCount++; } // Increment if processPath indicated skip
                 } catch (err: any) { vscode.window.showErrorMessage(`Error processing ${filePath || uri}: ${err.message}`); console.error(`Error processing URI ${uri}:`, err); }
            }
            if (skippedCount > 0) {
                vscode.window.showInformationMessage(`${skippedCount} item(s) were skipped due to exclusion settings.`);
            }
         });
        this.refresh(); // Refresh view only
     }

    /**
     * Process a single file system path. Checks exclusions before adding.
     * @param filePath The normalized path to process.
     * @param session The target session.
     * @param token Cancellation token.
     * @returns True if processed (added or attempted add), False if skipped due to exclusion.
     */
    private async processPath(filePath: string, session: Session, token: vscode.CancellationToken): Promise<boolean> {
        if (token.isCancellationRequested) return false; // Indicate not processed

        // --- Exclusion Check ---
        if (isPathExcluded(filePath)) {
            console.log(`[Exclude] Skipping excluded path: ${filePath}`);
            return false; // Indicate skipped
        }
        // ---------------------

        try {
             const exists = await fs.pathExists(filePath); if (!exists) return true; // Indicate processed (but didn't add)
             if (token.isCancellationRequested) return false;
            const stats = await fs.stat(filePath); if (token.isCancellationRequested) return false;

            if (stats.isDirectory()) {
                await session.storage.addDirectory(filePath);
            } else if (stats.isFile()) {
                await session.storage.addFile(filePath);
            }
             return true; // Indicate processed
        } catch (err: any) {
             vscode.window.showErrorMessage(`Error processing path ${path.basename(filePath)}: ${err.message}`);
             console.error(`Error processing path ${filePath}:`, err);
             return true; // Indicate processed (even though error occurred)
        }
    }
}


// --- Global Variables & Activation ---
// ... (Keep these the same) ...
let sessionManager: SessionManager; let fileIntegratorProvider: FileIntegratorProvider; let treeView: vscode.TreeView<IntegratorTreeItem>;
export function activate(context: vscode.ExtensionContext) { sessionManager = new SessionManager(context); sessionManager.loadSessions(); fileIntegratorProvider = new FileIntegratorProvider(sessionManager); treeView = vscode.window.createTreeView('fileIntegratorView', { treeDataProvider: fileIntegratorProvider, dragAndDropController: fileIntegratorProvider, showCollapseAll: true, canSelectMany: true }); context.subscriptions.push(treeView); registerCommands(context); context.subscriptions.push({ dispose: () => sessionManager.dispose() }); console.log('File Integrator activated.'); }


// --- Command Registration ---
function registerCommands(context: vscode.ExtensionContext) { /* ... (No changes needed) ... */
    const register = (commandId: string, callback: (...args: any[]) => any) => { context.subscriptions.push(vscode.commands.registerCommand(commandId, callback)); };
    register('fileintegrator.addSession', async () => { const n = await vscode.window.showInputBox({ prompt: "Session name", value: `Session ${sessionManager.getAllSessions().length + 1}` }); if (n && n.trim()) { const s = sessionManager.createSession(n.trim()); fileIntegratorProvider.refresh(); treeView.reveal(new SessionItem(s), { select: true, focus: true, expand: true }); } });
    register('fileintegrator.removeSession', async (item?: SessionItem) => { const s = item?.session ?? await selectSession('Select session to remove'); if (!s) return; const c = await vscode.window.showWarningMessage(`Remove session "${s.name}"?`, { modal: true }, 'Yes'); if (c === 'Yes') { await s.closeAssociatedDocument(true); if (sessionManager.removeSession(s.id)) fileIntegratorProvider.refresh(); } });
    register('fileintegrator.renameSession', async (item?: SessionItem) => { const s = item?.session ?? await selectSession('Select session to rename'); if (!s) return; const n = await vscode.window.showInputBox({ prompt: `New name for "${s.name}"`, value: s.name }); if (n && n.trim() && sessionManager.renameSession(s.id, n.trim())) fileIntegratorProvider.refresh(); });
    register('fileintegrator.clearSession', async (item?: SessionItem) => { const s = item?.session ?? await selectSession('Select session to clear'); if (!s || s.storage.files.length === 0) return; const c = await vscode.window.showWarningMessage(`Clear all files from "${s.name}"?`, { modal: true }, 'Yes'); if (c === 'Yes') { s.storage.clearFiles(); fileIntegratorProvider.refresh(); await updateCodeBlockDocument(s); } });
    register('fileintegrator.generateCodeBlock', async (item?: SessionItem) => { const s = item?.session ?? await selectSession('Select session to generate'); if (!s) return; if (s.storage.filesOnly.length === 0) { vscode.window.showInformationMessage("No file content."); return; } const doc = await showCodeBlockDocument(s); if (doc) await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false }); });
    register('fileintegrator.copyToClipboard', async (item?: SessionItem) => { const s = item?.session ?? await selectSession('Select session to copy'); if (!s) return; if (s.storage.filesOnly.length === 0) { vscode.window.showInformationMessage("No file content."); return; } let c = (s.associatedDocument && !s.associatedDocument.isClosed) ? s.associatedDocument.getText() : generateMarkdownContent(s); if (c) { await vscode.env.clipboard.writeText(c); vscode.window.showInformationMessage(`Session "${s.name}" copied!`); } else { vscode.window.showWarningMessage("No content generated."); } });
    register('fileintegrator.removeFile', (item: FileSystemItem) => { if (!item || !(item instanceof FileSystemItem)) return; const s = sessionManager.getSession(item.sessionId); if (s) { if (s.storage.removeEntry(item.path)) { fileIntegratorProvider.refresh(); updateCodeBlockDocument(s); } else { fileIntegratorProvider.refresh(); } } });
    register('fileintegrator.refreshView', () => { fileIntegratorProvider.refresh(); vscode.window.showInformationMessage("View refreshed."); });
 }

// --- Deactivation ---
export function deactivate() { console.log('Deactivating File Integrator...'); }

// --- Helper Functions ---

/**
 * Checks if a given file path matches any exclusion patterns defined
 * in the 'fileintegrator.exclude' setting.
 * @param filePath The absolute, normalized path to check.
 * @returns True if the path should be excluded, false otherwise.
 */
function isPathExcluded(filePath: string): boolean {
    const config = vscode.workspace.getConfiguration('fileintegrator');
    const excludePatterns = config.get<Record<string, boolean>>('exclude');

    if (!excludePatterns) {
        return false; // No patterns defined
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const normalizedFilePath = filePath.replace(/\\/g, '/'); // Use forward slashes for matching

    for (const pattern in excludePatterns) {
        if (excludePatterns[pattern]) { // Only check patterns set to true
            // Prepare the pattern for minimatch (ensure forward slashes)
            const normalizedPattern = pattern.replace(/\\/g, '/');

            // 1. Check against absolute path (handles patterns like /Users/me/... or C:/...)
            // Useful for patterns starting with / or drive letters, or full paths.
            if (minimatch(normalizedFilePath, normalizedPattern, { dot: true })) {
                 // console.log(`[Exclude] Absolute path match: ${normalizedFilePath} vs ${normalizedPattern}`);
                 return true;
             }

            // 2. Check against path relative to workspace folders (most common use case)
            if (workspaceFolders) {
                for (const folder of workspaceFolders) {
                    const folderPath = folder.uri.fsPath.replace(/\\/g, '/');
                    if (normalizedFilePath.startsWith(folderPath + '/')) {
                        const relativePath = normalizedFilePath.substring(folderPath.length + 1);
                        if (minimatch(relativePath, normalizedPattern, { dot: true })) {
                             // console.log(`[Exclude] Relative path match: ${relativePath} vs ${normalizedPattern} in ${folder.name}`);
                             return true;
                         }
                    }
                }
            }

             // 3. Check against basename only (for patterns like *.log or .DS_Store)
             // matchBase allows patterns like *.log to match file.log directly
             if (minimatch(path.basename(normalizedFilePath), normalizedPattern, { dot: true, matchBase: true })) {
                // console.log(`[Exclude] Basename match: ${path.basename(normalizedFilePath)} vs ${normalizedPattern}`);
                return true;
            }
        }
    }

    return false; // No matching exclusion pattern found
}


/** Converts URI string to normalized file system path. */
 function uriToPath(uriString: string): string { /* ... (No changes needed) ... */
    try { const u = vscode.Uri.parse(uriString, true); if (u.scheme === 'file') return u.fsPath; return path.normalize(decodeURIComponent(u.path)); } catch (e) { let p = uriString.replace(/^file:\/\//i, ''); try { p = decodeURIComponent(p); } catch { /* Ignore */ } if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.substring(1); return path.normalize(p); }
 }
/** Prompts user to select a session via Quick Pick. */
 async function selectSession(placeHolder: string): Promise<Session | undefined> { /* ... (No changes needed) ... */
    const s = sessionManager.getAllSessions(); if (s.length === 0) { vscode.window.showErrorMessage("No sessions."); return; } if (s.length === 1) return s[0]; const p = s.map(x => ({ label: x.name, description: `(${x.storage.files.length} items)`, session: x })); const sel = await vscode.window.showQuickPick(p, { placeHolder, canPickMany: false }); return sel?.session;
 }
/** Generates aggregated Markdown content for a session. */
 function generateMarkdownContent(session: Session): string { /* ... (No changes needed) ... */
    let c = ''; const f = session.storage.filesOnly.sort((a, b) => a.path.localeCompare(b.path)); if (f.length === 0) return `<!-- No file content in session "${session.name}" -->\n`; f.forEach(file => { const d = getDisplayPath(file.path); c += `${d}\n\`\`\`\n${file.content ?? `--- Error reading file content ---`}\n\`\`\`\n\n`; }); return c.trimEnd();
 }
/** Shows/Updates the code block document for a session. */
async function showCodeBlockDocument(session: Session): Promise<vscode.TextDocument | undefined> { /* ... (No changes needed) ... */
    const content = generateMarkdownContent(session); if (session.associatedDocument && !session.associatedDocument.isClosed) { const doc = session.associatedDocument; try { const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), content); if (!await vscode.workspace.applyEdit(edit)) throw new Error("ApplyEdit failed"); return doc; } catch (e) { console.error(`Error updating doc ${doc.uri}:`, e); vscode.window.showErrorMessage("Failed to update doc."); session.closeAssociatedDocument(false); return; } } try { const doc = await vscode.workspace.openTextDocument({ content: content, language: 'markdown' }); session.setAssociatedDocument(doc); return doc; } catch (e: any) { console.error(`Failed to create doc:`, e); vscode.window.showErrorMessage(`Failed to create doc: ${e.message}`); return; }
 }
/** Updates associated document IF it exists and is open. */
async function updateCodeBlockDocument(session: Session): Promise<void> { /* ... (No changes needed) ... */
    if (session.associatedDocument && !session.associatedDocument.isClosed) { const d = session.associatedDocument; const c = generateMarkdownContent(session); try { const e = new vscode.WorkspaceEdit(); e.replace(d.uri, new vscode.Range(0, 0, d.lineCount, 0), c); if (!await vscode.workspace.applyEdit(e)) { console.warn(`ApplyEdit failed for ${d.uri}. Detaching.`); session.closeAssociatedDocument(false); } } catch (err) { console.error(`Error applying edit to ${d.uri}:`, err); vscode.window.showErrorMessage("Error updating code block."); session.closeAssociatedDocument(false); } } if (session.associatedDocument && session.associatedDocument.isClosed) { session.associatedDocument = null; }
 }
/** Generates display-friendly path, preferably relative. */
function getDisplayPath(filePath: string, short: boolean = false): string { /* ... (No changes needed) ... */
    const wf = vscode.workspace.workspaceFolders; let rp: string | undefined; if (wf) { const sf = [...wf].sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length); for (const f of sf) { const fp = f.uri.fsPath; if (filePath.startsWith(fp + path.sep)) { rp = path.relative(fp, filePath); break; } } } if (rp) return rp.replace(/\\/g, '/'); const p = filePath.split(/[\\/]/); const pc = p.length; if (!short && pc > 2) return '...' + path.sep + p.slice(-2).join(path.sep); else if (pc > 1) return p.slice(-2).join(path.sep); else return p[0] ?? filePath;
 }