import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';
import { v4 as uuidv4 } from 'uuid';
import { minimatch } from 'minimatch';

// --- Core Data Structures ---

interface FileEntry {
    path: string;       // Normalized path
    content: string | null; // Content is null initially after load, loaded on demand
    isDirectory: boolean;
    parent?: string;     // Normalized path of the parent directory
    sessionId: string;  // Belongs to which session
}

// Structure for persisting file metadata (order is preserved by array position)
interface PersistedFileEntry {
    path: string;
    isDirectory: boolean;
    parent?: string;
}

// Structure for persisting session metadata and its ordered file list
interface PersistedSession {
    id: string;
    name: string;
    files: PersistedFileEntry[];
}

/**
 * Manages file storage for a single session using an Array to preserve order.
 */
class SessionFileStorage {
    private _files: FileEntry[] = [];
    public readonly sessionId: string;

    constructor(sessionId: string) {
        this.sessionId = sessionId;
    }

    get files(): readonly FileEntry[] { // Return readonly view
        return this._files;
    }

    get filesOnly(): { path: string; content: string | null }[] {
        return this._files.filter(f => !f.isDirectory).map(f => ({ path: f.path, content: f.content }));
    }

    findEntry(filePath: string): FileEntry | undefined {
        const normalizedPath = path.normalize(filePath);
        return this._files.find(f => f.path === normalizedPath);
    }

    async addFile(filePath: string, parentPath?: string): Promise<boolean> {
        const normalizedPath = path.normalize(filePath);
        const normalizedParentPath = parentPath ? path.normalize(parentPath) : undefined;

        if (this._files.some(f => f.path === normalizedPath)) {
            return false;
        }

        let content: string | null = null;
        try {
            content = await fs.readFile(normalizedPath, 'utf8');
        } catch (error: any) {
            vscode.window.showErrorMessage(`Read file error during add: ${error.message}`);
            console.error(`Read file error (add) ${normalizedPath}:`, error);
            // Keep content as null if read fails
        }

        const fileEntry: FileEntry = {
            path: normalizedPath,
            content: content,
            isDirectory: false,
            parent: normalizedParentPath,
            sessionId: this.sessionId,
        };
        this._files.push(fileEntry);
        return true;
    }

    async addDirectory(dirPath: string, parentPath?: string): Promise<boolean> {
        const normalizedPath = path.normalize(dirPath);
        const normalizedParentPath = parentPath ? path.normalize(parentPath) : undefined;

        if (this._files.some(f => f.path === normalizedPath && f.isDirectory)) {
            return false;
        }

        const dirEntry: FileEntry = {
            path: normalizedPath,
            content: null, // Directories have no content
            isDirectory: true,
            parent: normalizedParentPath,
            sessionId: this.sessionId,
        };
        this._files.push(dirEntry);

        try {
            const entries = await fs.readdir(normalizedPath, { withFileTypes: true });
            const processingPromises: Promise<boolean>[] = [];

            for (const entry of entries) {
                const fullPath = path.join(normalizedPath, entry.name);
                if (!isPathExcluded(fullPath)) {
                    if (entry.isDirectory()) {
                        processingPromises.push(this.addDirectory(fullPath, normalizedPath));
                    } else if (entry.isFile()) {
                        processingPromises.push(this.addFile(fullPath, normalizedPath));
                    }
                } else {
                     console.log(`[Exclude][AddDir] Skipping excluded child: ${fullPath}`);
                 }
            }
            await Promise.all(processingPromises);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Read dir error: ${error.message}`);
            console.error(`Read dir error ${normalizedPath}:`, error);
            return false;
        }
        return true;
    }

    removeEntry(entryPath: string): boolean {
        const normalizedPath = path.normalize(entryPath);
        const initialLength = this._files.length;

        const mainIndex = this._files.findIndex(f => f.path === normalizedPath);
        if (mainIndex === -1) return false;

        const entryToRemove = this._files[mainIndex];
        const isDirectory = entryToRemove.isDirectory;

        const prefix = isDirectory ? normalizedPath + path.sep : null;
        this._files = this._files.filter(f => {
            if (f.path === normalizedPath) return false;
            if (prefix && f.path.startsWith(prefix)) return false;
            return true;
        });

        return this._files.length < initialLength;
    }

    clearFiles(): number {
        const count = this._files.length;
        this._files = [];
        return count;
    }

    /**
     * Restores the entire file list from persisted data.
     * Should only be called during session loading.
     * @param restoredFiles An array of FileEntry objects (with content set to null).
     */
    restoreFiles(restoredFiles: FileEntry[]): void {
        // Simple replacement - assumes restoredFiles is the complete, ordered list.
        this._files = restoredFiles;
        console.log(`[Storage:restore] Restored ${this._files.length} file entries for session ${this.sessionId}`);
    }

    reorderItems(draggedPaths: string[], targetPath?: string, dropOnSession: boolean = false): boolean {
        console.log(`[Storage:reorder] Dragged: ${draggedPaths.join(', ')}, Target: ${targetPath}, OnSession: ${dropOnSession}`);

        const draggedEntries: FileEntry[] = [];
        for (const draggedPath of draggedPaths) {
            const entry = this.findEntry(draggedPath);
            if (entry) {
                draggedEntries.push(entry);
            } else {
                console.error(`[Storage:reorder] Could not find dragged entry: ${draggedPath}`);
                return false;
            }
        }
        if (draggedEntries.length === 0) return false;

        const firstParent = draggedEntries[0].parent;
        if (!draggedEntries.every(e => e.parent === firstParent)) {
            console.warn('[Storage:reorder] Dragged items have different parents. Reordering aborted.');
            vscode.window.showWarningMessage("Cannot move items between different folders yet.");
            return false;
        }

        const originalIndices = draggedEntries.map(entry => this._files.findIndex(f => f.path === entry.path)).sort((a, b) => b - a);
        originalIndices.forEach(index => {
            if (index > -1) this._files.splice(index, 1);
        });

        let targetIndex = -1;
        if (dropOnSession) {
            targetIndex = this._files.findIndex(f => f.parent === undefined);
            if (targetIndex === -1) targetIndex = this._files.length;
            console.log(`[Storage:reorder] Dropped on session, target index: ${targetIndex}`);
        } else if (targetPath) {
            targetIndex = this._files.findIndex(f => f.path === targetPath);
            if (targetIndex === -1) {
                console.error(`[Storage:reorder] Target path not found after removing dragged items: ${targetPath}`);
                 this._files.push(...draggedEntries); // Put back at end as fallback
                return false;
            }
             console.log(`[Storage:reorder] Dropped on item ${targetPath}, target index: ${targetIndex}`);
        } else {
            const parent = firstParent;
            let lastIndexOfParentGroup = -1;
            for(let i = this._files.length - 1; i >= 0; i--) {
                if (this._files[i].parent === parent) {
                    lastIndexOfParentGroup = i;
                    break;
                }
            }
            targetIndex = lastIndexOfParentGroup + 1;
             console.log(`[Storage:reorder] Dropped on empty space within parent '${parent}', target index: ${targetIndex}`);
        }

        this._files.splice(targetIndex, 0, ...draggedEntries);
        console.log(`[Storage:reorder] Reordering successful. New count: ${this._files.length}`);
        // Persistence is handled by the caller (Tree Provider)
        return true;
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
        this.closeAssociatedDocument(false); // Close doc without saving editor state
        this.docCloseListener?.dispose();
        this.docCloseListener = null;
        this.storage.clearFiles(); // Clear in-memory storage
    }

    setAssociatedDocument(doc: vscode.TextDocument) {
        // Dispose previous listener if any
        this.docCloseListener?.dispose();
        this.associatedDocument = doc;
        // Listen for when *this specific* document is closed
        this.docCloseListener = vscode.workspace.onDidCloseTextDocument(d => {
            if (d === this.associatedDocument) {
                console.log(`[Session ${this.id}] Associated document closed.`);
                this.associatedDocument = null;
                this.docCloseListener?.dispose(); // Dispose self
                this.docCloseListener = null;
            }
        });
    }

    async closeAssociatedDocument(attemptEditorClose: boolean = true): Promise<void> {
        const docToClose = this.associatedDocument;
        this.associatedDocument = null; // Clear association immediately
        this.docCloseListener?.dispose(); // Stop listening
        this.docCloseListener = null;

        if (attemptEditorClose && docToClose) {
            // Find the editor showing this document and close it
            for (const editor of vscode.window.visibleTextEditors) {
                if (editor.document === docToClose) {
                    try {
                        // Focus the editor containing the doc to make 'closeActiveEditor' work reliably
                        await vscode.window.showTextDocument(docToClose, { viewColumn: editor.viewColumn, preserveFocus: false });
                        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                        console.log(`[Session ${this.id}] Closed editor for associated document.`);
                        break; // Assume only one editor shows it
                    } catch (err) {
                        console.error(`[Session ${this.id}] Error closing editor:`, err);
                        // Don't block if closing fails
                    }
                }
            }
        }
    }
}

// --- Session Manager Class ---
class SessionManager {
    private sessions: Map<string, Session> = new Map();
    // Use versioned keys for easier future migrations
    private static readonly STORAGE_KEY = 'fileIntegratorSessions_v2';
    private static readonly OLD_STORAGE_KEY = 'fileIntegratorSessions'; 

    constructor(private context: vscode.ExtensionContext) {}

    createSession(name?: string): Session {
        const sessionName = name || `Session ${this.sessions.size + 1}`;
        const newSession = new Session(sessionName);
        this.sessions.set(newSession.id, newSession);
        this.persistSessions(); // Persist after creation
        return newSession;
    }

    getSession(id: string): Session | undefined {
        return this.sessions.get(id);
    }

    getAllSessions(): Session[] {
        // Sort by name for consistent display order
        return Array.from(this.sessions.values()).sort((a, b) => a.name.localeCompare(b.name));
    }

    removeSession(id: string): boolean {
        const session = this.sessions.get(id);
        if (session) {
            session.dispose(); // Clean up session resources (listeners, etc.)
            const deleted = this.sessions.delete(id);
            if (deleted) {
                this.persistSessions(); // Persist after removal
            }
            return deleted;
        }
        return false;
    }

    renameSession(id: string, newName: string): boolean {
        const session = this.sessions.get(id);
        if(session) {
            session.name = newName;
            this.persistSessions(); // Persist after rename
            return true;
        }
        return false;
    }

    persistSessions() {
        try {
            const persistedData: PersistedSession[] = this.getAllSessions().map(session => {
                const persistedFiles: PersistedFileEntry[] = session.storage.files.map(entry => ({
                    path: entry.path,
                    isDirectory: entry.isDirectory,
                    parent: entry.parent,
                }));

                return {
                    id: session.id,
                    name: session.name,
                    files: persistedFiles,
                };
            });

            this.context.workspaceState.update(SessionManager.STORAGE_KEY, persistedData);
            // Clean up old key data after successful save to new key
            this.context.workspaceState.update(SessionManager.OLD_STORAGE_KEY, undefined);
            console.log(`[Persist] Saved ${persistedData.length} sessions with file structure.`);

        } catch (e) {
            console.error("[Persist] Error saving session data:", e);
            vscode.window.showErrorMessage("Error saving File Integrator session data.");
        }
    }

    loadSessions() {
        this.sessions.clear();
        let loadedData: any[] | undefined = undefined;
        let loadedFromOldKey = false;

        try {
            loadedData = this.context.workspaceState.get<PersistedSession[]>(SessionManager.STORAGE_KEY);

            if (!loadedData) {
                const oldData = this.context.workspaceState.get<{ id: string, name: string }[]>(SessionManager.OLD_STORAGE_KEY);
                if (oldData && oldData.length > 0) {
                    console.log("[Load] Migrating data from old storage key.");
                    loadedData = oldData.map(meta => ({
                        id: meta.id,
                        name: meta.name,
                        files: [] // Initialize with empty files for old sessions
                    }));
                    loadedFromOldKey = true;
                } else {
                    loadedData = [];
                }
            }

            (loadedData as PersistedSession[]).forEach(meta => {
                // Basic validation of loaded data
                if (!meta || typeof meta.id !== 'string' || typeof meta.name !== 'string' || !Array.isArray(meta.files)) {
                    console.warn("[Load] Skipping invalid session metadata entry:", meta);
                    return;
                }

                const session = new Session(meta.name, meta.id);

                // --- Start of Fix ---

                // 1. Map persisted entries to FileEntry or null if invalid
                const mappedEntries: (FileEntry | null)[] = meta.files.map((pf: PersistedFileEntry): FileEntry | null => {
                    // Validate each persisted file entry
                    if (!pf || typeof pf.path !== 'string' || typeof pf.isDirectory !== 'boolean') {
                        console.warn(`[Load] Skipping invalid file entry in session ${meta.id}:`, pf);
                        return null; // Indicate invalid entry
                    }

                    // Create an object conforming to FileEntry interface
                    const entry: FileEntry = {
                        path: pf.path,
                        isDirectory: pf.isDirectory,
                        parent: pf.parent, // Assign directly; undefined is valid for optional string | undefined
                        content: null,    // Content is never persisted
                        sessionId: session.id,
                    };
                    return entry;
                });

                // 2. Filter out the null values using a type predicate
                // This step correctly narrows the type from (FileEntry | null)[] to FileEntry[]
                const restoredFiles: FileEntry[] = mappedEntries.filter(
                    (entry): entry is FileEntry => entry !== null
                );

                // --- End of Fix ---

                session.storage.restoreFiles(restoredFiles); // Use the dedicated method with the correctly typed array
                this.sessions.set(session.id, session);
            });

            console.log(`[Load] Loaded ${this.sessions.size} sessions.`);
            if (loadedFromOldKey) {
                // If we migrated, persist immediately in the new format
                this.persistSessions();
            }

        } catch (e) {
            console.error("[Load] Error loading session data:", e);
            this.sessions.clear(); // Clear potentially corrupted data
            vscode.window.showErrorMessage("Error loading File Integrator session data. Sessions may be reset.");
        }

        // Ensure at least one session exists if none were loaded/created
        if (this.sessions.size === 0) {
            console.log("[Load] No sessions found or loaded, creating default session.");
            this.createSession("Default Session"); // This will also trigger persistSessions
        }
    }

    dispose() {
        // No need to persist here, persistence should happen on modification actions
        this.getAllSessions().forEach(s => s.dispose());
        this.sessions.clear();
    }
}


// --- Tree View Items (No changes needed) ---
type IntegratorTreeItem = SessionItem | FileSystemItem;
class SessionItem extends vscode.TreeItem { constructor(public readonly session: Session, collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Collapsed) { super(session.name, collapsibleState); this.id = session.id; this.contextValue = 'session'; this.iconPath = new vscode.ThemeIcon('folder-library'); this.tooltip = `Session: ${session.name}`; this.description = `(${session.storage.files.length} items)`; } }
class FileSystemItem extends vscode.TreeItem { constructor(public readonly entry: FileEntry, collapsibleState: vscode.TreeItemCollapsibleState) { const b = path.basename(entry.path); super(b, collapsibleState); this.id = `${entry.sessionId}::${entry.path}`; this.resourceUri = vscode.Uri.file(entry.path); this.tooltip = `${entry.isDirectory ? 'Directory' : 'File'}:\n${entry.path}`; this.description = getDisplayPath(entry.path, true); this.contextValue = entry.isDirectory ? 'directory' : 'file'; this.iconPath = entry.isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File; } get sessionId(): string { return this.entry.sessionId; } get path(): string { return this.entry.path; } get isDirectory(): boolean { return this.entry.isDirectory; } }


// --- Tree Data Provider ---
class FileIntegratorProvider implements vscode.TreeDataProvider<IntegratorTreeItem>, vscode.TreeDragAndDropController<IntegratorTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<IntegratorTreeItem | undefined | null | void> = new vscode.EventEmitter();
    readonly onDidChangeTreeData: vscode.Event<IntegratorTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    readonly dropMimeTypes = ['text/uri-list', 'application/vnd.code.tree.fileIntegratorView'];
    readonly dragMimeTypes = ['application/vnd.code.tree.fileIntegratorView'];
    private readonly customMimeType = 'application/vnd.code.tree.fileIntegratorView';

    constructor(private sessionManager: SessionManager) {}

    getTreeItem(element: IntegratorTreeItem): vscode.TreeItem { return element; }

    getChildren(element?: IntegratorTreeItem): vscode.ProviderResult<IntegratorTreeItem[]> {
        if (!element) { // Root: Sessions
             return Promise.resolve(this.sessionManager.getAllSessions().map(s => new SessionItem(s, s.storage.files.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)));
        }
        if (element instanceof SessionItem) { // Session Children (Root files/dirs)
            const session = this.sessionManager.getSession(element.session.id);
            if (!session) return [];
            const rootEntries = session.storage.files.filter(f => !f.parent);
            return Promise.resolve(rootEntries.map(e => new FileSystemItem(e, e.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)));
        }
        if (element instanceof FileSystemItem && element.isDirectory) { // Directory Children
            const session = this.sessionManager.getSession(element.sessionId);
            if (!session) return [];
            const childEntries = session.storage.files.filter(f => f.parent === element.path);
            return Promise.resolve(childEntries.map(e => new FileSystemItem(e, e.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)));
        }
        return Promise.resolve([]);
     }

    refresh(element?: IntegratorTreeItem): void {
        this._onDidChangeTreeData.fire(element);
    }

    // --- Drag and Drop Controller Implementation ---

    handleDrag(source: readonly IntegratorTreeItem[], dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): void | Thenable<void> {
        console.log(`[handleDrag] Starting drag for ${source.length} items.`);
        const draggableItems = source.filter((item): item is FileSystemItem => item instanceof FileSystemItem);

        if (draggableItems.length > 0) {
            const draggedIds = draggableItems.map(item => item.id); // Use unique TreeItem ID
            console.log(`[handleDrag] Dragging IDs: ${draggedIds.join(', ')}`);
            dataTransfer.set(this.customMimeType, new vscode.DataTransferItem(draggedIds));
        } else {
             console.log(`[handleDrag] No draggable FileSystemItems selected.`);
         }
    }

    async handleDrop(target: IntegratorTreeItem | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
        console.log(`[handleDrop] Drop detected. Target: ${target?.id ?? 'view root'}`);
        const internalDropItem = dataTransfer.get(this.customMimeType);
        const externalDropItem = dataTransfer.get('text/uri-list');

        if (token.isCancellationRequested) return;

        // --- Handle INTERNAL Reorder Drop ---
        if (internalDropItem) {
            console.log('[handleDrop] Handling internal drop (reorder).');
            const draggedItemIds = internalDropItem.value as string[];
            if (!Array.isArray(draggedItemIds) || draggedItemIds.length === 0) {
                 console.warn('[handleDrop] Internal drop data is invalid.'); return;
            }

            const firstDraggedIdParts = draggedItemIds[0].split('::');
            if (firstDraggedIdParts.length !== 2) { console.warn('[handleDrop] Invalid dragged item ID format.'); return; }
            const sessionId = firstDraggedIdParts[0];
            const draggedPaths = draggedItemIds.map(id => id.split('::')[1]).filter(Boolean);

            const session = this.sessionManager.getSession(sessionId);
            if (!session) { console.error(`[handleDrop] Session not found for internal drop: ${sessionId}`); return; }

            let targetPath: string | undefined;
            let dropOnSessionNode = false;

            if (target instanceof SessionItem) {
                 if (target.session.id !== sessionId) {
                    vscode.window.showErrorMessage("Cannot move items between sessions yet."); return;
                 }
                dropOnSessionNode = true;
            } else if (target instanceof FileSystemItem) {
                 if (target.sessionId !== sessionId) {
                    vscode.window.showErrorMessage("Cannot move items between sessions yet."); return;
                 }
                targetPath = target.path;
            } else {
                console.log('[handleDrop] Dropped on empty space.');
            }

            const success = session.storage.reorderItems(draggedPaths, targetPath, dropOnSessionNode);

            if (success) {
                this.sessionManager.persistSessions(); // <-- PERSIST after successful reorder
                this.refresh();
                await updateCodeBlockDocument(session); // Update associated doc (awaiting async generation)
            } else {
                // Refresh even if reorder failed internally (e.g. target not found after delete)
                this.refresh();
            }
        }
        // --- Handle EXTERNAL File/Folder Drop ---
        else if (externalDropItem) {
            console.log('[handleDrop] Handling external drop (uri-list).');
             let targetSession: Session | undefined;
             if (target instanceof SessionItem) targetSession = target.session;
             else if (target instanceof FileSystemItem) targetSession = this.sessionManager.getSession(target.sessionId);
             else { const s = this.sessionManager.getAllSessions(); targetSession = s.length > 0 ? s[0] : undefined; if(targetSession && s.length > 1) vscode.window.showInformationMessage(`Added files to session: "${targetSession.name}" (Dropped on view background)`); else if (!targetSession) { vscode.window.showErrorMessage("Cannot add files: No sessions exist."); return; } }
             if (!targetSession) { vscode.window.showErrorMessage("Could not determine target session."); return; }

            const uriList = await externalDropItem.asString();
            const uris = uriList.split('\n').map(u => u.trim()).filter(Boolean);
            if (uris.length === 0) return;

            let filesWereAdded = false; // Track if any file was actually processed
            let skippedCount = 0;
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Adding files to session "${targetSession.name}"...`, cancellable: true }, async (progress, progressToken) => {
                progressToken.onCancellationRequested(() => { console.log("User cancelled file adding."); });
                for (let i = 0; i < uris.length; i++) {
                    if (progressToken.isCancellationRequested) break;
                    const uri = uris[i]; let filePath = '';
                     try {
                        filePath = uriToPath(uri);
                        progress.report({ message: `(${i+1}/${uris.length}) ${path.basename(filePath)}`, increment: 100/uris.length });
                        const processed = await this.processPath(filePath, targetSession, progressToken);
                        if (processed) {
                             filesWereAdded = true; // Mark true if processPath didn't skip
                         } else {
                             skippedCount++;
                         }
                     } catch (err: any) { vscode.window.showErrorMessage(`Error processing ${filePath || uri}: ${err.message}`); console.error(`Error processing URI ${uri}:`, err); }
                }
             });

             if (filesWereAdded) {
                 this.sessionManager.persistSessions(); // <-- PERSIST if files were added
                 await updateCodeBlockDocument(targetSession); // Update doc if needed
             }
             if (skippedCount > 0) vscode.window.showInformationMessage(`${skippedCount} item(s) were skipped due to exclusion settings.`);
             this.refresh(); // Refresh view regardless
        } else {
             console.log('[handleDrop] No supported data transfer item found.');
         }
    }

    /** Process external path, checking exclusions. Returns true if processed, false if skipped. */
    private async processPath(filePath: string, session: Session, token: vscode.CancellationToken): Promise<boolean> {
        if (token.isCancellationRequested) return false; // Skipped due to cancellation
        if (isPathExcluded(filePath)) {
            console.log(`[Exclude] Skipping excluded path: ${filePath}`);
            return false; // Skipped due to exclusion
        }
        try {
             const exists = await fs.pathExists(filePath);
             if (!exists) {
                 console.warn(`[ProcessPath] Path does not exist: ${filePath}`);
                 // Don't treat non-existent path as an error, just skip processing it.
                 return false; // Skipped because it doesn't exist
             }
             if (token.isCancellationRequested) return false;

            const stats = await fs.stat(filePath);
            if (token.isCancellationRequested) return false;

            let added = false;
             if (stats.isDirectory()) {
                 added = await session.storage.addDirectory(filePath);
             } else if (stats.isFile()) {
                 added = await session.storage.addFile(filePath);
             }
             return added; // Return true if addDirectory/addFile succeeded (wasn't duplicate)
        } catch (err: any) {
            vscode.window.showErrorMessage(`Error processing path ${path.basename(filePath)}: ${err.message}`);
            console.error(`Error processing path ${filePath}:`, err);
            return false; // Skipped due to error
        }
    }
}


// --- Global Variables & Activation ---
let sessionManager: SessionManager;
let fileIntegratorProvider: FileIntegratorProvider;
let treeView: vscode.TreeView<IntegratorTreeItem>;

export function activate(context: vscode.ExtensionContext) {
    console.log('Activating File Integrator...');
    sessionManager = new SessionManager(context);
    sessionManager.loadSessions(); // Load persisted sessions

    fileIntegratorProvider = new FileIntegratorProvider(sessionManager);

    treeView = vscode.window.createTreeView('fileIntegratorView', {
        treeDataProvider: fileIntegratorProvider,
        dragAndDropController: fileIntegratorProvider,
        showCollapseAll: true,
        canSelectMany: true
    });

    context.subscriptions.push(treeView);
    registerCommands(context); // Register commands after initializing manager/provider

    // Register disposable for session manager cleanup
    context.subscriptions.push({ dispose: () => sessionManager.dispose() });

    console.log('File Integrator activated.');
}


// --- Command Registration ---
function registerCommands(context: vscode.ExtensionContext) {
    const register = (commandId: string, callback: (...args: any[]) => any) => {
        context.subscriptions.push(vscode.commands.registerCommand(commandId, callback));
    };

    // Add Session (already persists via createSession)
    register('fileintegrator.addSession', async () => {
        const n = await vscode.window.showInputBox({ prompt: "Enter new session name", value: `Session ${sessionManager.getAllSessions().length + 1}` });
        if (n && n.trim()) {
            const s = sessionManager.createSession(n.trim());
            fileIntegratorProvider.refresh();
            // Reveal the new session in the tree
            treeView.reveal(new SessionItem(s), { select: true, focus: true, expand: true });
        }
    });

    // Remove Session (already persists via removeSession)
    register('fileintegrator.removeSession', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to remove');
        if (!s) return;
        const c = await vscode.window.showWarningMessage(`Are you sure you want to remove the session "${s.name}"?`, { modal: true }, 'Yes', 'No');
        if (c === 'Yes') {
            await s.closeAssociatedDocument(true); // Attempt to close editor first
            if (sessionManager.removeSession(s.id)) {
                fileIntegratorProvider.refresh();
                vscode.window.showInformationMessage(`Session "${s.name}" removed.`);
            }
        }
    });

    // Rename Session (already persists via renameSession)
    register('fileintegrator.renameSession', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to rename');
        if (!s) return;
        const n = await vscode.window.showInputBox({ prompt: `Enter new name for "${s.name}"`, value: s.name });
        if (n && n.trim() && n.trim() !== s.name) {
            if (sessionManager.renameSession(s.id, n.trim())) {
                fileIntegratorProvider.refresh();
            }
        }
    });

    // Clear Session (needs explicit persist) - Now Async
    register('fileintegrator.clearSession', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to clear');
        if (!s || s.storage.files.length === 0) {
            vscode.window.showInformationMessage("Session is already empty.");
            return;
        }
        const c = await vscode.window.showWarningMessage(`Clear all items from session "${s.name}"?`, { modal: true }, 'Yes', 'No');
        if (c === 'Yes') {
            const count = s.storage.clearFiles();
            sessionManager.persistSessions(); // <-- PERSIST after clearing
            fileIntegratorProvider.refresh();
            await updateCodeBlockDocument(s); // Update associated doc
            vscode.window.showInformationMessage(`Cleared ${count} items from "${s.name}".`);
        }
    });

    // Generate Code Block - Now Async
    register('fileintegrator.generateCodeBlock', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to generate code block for');
        if (!s) return;
        // Check if there are any *files* specifically
        if (s.storage.files.filter(f => !f.isDirectory).length === 0) {
            vscode.window.showInformationMessage(`Session "${s.name}" contains no files to generate content from.`);
            return;
        }
        const doc = await showCodeBlockDocument(s); // Awaits async generation
        if (doc) {
            await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
        }
    });

    // Copy To Clipboard - Now Async
    register('fileintegrator.copyToClipboard', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to copy content from');
        if (!s) return;
        // Check if there are any *files* specifically
        if (s.storage.files.filter(f => !f.isDirectory).length === 0) {
            vscode.window.showInformationMessage(`Session "${s.name}" contains no file content to copy.`);
            return;
        }

        let contentToCopy: string;
        if (s.associatedDocument && !s.associatedDocument.isClosed) {
            contentToCopy = s.associatedDocument.getText(); // Use open doc if available
        } else {
            contentToCopy = await generateMarkdownContent(s); // Generate on the fly
        }

        if (contentToCopy && !contentToCopy.startsWith('<!-- No file content')) {
            await vscode.env.clipboard.writeText(contentToCopy);
            vscode.window.showInformationMessage(`Session "${s.name}" content copied to clipboard!`);
        } else {
            vscode.window.showWarningMessage("No content was generated or found to copy.");
        }
    });

    // Remove File/Directory (needs explicit persist) - Now Async
    register('fileintegrator.removeFile', async (item: FileSystemItem) => { // Make async
        if (!item || !(item instanceof FileSystemItem)) return;
        const s = sessionManager.getSession(item.sessionId);
        if (s) {
            if (s.storage.removeEntry(item.path)) {
                sessionManager.persistSessions(); // <-- PERSIST after removing
                fileIntegratorProvider.refresh();
                await updateCodeBlockDocument(s); // Update associated doc
            } else {
                // Maybe the item wasn't found, refresh anyway to be safe
                fileIntegratorProvider.refresh();
            }
        }
    });

    // Refresh View
    register('fileintegrator.refreshView', () => {
        fileIntegratorProvider.refresh();
        vscode.window.showInformationMessage("File Integrator view refreshed.");
    });
}

// --- Deactivation ---
export function deactivate() {
    console.log('Deactivating File Integrator...');
    // Session manager disposal (including potential final persist) happens via subscription context
}

// --- Helper Functions ---

/** Checks exclusion rules */
function isPathExcluded(filePath: string): boolean {
    const config = vscode.workspace.getConfiguration('fileintegrator');
    const excludePatterns = config.get<Record<string, boolean>>('exclude');
    if (!excludePatterns) return false;

    // Normalize path separators for consistent matching
    const normalizedFilePath = filePath.replace(/\\/g, '/');
    const workspaceFolders = vscode.workspace.workspaceFolders;

    for (const pattern in excludePatterns) {
        if (excludePatterns[pattern]) { // Only check patterns set to true
            // Normalize pattern separators
            const normalizedPattern = pattern.replace(/\\/g, '/');

            // 1. Direct match (absolute or relative from anywhere)
            if (minimatch(normalizedFilePath, normalizedPattern, { dot: true })) {
                // console.log(`[Exclude] Path '${normalizedFilePath}' matched pattern '${normalizedPattern}'`);
                return true;
            }

            // 2. Workspace relative match
            if (workspaceFolders) {
                for (const folder of workspaceFolders) {
                    const folderPath = folder.uri.fsPath.replace(/\\/g, '/');
                    // Check if the file path starts with the workspace folder path
                    if (normalizedFilePath.startsWith(folderPath + '/')) {
                        const relativePath = normalizedFilePath.substring(folderPath.length + 1);
                        if (minimatch(relativePath, normalizedPattern, { dot: true })) {
                            // console.log(`[Exclude] Relative path '${relativePath}' in workspace '${folder.name}' matched pattern '${normalizedPattern}'`);
                            return true;
                        }
                    }
                }
            }

            // 3. Basename match (useful for patterns like "*.log" or ".git")
             // Check if the pattern itself doesn't contain slashes, indicating it might be a basename pattern
             if (!normalizedPattern.includes('/')) {
                if (minimatch(path.basename(normalizedFilePath), normalizedPattern, { dot: true })) {
                   // console.log(`[Exclude] Basename '${path.basename(normalizedFilePath)}' matched pattern '${normalizedPattern}'`);
                   return true;
                }
             }
        }
    }
    return false;
 }

/** Converts URI string to normalized file system path. */
 function uriToPath(uriString: string): string {
    try {
        const uri = vscode.Uri.parse(uriString, true); // Strict parsing
        if (uri.scheme === 'file') {
            // For file URIs, fsPath is the most reliable way to get the OS-specific path
            return path.normalize(uri.fsPath);
        } else {
            // For other schemes, fallback to path (might not be a file system path)
            // Decode URI components, normalize separators
            return path.normalize(decodeURIComponent(uri.path));
        }
    } catch (e) {
        console.warn(`[uriToPath] Error parsing URI '${uriString}', falling back to string manipulation:`, e);
        // Fallback for potentially malformed URIs or non-standard formats
        let decodedPath = uriString;
        if (decodedPath.startsWith('file:///')) {
            decodedPath = decodedPath.substring(8); // Remove file:///
        } else if (decodedPath.startsWith('file://')) {
             decodedPath = decodedPath.substring(7); // Remove file://
         }

        try {
            decodedPath = decodeURIComponent(decodedPath);
        } catch (decodeError) {
            console.warn(`[uriToPath] Error decoding path component '${decodedPath}':`, decodeError);
            // Proceed with the potentially partially decoded path if decoding fails
        }

        // Handle Windows path peculiarity where paths might start with /C:/...
        if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(decodedPath)) {
            decodedPath = decodedPath.substring(1); // Remove leading slash
        }

        return path.normalize(decodedPath);
    }
 }

/** Prompts user to select a session via Quick Pick. */
 async function selectSession(placeHolder: string): Promise<Session | undefined> {
    const sessions = sessionManager.getAllSessions(); // Already sorted by name
    if (sessions.length === 0) {
        vscode.window.showErrorMessage("No sessions available. Create one first.");
        return undefined;
    }
    if (sessions.length === 1) {
        // If only one session exists, don't prompt, just return it
        return sessions[0];
    }

    const picks = sessions.map(s => ({
        label: s.name,
        description: `(${s.storage.files.length} items)`,
        session: s // Attach the session object to the pick item
    }));

    const selection = await vscode.window.showQuickPick(picks, {
        placeHolder: placeHolder,
        canPickMany: false
    });

    return selection?.session; // Return the session object from the selected pick
 }

/**
 * Generates aggregated Markdown content for a session, respecting array order.
 * Reads file content asynchronously if it hasn't been loaded yet (e.g., after restart).
 */
 async function generateMarkdownContent(session: Session): Promise<string> {
    let content = '';
    // Iterate directly over the ordered files array, filtering for files only
    const fileEntries = session.storage.files.filter(f => !f.isDirectory);

    if (fileEntries.length === 0) {
        return `<!-- No file content in session "${session.name}" -->\n`;
    }

    console.log(`[MarkdownGen] Generating content for ${fileEntries.length} files in session ${session.id}`);

    for (const file of fileEntries) {
        let fileContent: string | null = file.content; // Use cached content if available

        // If content is null (wasn't read on add or loaded from persistence), read it now.
        if (fileContent === null) {
            try {
                console.log(`[MarkdownGen] Reading content for ${file.path}...`);
                fileContent = await fs.readFile(file.path, 'utf8');
                // OPTIONAL: Cache the read content back?
                // Be cautious: If the file changes on disk after this read but before the next 'generate',
                // the cached content would be stale. For now, reading each time if null is safer.
                // file.content = fileContent; // <-- Uncomment with caution
            } catch (error: any) {
                console.error(`[MarkdownGen] Error reading file ${file.path}:`, error);
                vscode.window.showWarningMessage(`Could not read content for: ${path.basename(file.path)}`);
                fileContent = `--- Error reading file content: ${error.message} ---`;
            }
        }

        const displayPath = getDisplayPath(file.path);
        // Use ```<lang> format if possible, otherwise default ```
        const lang = path.extname(file.path).substring(1);
        content += `${displayPath}\n\`\`\`${lang}\n`; // File path header + code block start
        content += fileContent; // Add the content (either cached or freshly read)
        content += `\n\`\`\`\n\n`; // End code block and add spacing
    }

    return content.trimEnd();
}


/** Shows/Updates the code block document for a session. Now Async. */
async function showCodeBlockDocument(session: Session): Promise<vscode.TextDocument | undefined> {
    // Generate content asynchronously FIRST
    const content = await generateMarkdownContent(session); // <-- Await the async generation

    // Now handle the document logic
    if (session.associatedDocument && !session.associatedDocument.isClosed) {
        const doc = session.associatedDocument;
        try {
            // Use WorkspaceEdit for efficient replacement
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), content);
            const success = await vscode.workspace.applyEdit(edit);
            if (!success) throw new Error("ApplyEdit failed");
            console.log(`[ShowDoc] Updated existing associated document for session ${session.id}`);
            return doc;
        } catch (e) {
            console.error(`[ShowDoc] Error updating associated doc ${doc.uri}:`, e);
            vscode.window.showErrorMessage("Failed to update associated document.");
            // Consider detaching if update fails persistently? For now, just report error.
            // session.closeAssociatedDocument(false);
            return undefined; // Indicate failure
        }
    }
    // Create new document if needed
    try {
        console.log(`[ShowDoc] Creating new associated document for session ${session.id}`);
        const doc = await vscode.workspace.openTextDocument({ content: content, language: 'markdown' });
        session.setAssociatedDocument(doc); // Associate the new document
        return doc;
    } catch (e: any) {
        console.error(`[ShowDoc] Failed to create associated document:`, e);
        vscode.window.showErrorMessage(`Failed to create associated document: ${e.message}`);
        return undefined;
    }
}

/** Updates associated document IF it exists and is open. Now Async. */
async function updateCodeBlockDocument(session: Session): Promise<void> {
    if (session.associatedDocument && !session.associatedDocument.isClosed) {
        const doc = session.associatedDocument;
        console.log(`[UpdateDoc] Updating associated document for session ${session.id}`);
        // Generate content asynchronously
        const content = await generateMarkdownContent(session); // <-- Await the async generation
        try {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), content);
            const success = await vscode.workspace.applyEdit(edit);
            if (!success) {
                console.warn(`[UpdateDoc] ApplyEdit failed for ${doc.uri}. Detaching association.`);
                session.closeAssociatedDocument(false); // Detach if edit fails
            } else {
                 console.log(`[UpdateDoc] Successfully updated associated document.`);
             }
        } catch (err) {
            console.error(`[UpdateDoc] Error applying edit to ${doc.uri}:`, err);
            vscode.window.showErrorMessage("Error updating associated code block document.");
            // Consider detaching on error as well
            // session.closeAssociatedDocument(false);
        }
    } else {
         console.log(`[UpdateDoc] No open associated document to update for session ${session.id}`);
     }
    // Cleanup association if doc was closed independently (handled by onDidCloseTextDocument listener setup in setAssociatedDocument)
}

/** Generates display-friendly path, preferably relative to workspace. */
function getDisplayPath(filePath: string, short: boolean = false): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    let relativePath: string | undefined;

    if (workspaceFolders) {
        // Sort folders by length descending to prioritize deeper matches
        const sortedFolders = [...workspaceFolders].sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length);

        for (const folder of sortedFolders) {
            const folderPath = folder.uri.fsPath;
            // Ensure the file path is truly within the folder path + separator
            if (filePath.startsWith(folderPath + path.sep)) {
                relativePath = path.relative(folderPath, filePath);
                break; // Found the best match
            }
             // Handle case where file path might exactly match the folder path (less common)
             if (filePath === folderPath) {
                 relativePath = path.basename(filePath); // Show just the folder name
                 break;
             }
        }
    }

    // Return the relative path if found, otherwise generate a shortened absolute path
    if (relativePath) {
        return relativePath.replace(/\\/g, '/'); // Use forward slashes for display
    } else {
        // Fallback for paths outside workspace or if no workspace is open
        const pathParts = filePath.split(/[\\/]/);
        const partsCount = pathParts.length;
        if (!short && partsCount > 2) {
            // Show ".../parent/basename"
            return '...' + path.sep + pathParts.slice(-2).join(path.sep);
        } else if (partsCount > 1) {
             // Show "parent/basename" or just "basename" if only one level deep from root
             return pathParts.slice(partsCount > 1 ? -2 : -1).join(path.sep);
         } else {
            // Only one part (e.g., "C:", "/file.txt")
            return pathParts[0] ?? filePath; // Use original if split fails
        }
    }
 }