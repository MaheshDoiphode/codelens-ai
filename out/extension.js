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
const path = __importStar(require("path"));
// Use fs-extra for easier async operations and promises by default
const fs = __importStar(require("fs-extra"));
const uuid_1 = require("uuid"); // For unique session IDs
const minimatch_1 = require("minimatch"); // For exclusions
/**
 * Manages file storage for a single session using an Array to preserve order.
 */
class SessionFileStorage {
    // ** Use an Array to maintain order **
    _files = [];
    sessionId;
    constructor(sessionId) {
        this.sessionId = sessionId;
    }
    get files() {
        // Return a copy to prevent external modification? Or trust internal use?
        // For now, return direct reference for simplicity.
        return this._files;
    }
    get filesOnly() {
        return this._files.filter(f => !f.isDirectory).map(f => ({ path: f.path, content: f.content }));
    }
    // Find an entry by its normalized path
    findEntry(filePath) {
        const normalizedPath = path.normalize(filePath);
        return this._files.find(f => f.path === normalizedPath);
    }
    // Add a single file asynchronously (if not excluded and not duplicate)
    async addFile(filePath, parentPath) {
        const normalizedPath = path.normalize(filePath);
        const normalizedParentPath = parentPath ? path.normalize(parentPath) : undefined;
        // Check for duplicates
        if (this._files.some(f => f.path === normalizedPath)) {
            // console.log(`[Storage] File already exists: ${normalizedPath}`);
            return false;
        }
        let content = null;
        try {
            content = await fs.readFile(normalizedPath, 'utf8');
        }
        catch (error) {
            vscode.window.showErrorMessage(`Read file error: ${error.message}`);
            console.error(`Read file error ${normalizedPath}:`, error);
        }
        const fileEntry = {
            path: normalizedPath,
            content: content,
            isDirectory: false,
            parent: normalizedParentPath,
            sessionId: this.sessionId,
        };
        this._files.push(fileEntry); // Add to end of array
        return true;
    }
    // Add a directory and its contents recursively (if not excluded)
    async addDirectory(dirPath, parentPath) {
        const normalizedPath = path.normalize(dirPath);
        const normalizedParentPath = parentPath ? path.normalize(parentPath) : undefined;
        // Check for duplicates (only need to check for the directory itself)
        if (this._files.some(f => f.path === normalizedPath && f.isDirectory)) {
            // console.log(`[Storage] Directory already exists: ${normalizedPath}`);
            return false;
        }
        // Add the directory entry itself
        const dirEntry = {
            path: normalizedPath,
            content: null,
            isDirectory: true,
            parent: normalizedParentPath,
            sessionId: this.sessionId,
        };
        this._files.push(dirEntry);
        // Read and process contents
        try {
            const entries = await fs.readdir(normalizedPath, { withFileTypes: true });
            const processingPromises = [];
            for (const entry of entries) {
                const fullPath = path.join(normalizedPath, entry.name);
                // ** Check exclusion for children BEFORE recursive call **
                if (!isPathExcluded(fullPath)) {
                    if (entry.isDirectory()) {
                        processingPromises.push(this.addDirectory(fullPath, normalizedPath));
                    }
                    else if (entry.isFile()) {
                        processingPromises.push(this.addFile(fullPath, normalizedPath));
                    }
                }
                else {
                    console.log(`[Exclude][AddDir] Skipping excluded child: ${fullPath}`);
                }
            }
            await Promise.all(processingPromises);
        }
        catch (error) {
            vscode.window.showErrorMessage(`Read dir error: ${error.message}`);
            console.error(`Read dir error ${normalizedPath}:`, error);
            // Directory entry was added, but contents might be incomplete
            return false;
        }
        return true;
    }
    /** Remove entry and its descendants using Array filtering/splicing */
    removeEntry(entryPath) {
        const normalizedPath = path.normalize(entryPath);
        const initialLength = this._files.length;
        // Find the index of the main entry
        const mainIndex = this._files.findIndex(f => f.path === normalizedPath);
        if (mainIndex === -1)
            return false; // Not found
        const entryToRemove = this._files[mainIndex];
        const isDirectory = entryToRemove.isDirectory;
        // Filter out the main entry and all descendants if it's a directory
        const prefix = isDirectory ? normalizedPath + path.sep : null;
        this._files = this._files.filter(f => {
            if (f.path === normalizedPath)
                return false; // Remove main entry
            if (prefix && f.path.startsWith(prefix))
                return false; // Remove descendants
            return true; // Keep others
        });
        return this._files.length < initialLength; // Return true if any items were removed
    }
    /** Clear all files */
    clearFiles() {
        const count = this._files.length;
        this._files = [];
        return count;
    }
    /**
     * Reorders items within the storage array. Assumes items share the same parent.
     * @param draggedPaths Normalized paths of items being dragged.
     * @param targetPath Normalized path of the item being dropped onto (optional).
     * @param dropOnSession If true, indicates drop was on session node (append to root).
     * @returns True if reordering was successful, false otherwise.
     */
    reorderItems(draggedPaths, targetPath, dropOnSession = false) {
        console.log(`[Storage:reorder] Dragged: ${draggedPaths.join(', ')}, Target: ${targetPath}, OnSession: ${dropOnSession}`);
        // 1. Get the actual FileEntry objects being dragged
        const draggedEntries = [];
        for (const draggedPath of draggedPaths) {
            const entry = this.findEntry(draggedPath);
            if (entry) {
                draggedEntries.push(entry);
            }
            else {
                console.error(`[Storage:reorder] Could not find dragged entry: ${draggedPath}`);
                return false; // Cannot proceed if a dragged item doesn't exist
            }
        }
        if (draggedEntries.length === 0)
            return false; // Nothing to reorder
        // 2. Basic Validation: Ensure all dragged items share the same parent
        const firstParent = draggedEntries[0].parent;
        if (!draggedEntries.every(e => e.parent === firstParent)) {
            console.warn('[Storage:reorder] Dragged items have different parents. Reordering aborted.');
            vscode.window.showWarningMessage("Cannot move items between different folders yet.");
            return false;
        }
        // 3. Remove dragged items from their original positions
        const originalIndices = draggedEntries.map(entry => this._files.findIndex(f => f.path === entry.path)).sort((a, b) => b - a); // Sort descending to splice correctly
        originalIndices.forEach(index => {
            if (index > -1)
                this._files.splice(index, 1);
        });
        // 4. Determine the insertion index
        let targetIndex = -1;
        if (dropOnSession) {
            // Find index of the first root item (parent undefined) to insert before, or end if none
            targetIndex = this._files.findIndex(f => f.parent === undefined);
            if (targetIndex === -1)
                targetIndex = this._files.length; // Append if no root items exist
            console.log(`[Storage:reorder] Dropped on session, target index: ${targetIndex}`);
        }
        else if (targetPath) {
            targetIndex = this._files.findIndex(f => f.path === targetPath);
            if (targetIndex === -1) {
                console.error(`[Storage:reorder] Target path not found after removing dragged items: ${targetPath}`);
                // Put items back at the end? Or fail? Let's fail for now.
                // Re-add dragged items at the end as a fallback (might be wrong order)
                this._files.push(...draggedEntries);
                return false;
            }
            console.log(`[Storage:reorder] Dropped on item ${targetPath}, target index: ${targetIndex}`);
            // We typically insert *before* the target item
        }
        else {
            // Dropped on empty space within a parent group (e.g., end of root or end of a folder's children)
            // Append to the end of items with the same parent as the dragged items
            const parent = firstParent; // Parent of dragged items
            let lastIndexOfParentGroup = -1;
            for (let i = this._files.length - 1; i >= 0; i--) {
                if (this._files[i].parent === parent) {
                    lastIndexOfParentGroup = i;
                    break;
                }
            }
            targetIndex = lastIndexOfParentGroup + 1;
            console.log(`[Storage:reorder] Dropped on empty space within parent '${parent}', target index: ${targetIndex}`);
        }
        // 5. Insert the dragged items at the target index
        this._files.splice(targetIndex, 0, ...draggedEntries);
        console.log(`[Storage:reorder] Reordering successful. New count: ${this._files.length}`);
        return true;
    }
}
// --- Session Class (No changes needed) ---
class Session {
    id;
    name;
    storage;
    associatedDocument = null;
    docCloseListener = null;
    constructor(name, id = (0, uuid_1.v4)()) { this.id = id; this.name = name; this.storage = new SessionFileStorage(this.id); }
    dispose() { this.closeAssociatedDocument(false); this.docCloseListener?.dispose(); this.docCloseListener = null; this.storage.clearFiles(); }
    setAssociatedDocument(doc) { this.docCloseListener?.dispose(); this.associatedDocument = doc; this.docCloseListener = vscode.workspace.onDidCloseTextDocument(d => { if (d === this.associatedDocument) {
        this.associatedDocument = null;
        this.docCloseListener?.dispose();
        this.docCloseListener = null;
    } }); }
    async closeAssociatedDocument(attemptEditorClose = true) { const d = this.associatedDocument; this.associatedDocument = null; this.docCloseListener?.dispose(); this.docCloseListener = null; if (attemptEditorClose && d) {
        for (const e of vscode.window.visibleTextEditors) {
            if (e.document === d) {
                try {
                    await vscode.window.showTextDocument(d, { viewColumn: e.viewColumn, preserveFocus: false });
                    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                    break;
                }
                catch (err) {
                    console.error(`Error closing editor:`, err);
                }
            }
        }
    } }
}
// --- Session Manager Class (No changes needed) ---
class SessionManager {
    context;
    sessions = new Map();
    static STORAGE_KEY = 'fileIntegratorSessions';
    constructor(context) {
        this.context = context;
    }
    createSession(name) { const n = name || `Session ${this.sessions.size + 1}`; const s = new Session(n); this.sessions.set(s.id, s); this.persistSessions(); return s; }
    getSession(id) { return this.sessions.get(id); }
    getAllSessions() { return Array.from(this.sessions.values()).sort((a, b) => a.name.localeCompare(b.name)); }
    removeSession(id) { const s = this.sessions.get(id); if (s) {
        s.dispose();
        const d = this.sessions.delete(id);
        if (d)
            this.persistSessions();
        return d;
    } return false; }
    renameSession(id, newName) { const s = this.sessions.get(id); if (s) {
        s.name = newName;
        this.persistSessions();
        return true;
    } return false; }
    persistSessions() { try {
        const m = this.getAllSessions().map(s => ({ id: s.id, name: s.name }));
        this.context.workspaceState.update(SessionManager.STORAGE_KEY, m);
    }
    catch (e) {
        console.error("Persist error:", e);
    } }
    loadSessions() { try {
        const m = this.context.workspaceState.get(SessionManager.STORAGE_KEY, []);
        this.sessions.clear();
        m.forEach(meta => { this.sessions.set(meta.id, new Session(meta.name, meta.id)); });
    }
    catch (e) {
        console.error("Load error:", e);
        this.sessions.clear();
    } if (this.sessions.size === 0)
        this.createSession("Default Session"); }
    dispose() { this.getAllSessions().forEach(s => s.dispose()); this.sessions.clear(); }
}
class SessionItem extends vscode.TreeItem {
    session;
    constructor(session, collapsibleState = vscode.TreeItemCollapsibleState.Collapsed) {
        super(session.name, collapsibleState);
        this.session = session;
        this.id = session.id;
        this.contextValue = 'session';
        this.iconPath = new vscode.ThemeIcon('folder-library');
        this.tooltip = `Session: ${session.name}`;
        this.description = `(${session.storage.files.length} items)`;
    }
}
class FileSystemItem extends vscode.TreeItem {
    entry;
    constructor(entry, collapsibleState) {
        const b = path.basename(entry.path);
        super(b, collapsibleState);
        this.entry = entry;
        this.id = `${entry.sessionId}::${entry.path}`;
        this.resourceUri = vscode.Uri.file(entry.path);
        this.tooltip = `${entry.isDirectory ? 'Directory' : 'File'}:\n${entry.path}`;
        this.description = getDisplayPath(entry.path, true);
        this.contextValue = entry.isDirectory ? 'directory' : 'file';
        this.iconPath = entry.isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    }
    get sessionId() { return this.entry.sessionId; }
    get path() { return this.entry.path; }
    get isDirectory() { return this.entry.isDirectory; }
}
// --- Tree Data Provider ---
class FileIntegratorProvider {
    sessionManager;
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    // ** Declare supported MIME types for drag OUT and drop IN **
    dropMimeTypes = ['text/uri-list', 'application/vnd.code.tree.fileIntegratorView'];
    dragMimeTypes = ['application/vnd.code.tree.fileIntegratorView'];
    // Define our custom MIME type
    customMimeType = 'application/vnd.code.tree.fileIntegratorView';
    constructor(sessionManager) {
        this.sessionManager = sessionManager;
    }
    getTreeItem(element) { return element; }
    // ** getChildren now reads from the ordered array **
    getChildren(element) {
        // Sort function remains the same for display within a level if needed, but primary order comes from array
        const sortEntries = (a, b) => (a.isDirectory === b.isDirectory) ? path.basename(a.path).localeCompare(path.basename(b.path)) : (a.isDirectory ? -1 : 1);
        if (!element) { // Root level: Sessions
            return Promise.resolve(this.sessionManager.getAllSessions().map(s => new SessionItem(s, s.storage.files.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)));
        }
        if (element instanceof SessionItem) { // Children of a Session (Root files/dirs)
            const session = this.sessionManager.getSession(element.session.id);
            if (!session)
                return [];
            // Filter the session's ordered array for root items
            const rootEntries = session.storage.files.filter(f => !f.parent);
            // No need to sort here, array order is the source of truth
            return Promise.resolve(rootEntries.map(e => new FileSystemItem(e, e.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)));
        }
        if (element instanceof FileSystemItem && element.isDirectory) { // Children of a Directory
            const session = this.sessionManager.getSession(element.sessionId);
            if (!session)
                return [];
            // Filter the session's ordered array for children of this directory
            const childEntries = session.storage.files.filter(f => f.parent === element.path);
            // No need to sort here
            return Promise.resolve(childEntries.map(e => new FileSystemItem(e, e.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)));
        }
        return Promise.resolve([]);
    }
    refresh(element) { this._onDidChangeTreeData.fire(element); }
    // --- Drag and Drop Controller Implementation ---
    /**
     * Called when dragging items *from* this tree view.
     */
    handleDrag(source, dataTransfer, token) {
        console.log(`[handleDrag] Starting drag for ${source.length} items.`);
        // Only allow dragging FileSystemItems (not SessionItems)
        const draggableItems = source.filter((item) => item instanceof FileSystemItem);
        if (draggableItems.length > 0) {
            // Store identifiers of the dragged items
            const draggedIds = draggableItems.map(item => item.id); // Use the unique TreeItem ID (sessionId::path)
            console.log(`[handleDrag] Dragging IDs: ${draggedIds.join(', ')}`);
            dataTransfer.set(this.customMimeType, new vscode.DataTransferItem(draggedIds));
        }
        else {
            console.log(`[handleDrag] No draggable items selected (only sessions?).`);
        }
    }
    /**
     * Called when dropping items *onto* this tree view.
     * Handles both external file drops and internal reordering drops.
     */
    async handleDrop(target, dataTransfer, token) {
        console.log(`[handleDrop] Drop detected. Target: ${target?.id ?? 'view root'}`);
        const internalDropItem = dataTransfer.get(this.customMimeType);
        const externalDropItem = dataTransfer.get('text/uri-list');
        if (token.isCancellationRequested)
            return;
        // --- Handle INTERNAL Reorder Drop ---
        if (internalDropItem) {
            console.log('[handleDrop] Handling internal drop (reorder).');
            const draggedItemIds = internalDropItem.value; // We stored array of strings (TreeItem IDs)
            if (!Array.isArray(draggedItemIds) || draggedItemIds.length === 0) {
                console.warn('[handleDrop] Internal drop data is invalid.');
                return;
            }
            // Extract paths and session ID from the first dragged item ID
            const firstDraggedIdParts = draggedItemIds[0].split('::');
            if (firstDraggedIdParts.length !== 2) {
                console.warn('[handleDrop] Invalid dragged item ID format.');
                return;
            }
            const sessionId = firstDraggedIdParts[0];
            const draggedPaths = draggedItemIds.map(id => id.split('::')[1]).filter(Boolean); // Get just the path part
            const session = this.sessionManager.getSession(sessionId);
            if (!session) {
                console.error(`[handleDrop] Session not found for internal drop: ${sessionId}`);
                return;
            }
            // Determine target path and drop position
            let targetPath;
            let dropOnSessionNode = false;
            if (target instanceof SessionItem) {
                // Dropped directly onto a session node -> move to root, likely append
                if (target.session.id !== sessionId) {
                    vscode.window.showErrorMessage("Cannot move items between sessions yet.");
                    return;
                }
                dropOnSessionNode = true;
            }
            else if (target instanceof FileSystemItem) {
                // Dropped onto a file/directory item
                if (target.sessionId !== sessionId) {
                    vscode.window.showErrorMessage("Cannot move items between sessions yet.");
                    return;
                }
                targetPath = target.path;
            }
            else {
                // Dropped onto empty space (could be root or inside an expanded folder)
                // We'll handle this within storage.reorderItems by appending to the relevant parent group
                console.log('[handleDrop] Dropped on empty space.');
            }
            // Perform the reorder operation in storage
            const success = session.storage.reorderItems(draggedPaths, targetPath, dropOnSessionNode);
            if (success) {
                this.refresh(); // Refresh the entire view after reorder
                // Optionally update the associated doc if open? Reordering might change content order.
                await updateCodeBlockDocument(session);
            }
        }
        // --- Handle EXTERNAL File/Folder Drop ---
        else if (externalDropItem) {
            console.log('[handleDrop] Handling external drop (uri-list).');
            // Determine target session (same logic as before)
            let targetSession;
            if (target instanceof SessionItem)
                targetSession = target.session;
            else if (target instanceof FileSystemItem)
                targetSession = this.sessionManager.getSession(target.sessionId);
            else {
                const s = this.sessionManager.getAllSessions();
                targetSession = s.length > 0 ? s[0] : undefined;
                if (targetSession && s.length > 1)
                    vscode.window.showInformationMessage(`Added files to session: "${targetSession.name}" (Dropped on view background)`);
                else if (!targetSession) {
                    vscode.window.showErrorMessage("Cannot add files: No sessions exist.");
                    return;
                }
            }
            if (!targetSession) {
                vscode.window.showErrorMessage("Could not determine target session.");
                return;
            }
            const uriList = await externalDropItem.asString();
            const uris = uriList.split('\n').map(u => u.trim()).filter(Boolean);
            if (uris.length === 0)
                return;
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Adding files to session "${targetSession.name}"...`, cancellable: true }, async (progress, progressToken) => {
                progressToken.onCancellationRequested(() => { console.log("User cancelled file adding."); });
                let skippedCount = 0;
                for (let i = 0; i < uris.length; i++) {
                    if (progressToken.isCancellationRequested)
                        break;
                    const uri = uris[i];
                    let filePath = '';
                    try {
                        filePath = uriToPath(uri);
                        progress.report({ message: `(${i + 1}/${uris.length}) ${path.basename(filePath)}`, increment: 100 / uris.length });
                        const processed = await this.processPath(filePath, targetSession, progressToken); // processPath checks exclusions
                        if (!processed) {
                            skippedCount++;
                        }
                    }
                    catch (err) {
                        vscode.window.showErrorMessage(`Error processing ${filePath || uri}: ${err.message}`);
                        console.error(`Error processing URI ${uri}:`, err);
                    }
                }
                if (skippedCount > 0)
                    vscode.window.showInformationMessage(`${skippedCount} item(s) were skipped due to exclusion settings.`);
            });
            this.refresh(); // Refresh view only
        }
        else {
            console.log('[handleDrop] No supported data transfer item found.');
        }
    }
    /** Process external path, checking exclusions */
    async processPath(filePath, session, token) {
        if (token.isCancellationRequested)
            return false;
        if (isPathExcluded(filePath)) {
            console.log(`[Exclude] Skipping excluded path: ${filePath}`);
            return false;
        }
        try {
            const exists = await fs.pathExists(filePath);
            if (!exists)
                return true;
            if (token.isCancellationRequested)
                return false;
            const stats = await fs.stat(filePath);
            if (token.isCancellationRequested)
                return false;
            if (stats.isDirectory())
                await session.storage.addDirectory(filePath);
            else if (stats.isFile())
                await session.storage.addFile(filePath);
            return true;
        }
        catch (err) {
            vscode.window.showErrorMessage(`Error processing path ${path.basename(filePath)}: ${err.message}`);
            console.error(`Error processing path ${filePath}:`, err);
            return true;
        }
    }
}
// --- Global Variables & Activation ---
let sessionManager;
let fileIntegratorProvider;
let treeView;
function activate(context) { sessionManager = new SessionManager(context); sessionManager.loadSessions(); fileIntegratorProvider = new FileIntegratorProvider(sessionManager); treeView = vscode.window.createTreeView('fileIntegratorView', { treeDataProvider: fileIntegratorProvider, dragAndDropController: fileIntegratorProvider, showCollapseAll: true, canSelectMany: true }); context.subscriptions.push(treeView); registerCommands(context); context.subscriptions.push({ dispose: () => sessionManager.dispose() }); console.log('File Integrator activated.'); }
// --- Command Registration (No changes needed) ---
function registerCommands(context) {
    const register = (commandId, callback) => { context.subscriptions.push(vscode.commands.registerCommand(commandId, callback)); };
    register('fileintegrator.addSession', async () => { const n = await vscode.window.showInputBox({ prompt: "Session name", value: `Session ${sessionManager.getAllSessions().length + 1}` }); if (n && n.trim()) {
        const s = sessionManager.createSession(n.trim());
        fileIntegratorProvider.refresh();
        treeView.reveal(new SessionItem(s), { select: true, focus: true, expand: true });
    } });
    register('fileintegrator.removeSession', async (item) => { const s = item?.session ?? await selectSession('Select session to remove'); if (!s)
        return; const c = await vscode.window.showWarningMessage(`Remove session "${s.name}"?`, { modal: true }, 'Yes'); if (c === 'Yes') {
        await s.closeAssociatedDocument(true);
        if (sessionManager.removeSession(s.id))
            fileIntegratorProvider.refresh();
    } });
    register('fileintegrator.renameSession', async (item) => { const s = item?.session ?? await selectSession('Select session to rename'); if (!s)
        return; const n = await vscode.window.showInputBox({ prompt: `New name for "${s.name}"`, value: s.name }); if (n && n.trim() && sessionManager.renameSession(s.id, n.trim()))
        fileIntegratorProvider.refresh(); });
    register('fileintegrator.clearSession', async (item) => { const s = item?.session ?? await selectSession('Select session to clear'); if (!s || s.storage.files.length === 0)
        return; const c = await vscode.window.showWarningMessage(`Clear all files from "${s.name}"?`, { modal: true }, 'Yes'); if (c === 'Yes') {
        s.storage.clearFiles();
        fileIntegratorProvider.refresh();
        await updateCodeBlockDocument(s);
    } });
    register('fileintegrator.generateCodeBlock', async (item) => { const s = item?.session ?? await selectSession('Select session to generate'); if (!s)
        return; if (s.storage.filesOnly.length === 0) {
        vscode.window.showInformationMessage("No file content.");
        return;
    } const doc = await showCodeBlockDocument(s); if (doc)
        await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false }); });
    register('fileintegrator.copyToClipboard', async (item) => { const s = item?.session ?? await selectSession('Select session to copy'); if (!s)
        return; if (s.storage.filesOnly.length === 0) {
        vscode.window.showInformationMessage("No file content.");
        return;
    } let c = (s.associatedDocument && !s.associatedDocument.isClosed) ? s.associatedDocument.getText() : generateMarkdownContent(s); if (c) {
        await vscode.env.clipboard.writeText(c);
        vscode.window.showInformationMessage(`Session "${s.name}" copied!`);
    }
    else {
        vscode.window.showWarningMessage("No content generated.");
    } });
    register('fileintegrator.removeFile', (item) => { if (!item || !(item instanceof FileSystemItem))
        return; const s = sessionManager.getSession(item.sessionId); if (s) {
        if (s.storage.removeEntry(item.path)) {
            fileIntegratorProvider.refresh();
            updateCodeBlockDocument(s);
        }
        else {
            fileIntegratorProvider.refresh();
        }
    } });
    register('fileintegrator.refreshView', () => { fileIntegratorProvider.refresh(); vscode.window.showInformationMessage("View refreshed."); });
}
// --- Deactivation ---
function deactivate() { console.log('Deactivating File Integrator...'); }
// --- Helper Functions ---
/** Checks exclusion rules */
function isPathExcluded(filePath) {
    const config = vscode.workspace.getConfiguration('fileintegrator');
    const excludePatterns = config.get('exclude');
    if (!excludePatterns)
        return false;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const normalizedFilePath = filePath.replace(/\\/g, '/');
    for (const pattern in excludePatterns) {
        if (excludePatterns[pattern]) {
            const normalizedPattern = pattern.replace(/\\/g, '/');
            if ((0, minimatch_1.minimatch)(normalizedFilePath, normalizedPattern, { dot: true }))
                return true;
            if (workspaceFolders) {
                for (const folder of workspaceFolders) {
                    const folderPath = folder.uri.fsPath.replace(/\\/g, '/');
                    if (normalizedFilePath.startsWith(folderPath + '/')) {
                        const relativePath = normalizedFilePath.substring(folderPath.length + 1);
                        if ((0, minimatch_1.minimatch)(relativePath, normalizedPattern, { dot: true }))
                            return true;
                    }
                }
            }
            if ((0, minimatch_1.minimatch)(path.basename(normalizedFilePath), normalizedPattern, { dot: true, matchBase: true }))
                return true;
        }
    }
    return false;
}
/** Converts URI string to normalized file system path. */
function uriToPath(uriString) {
    try {
        const u = vscode.Uri.parse(uriString, true);
        if (u.scheme === 'file')
            return u.fsPath;
        return path.normalize(decodeURIComponent(u.path));
    }
    catch (e) {
        let p = uriString.replace(/^file:\/\//i, '');
        try {
            p = decodeURIComponent(p);
        }
        catch { /* Ignore */ }
        if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p))
            p = p.substring(1);
        return path.normalize(p);
    }
}
/** Prompts user to select a session via Quick Pick. */
async function selectSession(placeHolder) {
    const s = sessionManager.getAllSessions();
    if (s.length === 0) {
        vscode.window.showErrorMessage("No sessions.");
        return;
    }
    if (s.length === 1)
        return s[0];
    const p = s.map(x => ({ label: x.name, description: `(${x.storage.files.length} items)`, session: x }));
    const sel = await vscode.window.showQuickPick(p, { placeHolder, canPickMany: false });
    return sel?.session;
}
/**
 * Generates aggregated Markdown content for a session, **respecting array order**.
 */
function generateMarkdownContent(session) {
    let content = '';
    // ** Iterate directly over the ordered _files array **
    const fileEntries = session.storage.files.filter(f => !f.isDirectory); // Get only files
    if (fileEntries.length === 0) {
        return `<!-- No file content in session "${session.name}" -->\n`;
    }
    // No need to sort here, the array order is the desired order
    fileEntries.forEach(file => {
        const displayPath = getDisplayPath(file.path);
        content += `${displayPath}\n\`\`\`\n`; // File path header
        content += file.content ?? `--- Error reading file content ---`;
        content += `\n\`\`\`\n\n`; // End code block and add spacing
    });
    return content.trimEnd(); // Remove any final trailing newline/space
}
/** Shows/Updates the code block document for a session. */
async function showCodeBlockDocument(session) {
    const content = generateMarkdownContent(session);
    if (session.associatedDocument && !session.associatedDocument.isClosed) {
        const doc = session.associatedDocument;
        try {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), content);
            if (!await vscode.workspace.applyEdit(edit))
                throw new Error("ApplyEdit failed");
            return doc;
        }
        catch (e) {
            console.error(`Error updating doc ${doc.uri}:`, e);
            vscode.window.showErrorMessage("Failed to update doc.");
            session.closeAssociatedDocument(false);
            return;
        }
    }
    try {
        const doc = await vscode.workspace.openTextDocument({ content: content, language: 'markdown' });
        session.setAssociatedDocument(doc);
        return doc;
    }
    catch (e) {
        console.error(`Failed to create doc:`, e);
        vscode.window.showErrorMessage(`Failed to create doc: ${e.message}`);
        return;
    }
}
/** Updates associated document IF it exists and is open. */
async function updateCodeBlockDocument(session) {
    if (session.associatedDocument && !session.associatedDocument.isClosed) {
        const d = session.associatedDocument;
        const c = generateMarkdownContent(session);
        try {
            const e = new vscode.WorkspaceEdit();
            e.replace(d.uri, new vscode.Range(0, 0, d.lineCount, 0), c);
            if (!await vscode.workspace.applyEdit(e)) {
                console.warn(`ApplyEdit failed for ${d.uri}. Detaching.`);
                session.closeAssociatedDocument(false);
            }
        }
        catch (err) {
            console.error(`Error applying edit to ${d.uri}:`, err);
            vscode.window.showErrorMessage("Error updating code block.");
            session.closeAssociatedDocument(false);
        }
    }
    if (session.associatedDocument && session.associatedDocument.isClosed) {
        session.associatedDocument = null;
    }
}
/** Generates display-friendly path, preferably relative. */
function getDisplayPath(filePath, short = false) {
    const wf = vscode.workspace.workspaceFolders;
    let rp;
    if (wf) {
        const sf = [...wf].sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length);
        for (const f of sf) {
            const fp = f.uri.fsPath;
            if (filePath.startsWith(fp + path.sep)) {
                rp = path.relative(fp, filePath);
                break;
            }
        }
    }
    if (rp)
        return rp.replace(/\\/g, '/');
    const p = filePath.split(/[\\/]/);
    const pc = p.length;
    if (!short && pc > 2)
        return '...' + path.sep + p.slice(-2).join(path.sep);
    else if (pc > 1)
        return p.slice(-2).join(path.sep);
    else
        return p[0] ?? filePath;
}
//# sourceMappingURL=extension.js.map