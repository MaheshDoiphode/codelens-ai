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
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs-extra")); // Still needed for external drop checks/reads
const uuid_1 = require("uuid");
const minimatch_1 = require("minimatch");
/**
 * Manages resource storage for a single session using an Array to preserve order.
 * Uses URI strings as primary identifiers.
 */
class SessionResourceStorage {
    _files = [];
    sessionId;
    constructor(sessionId) {
        this.sessionId = sessionId;
    }
    get files() {
        return this._files;
    }
    // Filter for non-directories (files or other single resources)
    get resourcesOnly() {
        return this._files.filter(f => !f.isDirectory).map(f => ({ uriString: f.uriString, content: f.content }));
    }
    findEntry(uriString) {
        return this._files.find(f => f.uriString === uriString);
    }
    /** Adds a pre-constructed FileEntry. Returns true if added, false if duplicate. */
    addItem(entry) {
        if (this._files.some(f => f.uriString === entry.uriString)) {
            console.log(`[Storage] Item already exists: ${entry.uriString}`);
            return false;
        }
        this._files.push(entry);
        return true;
    }
    /**
     * Adds a resource (file or directory) from a URI.
     * Handles reading initial content for files if possible via fs.
     * Recursively adds directory contents (only for 'file:' scheme).
     * Checks exclusions only for 'file:' scheme URIs during recursive add.
     */
    async addResource(uri, parentUri) {
        const uriString = uri.toString();
        const parentUriString = parentUri?.toString();
        if (this._files.some(f => f.uriString === uriString)) {
            return false; // Duplicate
        }
        let isDirectory = false;
        let content = null;
        let canRecurse = false;
        try {
            if (uri.scheme === 'file' && !uri.path.includes('!/')) { // Only stat standard file URIs
                const stats = await fs.stat(uri.fsPath);
                isDirectory = stats.isDirectory();
                canRecurse = isDirectory; // Only recurse into file system directories
                if (!isDirectory) {
                    try {
                        content = await fs.readFile(uri.fsPath, 'utf8');
                    }
                    catch (readErr) {
                        console.warn(`[Storage:addResource] Failed to read initial content for ${uri.fsPath}: ${readErr.message}`);
                        // Content remains null, will be loaded on demand later
                    }
                }
            }
            else {
                // Assume non-file URIs or archive URIs represent single resources, not directories we can recurse into with 'fs'
                isDirectory = false;
                canRecurse = false;
                // Content will be loaded on demand via vscode.workspace.openTextDocument
            }
        }
        catch (statError) {
            // Handle case where file system path doesn't exist or isn't accessible
            if (statError.code === 'ENOENT') {
                console.warn(`[Storage:addResource] Resource not found: ${uriString}`);
                vscode.window.showWarningMessage(`Item not found: ${getDisplayUri(uriString)}`);
            }
            else {
                console.error(`[Storage:addResource] Error processing URI ${uriString}:`, statError);
                vscode.window.showErrorMessage(`Error adding ${getDisplayUri(uriString)}: ${statError.message}`);
            }
            return false; // Cannot add if error occurs
        }
        const entry = {
            uriString: uriString,
            isDirectory: isDirectory,
            content: content,
            parentUriString: parentUriString,
            sessionId: this.sessionId,
        };
        this._files.push(entry); // Add the entry itself
        // --- Recursion for file system directories ---
        if (canRecurse && uri.scheme === 'file') {
            try {
                const dirEntries = await fs.readdir(uri.fsPath, { withFileTypes: true });
                const processingPromises = [];
                for (const dirEntry of dirEntries) {
                    const childPath = path.join(uri.fsPath, dirEntry.name);
                    const childUri = vscode.Uri.file(childPath); // Create URI for child
                    // *** Check exclusion based on file system path BEFORE recursive call ***
                    if (!isPathExcluded(childPath)) {
                        // Pass current URI as parent URI for the child
                        processingPromises.push(this.addResource(childUri, uri));
                    }
                    else {
                        console.log(`[Exclude][AddDir] Skipping excluded child path: ${childPath}`);
                    }
                }
                await Promise.all(processingPromises);
            }
            catch (readDirError) {
                console.error(`[Storage:addResource] Error reading directory ${uri.fsPath}:`, readDirError);
                // Directory entry was added, but contents might be incomplete
                return false; // Indicate partial success/failure
            }
        }
        return true; // Added successfully
    }
    /** Removes entry and its descendants recursively. */
    removeEntry(uriStringToRemove) {
        const initialLength = this._files.length;
        const entryToRemove = this.findEntry(uriStringToRemove);
        if (!entryToRemove)
            return false;
        const removedUris = new Set();
        const queue = [uriStringToRemove]; // Start with the item itself
        while (queue.length > 0) {
            const currentUri = queue.shift();
            if (removedUris.has(currentUri))
                continue; // Already processed
            removedUris.add(currentUri);
            // Find direct children and add them to the queue for removal
            this._files.forEach(f => {
                if (f.parentUriString === currentUri) {
                    queue.push(f.uriString);
                }
            });
        }
        // Filter out all identified URIs
        this._files = this._files.filter(f => !removedUris.has(f.uriString));
        return this._files.length < initialLength;
    }
    clearFiles() {
        const count = this._files.length;
        this._files = [];
        return count;
    }
    /** Restores the entire file list from persisted data. */
    restoreFiles(restoredFiles) {
        this._files = restoredFiles;
        console.log(`[Storage:restore] Restored ${this._files.length} resource entries for session ${this.sessionId}`);
    }
    /** Reorders items based on URI strings */
    reorderItems(draggedUriStrings, targetUriString, dropOnSession = false) {
        console.log(`[Storage:reorder] Dragged URIs: ${draggedUriStrings.join(', ')}, Target URI: ${targetUriString}, OnSession: ${dropOnSession}`);
        const draggedEntries = [];
        for (const draggedUri of draggedUriStrings) {
            const entry = this.findEntry(draggedUri);
            if (entry) {
                draggedEntries.push(entry);
            }
            else {
                console.error(`[Storage:reorder] Could not find dragged entry: ${draggedUri}`);
                return false;
            }
        }
        if (draggedEntries.length === 0)
            return false;
        const firstParentUri = draggedEntries[0].parentUriString;
        if (!draggedEntries.every(e => e.parentUriString === firstParentUri)) {
            console.warn('[Storage:reorder] Dragged items have different parents. Reordering aborted.');
            vscode.window.showWarningMessage("Cannot move items between different containers yet.");
            return false;
        }
        const originalIndices = draggedEntries.map(entry => this._files.findIndex(f => f.uriString === entry.uriString)).sort((a, b) => b - a);
        originalIndices.forEach(index => {
            if (index > -1)
                this._files.splice(index, 1);
        });
        let targetIndex = -1;
        if (dropOnSession) {
            targetIndex = this._files.findIndex(f => f.parentUriString === undefined);
            if (targetIndex === -1)
                targetIndex = this._files.length;
            console.log(`[Storage:reorder] Dropped on session, target index: ${targetIndex}`);
        }
        else if (targetUriString) {
            targetIndex = this._files.findIndex(f => f.uriString === targetUriString);
            if (targetIndex === -1) {
                console.error(`[Storage:reorder] Target URI not found after removing dragged items: ${targetUriString}`);
                this._files.push(...draggedEntries); // Put back at end as fallback
                return false;
            }
            console.log(`[Storage:reorder] Dropped on item ${getDisplayUri(targetUriString)}, target index: ${targetIndex}`);
        }
        else {
            const parentUri = firstParentUri;
            let lastIndexOfParentGroup = -1;
            for (let i = this._files.length - 1; i >= 0; i--) {
                if (this._files[i].parentUriString === parentUri) {
                    lastIndexOfParentGroup = i;
                    break;
                }
            }
            targetIndex = lastIndexOfParentGroup + 1;
            console.log(`[Storage:reorder] Dropped on empty space within parent '${parentUri ?? 'root'}', target index: ${targetIndex}`);
        }
        this._files.splice(targetIndex, 0, ...draggedEntries);
        console.log(`[Storage:reorder] Reordering successful. New count: ${this._files.length}`);
        return true;
    }
}
// --- Session Class ---
class Session {
    id;
    name;
    storage; // Use new storage class name
    associatedDocument = null;
    docCloseListener = null;
    constructor(name, id = (0, uuid_1.v4)()) {
        this.id = id;
        this.name = name;
        this.storage = new SessionResourceStorage(this.id); // Instantiate new storage
    }
    dispose() {
        this.closeAssociatedDocument(false);
        this.docCloseListener?.dispose();
        this.docCloseListener = null;
        this.storage.clearFiles();
    }
    setAssociatedDocument(doc) {
        this.docCloseListener?.dispose();
        this.associatedDocument = doc;
        this.docCloseListener = vscode.workspace.onDidCloseTextDocument(d => {
            if (d === this.associatedDocument) {
                console.log(`[Session ${this.id}] Associated document closed.`);
                this.associatedDocument = null;
                this.docCloseListener?.dispose();
                this.docCloseListener = null;
            }
        });
    }
    async closeAssociatedDocument(attemptEditorClose = true) {
        const docToClose = this.associatedDocument;
        this.associatedDocument = null;
        this.docCloseListener?.dispose();
        this.docCloseListener = null;
        if (attemptEditorClose && docToClose) {
            for (const editor of vscode.window.visibleTextEditors) {
                if (editor.document === docToClose) {
                    try {
                        await vscode.window.showTextDocument(docToClose, { viewColumn: editor.viewColumn, preserveFocus: false });
                        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                        console.log(`[Session ${this.id}] Closed editor for associated document.`);
                        break;
                    }
                    catch (err) {
                        console.error(`[Session ${this.id}] Error closing editor:`, err);
                    }
                }
            }
        }
    }
}
// --- Session Manager Class ---
class SessionManager {
    context;
    sessions = new Map();
    static STORAGE_KEY = 'fileIntegratorSessions_v3'; // Incremented key version
    static OLD_STORAGE_KEY_V2 = 'fileIntegratorSessions_v2';
    static OLD_STORAGE_KEY_V1 = 'fileIntegratorSessions';
    constructor(context) {
        this.context = context;
    }
    createSession(name) {
        const sessionName = name || `Session ${this.sessions.size + 1}`;
        const newSession = new Session(sessionName);
        this.sessions.set(newSession.id, newSession);
        this.persistSessions();
        return newSession;
    }
    getSession(id) {
        return this.sessions.get(id);
    }
    getAllSessions() {
        return Array.from(this.sessions.values()).sort((a, b) => a.name.localeCompare(b.name));
    }
    removeSession(id) {
        const session = this.sessions.get(id);
        if (session) {
            session.dispose();
            const deleted = this.sessions.delete(id);
            if (deleted) {
                this.persistSessions();
            }
            return deleted;
        }
        return false;
    }
    renameSession(id, newName) {
        const session = this.sessions.get(id);
        if (session) {
            session.name = newName;
            this.persistSessions();
            return true;
        }
        return false;
    }
    persistSessions() {
        try {
            const persistedData = this.getAllSessions().map(session => {
                // Map FileEntry[] to PersistedFileEntry[], preserving order
                const persistedFiles = session.storage.files.map(entry => ({
                    uri: entry.uriString, // Store uriString
                    isDirectory: entry.isDirectory,
                    parentUri: entry.parentUriString, // Store parentUriString
                }));
                return {
                    id: session.id,
                    name: session.name,
                    files: persistedFiles,
                };
            });
            this.context.workspaceState.update(SessionManager.STORAGE_KEY, persistedData);
            // Clean up old keys after successful save
            this.context.workspaceState.update(SessionManager.OLD_STORAGE_KEY_V2, undefined);
            this.context.workspaceState.update(SessionManager.OLD_STORAGE_KEY_V1, undefined);
            console.log(`[Persist] Saved ${persistedData.length} sessions with resource structure.`);
        }
        catch (e) {
            console.error("[Persist] Error saving session data:", e);
            vscode.window.showErrorMessage("Error saving File Integrator session data.");
        }
    }
    loadSessions() {
        this.sessions.clear();
        let loadedData = undefined;
        let loadedFromOldKey = false;
        try {
            // Try loading from the newest key first
            loadedData = this.context.workspaceState.get(SessionManager.STORAGE_KEY);
            // Migration from V2 (path-based) if V3 not found
            if (!loadedData) {
                const oldDataV2 = this.context.workspaceState.get(SessionManager.OLD_STORAGE_KEY_V2);
                if (oldDataV2 && oldDataV2.length > 0) {
                    console.log("[Load] Migrating data from V2 storage key (path -> uri).");
                    loadedData = oldDataV2.map(metaV2 => ({
                        id: metaV2.id,
                        name: metaV2.name,
                        // Convert PersistedFileEntry (path-based) to PersistedFileEntry (uri-based)
                        files: metaV2.files
                            .map((pfV2) => {
                            if (!pfV2 || typeof pfV2.path !== 'string')
                                return null;
                            try {
                                // Assume old paths were file system paths
                                const fileUri = vscode.Uri.file(pfV2.path);
                                const parentUri = pfV2.parent ? vscode.Uri.file(pfV2.parent) : undefined;
                                return {
                                    uri: fileUri.toString(),
                                    isDirectory: !!pfV2.isDirectory,
                                    parentUri: parentUri?.toString()
                                };
                            }
                            catch (e) {
                                console.warn(`[Load Migration V2] Error converting path ${pfV2.path} to URI:`, e);
                                return null;
                            }
                        })
                            .filter(pf => pf !== null) // Filter out failed conversions
                    }));
                    loadedFromOldKey = true;
                }
            }
            // Migration from V1 (basic name/id) if V2/V3 not found
            if (!loadedData) {
                const oldDataV1 = this.context.workspaceState.get(SessionManager.OLD_STORAGE_KEY_V1);
                if (oldDataV1 && oldDataV1.length > 0) {
                    console.log("[Load] Migrating data from V1 storage key (basic).");
                    loadedData = oldDataV1.map(metaV1 => ({
                        id: metaV1.id,
                        name: metaV1.name,
                        files: [] // Initialize with empty files
                    }));
                    loadedFromOldKey = true;
                }
                else {
                    loadedData = []; // No data found anywhere
                }
            }
            loadedData.forEach(meta => {
                if (!meta || typeof meta.id !== 'string' || typeof meta.name !== 'string' || !Array.isArray(meta.files)) {
                    console.warn("[Load] Skipping invalid session metadata entry:", meta);
                    return;
                }
                const session = new Session(meta.name, meta.id);
                const mappedEntries = meta.files.map((pf) => {
                    if (!pf || typeof pf.uri !== 'string' || typeof pf.isDirectory !== 'boolean') {
                        console.warn(`[Load] Skipping invalid persisted file entry in session ${meta.id}:`, pf);
                        return null;
                    }
                    try {
                        // Validate URI can be parsed
                        vscode.Uri.parse(pf.uri);
                        if (pf.parentUri)
                            vscode.Uri.parse(pf.parentUri);
                    }
                    catch (e) {
                        console.warn(`[Load] Skipping entry with invalid URI in session ${meta.id}:`, pf.uri, e);
                        return null;
                    }
                    const entry = {
                        uriString: pf.uri,
                        isDirectory: pf.isDirectory,
                        parentUriString: pf.parentUri,
                        content: null, // Content is never persisted
                        sessionId: session.id,
                    };
                    return entry;
                });
                const restoredFiles = mappedEntries.filter((entry) => entry !== null);
                session.storage.restoreFiles(restoredFiles);
                this.sessions.set(session.id, session);
            });
            console.log(`[Load] Loaded ${this.sessions.size} sessions.`);
            if (loadedFromOldKey) {
                this.persistSessions(); // Persist immediately in the new format if migrated
            }
        }
        catch (e) {
            console.error("[Load] Error loading session data:", e);
            this.sessions.clear();
            vscode.window.showErrorMessage("Error loading File Integrator session data. Sessions may be reset.");
        }
        if (this.sessions.size === 0) {
            console.log("[Load] No sessions found or loaded, creating default session.");
            this.createSession("Default Session");
        }
    }
    dispose() {
        this.getAllSessions().forEach(s => s.dispose());
        this.sessions.clear();
    }
}
// SessionItem remains the same
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
// Renamed FileSystemItem to ResourceItem and adapted for URIs
class ResourceItem extends vscode.TreeItem {
    entry;
    constructor(entry, // Uses new FileEntry with uriString
    collapsibleState) {
        const uri = vscode.Uri.parse(entry.uriString);
        let label = '';
        // Extract a meaningful label (usually the file/resource name)
        const pathPart = uri.path;
        // Check for archive paths first (jar: or file: schemes)
        const jarBangIndex = uri.scheme === 'jar' ? pathPart.indexOf('!/') : -1;
        const fileBangIndex = uri.scheme === 'file' ? pathPart.indexOf('!/') : -1;
        if (jarBangIndex !== -1 && pathPart.length > jarBangIndex + 2) {
            // For jar: scheme archive paths
            label = path.basename(pathPart.substring(jarBangIndex + 1));
        }
        else if (fileBangIndex !== -1 && pathPart.length > fileBangIndex + 2) {
            // For file: scheme archive paths
            label = path.basename(pathPart.substring(fileBangIndex + 1));
        }
        else {
            // For regular paths (file: or others)
            label = path.basename(pathPart);
        }
        // Handle untitled or schemes where basename might be empty/unhelpful
        if (!label && uri.scheme !== 'file') {
            label = uri.toString().substring(uri.scheme.length + 1); // Use scheme-specific part
            if (label.startsWith('//'))
                label = label.substring(2); // Remove authority slashes if present
        }
        // Final fallback if label is still empty
        if (!label)
            label = '...';
        super(label, collapsibleState);
        this.entry = entry;
        this.id = `${entry.sessionId}::${entry.uriString}`; // Use uriString in ID
        this.resourceUri = uri; // Critical for 'vscode.open' command
        // Use 'tooltip' type for full details on hover
        this.tooltip = `${entry.isDirectory ? 'Directory' : 'Resource'}:\n${getDisplayUri(entry.uriString, 'tooltip')}`;
        // Use 'treeDescription' type for the shorter context view
        this.description = getDisplayUri(entry.uriString, 'treeDescription');
        // Provide context values for menu contributions
        this.contextValue = entry.isDirectory ? 'resourceDirectory' : 'resourceFile';
        // Use standard icons
        this.iconPath = entry.isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
        // Optional: Decorate library files?
        // if (uri.scheme === 'jar' || (uri.scheme === 'file' && uri.path.includes('!/'))) {
        //    this.iconPath = new vscode.ThemeIcon('library'); // Or 'archive', 'symbol-field'
        // }
    }
    get sessionId() { return this.entry.sessionId; }
    get uriString() { return this.entry.uriString; }
    get isDirectory() { return this.entry.isDirectory; }
}
// --- Tree Data Provider ---
class FileIntegratorProvider {
    sessionManager;
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    // Keep mime types
    dropMimeTypes = ['text/uri-list', 'application/vnd.code.tree.fileIntegratorView'];
    dragMimeTypes = ['application/vnd.code.tree.fileIntegratorView'];
    customMimeType = 'application/vnd.code.tree.fileIntegratorView';
    constructor(sessionManager) {
        this.sessionManager = sessionManager;
    }
    getTreeItem(element) { return element; }
    getChildren(element) {
        if (!element) { // Root: Sessions
            return Promise.resolve(this.sessionManager.getAllSessions().map(s => new SessionItem(s, s.storage.files.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)));
        }
        if (element instanceof SessionItem) { // Session Children (Root items)
            const session = this.sessionManager.getSession(element.session.id);
            if (!session)
                return [];
            // Filter storage for root items (parentUriString is undefined)
            const rootEntries = session.storage.files.filter(f => !f.parentUriString);
            // Map to ResourceItem, preserving order from storage array
            return Promise.resolve(rootEntries.map(e => new ResourceItem(e, e.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)));
        }
        if (element instanceof ResourceItem && element.isDirectory) { // Directory Children
            const session = this.sessionManager.getSession(element.sessionId);
            if (!session)
                return [];
            // Filter storage for children of this directory (parentUriString matches element's uriString)
            const childEntries = session.storage.files.filter(f => f.parentUriString === element.uriString);
            // Map to ResourceItem, preserving order from storage array
            return Promise.resolve(childEntries.map(e => new ResourceItem(e, e.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)));
        }
        return Promise.resolve([]);
    }
    refresh(element) {
        this._onDidChangeTreeData.fire(element);
    }
    // --- Drag and Drop Controller Implementation ---
    handleDrag(source, dataTransfer, token) {
        console.log(`[handleDrag] Starting drag for ${source.length} items.`);
        // Allow dragging ResourceItems
        const draggableItems = source.filter((item) => item instanceof ResourceItem);
        if (draggableItems.length > 0) {
            // Store `sessionId::uriString`
            const draggedIds = draggableItems.map(item => `${item.sessionId}::${item.uriString}`);
            console.log(`[handleDrag] Dragging IDs: ${draggedIds.join(', ')}`);
            dataTransfer.set(this.customMimeType, new vscode.DataTransferItem(draggedIds));
        }
        else {
            console.log(`[handleDrag] No draggable ResourceItems selected.`);
        }
    }
    async handleDrop(target, dataTransfer, token) {
        console.log(`[handleDrop] Drop detected. Target: ${target?.id ?? 'view root'}`);
        const internalDropItem = dataTransfer.get(this.customMimeType);
        const externalDropItem = dataTransfer.get('text/uri-list'); // From external sources (e.g., OS Explorer)
        if (token.isCancellationRequested)
            return;
        // --- Handle INTERNAL Reorder Drop ---
        if (internalDropItem) {
            console.log('[handleDrop] Handling internal drop (reorder).');
            const draggedItemIds = internalDropItem.value;
            if (!Array.isArray(draggedItemIds) || draggedItemIds.length === 0) {
                console.warn('[handleDrop] Internal drop data is invalid.');
                return;
            }
            // Parse sessionId and uriString from the first ID
            const firstDraggedIdParts = draggedItemIds[0].split('::');
            // Need robust splitting in case URI itself contains '::' (unlikely but possible)
            const sessionId = firstDraggedIdParts[0];
            const firstUriIndex = draggedItemIds[0].indexOf('::') + 2;
            if (firstUriIndex < 2) {
                console.warn('[handleDrop] Invalid dragged item ID format (no ::).');
                return;
            }
            // Extract all uriStrings
            const draggedUriStrings = draggedItemIds.map(id => id.substring(id.indexOf('::') + 2)).filter(Boolean);
            const session = this.sessionManager.getSession(sessionId);
            if (!session) {
                console.error(`[handleDrop] Session not found for internal drop: ${sessionId}`);
                return;
            }
            let targetUriString;
            let dropOnSessionNode = false;
            if (target instanceof SessionItem) {
                if (target.session.id !== sessionId) {
                    vscode.window.showErrorMessage("Cannot move items between sessions yet.");
                    return;
                }
                dropOnSessionNode = true;
            }
            else if (target instanceof ResourceItem) {
                if (target.sessionId !== sessionId) {
                    vscode.window.showErrorMessage("Cannot move items between sessions yet.");
                    return;
                }
                targetUriString = target.uriString; // Target is the item dropped onto
            }
            else {
                // Dropped onto empty space in the view (root or inside expanded folder)
                console.log('[handleDrop] Dropped on empty space.');
            }
            // Perform reorder in storage
            const success = session.storage.reorderItems(draggedUriStrings, targetUriString, dropOnSessionNode);
            if (success) {
                this.sessionManager.persistSessions(); // <-- PERSIST after successful reorder
                this.refresh(); // Refresh whole view after reorder
                await updateCodeBlockDocument(session); // Update associated doc
            }
            else {
                this.refresh(); // Refresh even if reorder failed
            }
        }
        // --- Handle EXTERNAL File/Folder Drop ---
        else if (externalDropItem) {
            console.log('[handleDrop] Handling external drop (uri-list).');
            let targetSession;
            // Determine target session based on drop location
            if (target instanceof SessionItem)
                targetSession = target.session;
            else if (target instanceof ResourceItem)
                targetSession = this.sessionManager.getSession(target.sessionId);
            else {
                const s = this.sessionManager.getAllSessions();
                targetSession = s.length > 0 ? s[0] : undefined;
                if (targetSession && s.length > 1)
                    vscode.window.showInformationMessage(`Added resources to session: "${targetSession.name}" (Dropped on view background)`);
                else if (!targetSession) {
                    vscode.window.showErrorMessage("Cannot add resources: No sessions exist.");
                    return;
                }
            }
            if (!targetSession) {
                vscode.window.showErrorMessage("Could not determine target session.");
                return;
            }
            const uriListString = await externalDropItem.asString();
            const uriStrings = uriListString.split('\n').map(u => u.trim()).filter(Boolean);
            if (uriStrings.length === 0)
                return;
            let resourcesWereAdded = false;
            let skippedCount = 0;
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Adding resources to session "${targetSession.name}"...`, cancellable: true }, async (progress, progressToken) => {
                progressToken.onCancellationRequested(() => { console.log("User cancelled resource adding."); });
                for (let i = 0; i < uriStrings.length; i++) {
                    if (progressToken.isCancellationRequested)
                        break;
                    const uriStr = uriStrings[i];
                    let currentUri;
                    try {
                        // External drops are usually file URIs, but parse strictly
                        currentUri = vscode.Uri.parse(uriStr, true);
                        const displayName = getDisplayUri(uriStr, 'treeDescription'); // Get display name early
                        progress.report({ message: `(${i + 1}/${uriStrings.length}) ${displayName}`, increment: 100 / uriStrings.length });
                        // Process URI using the storage method (handles checks & recursion)
                        const processed = await targetSession.storage.addResource(currentUri);
                        if (processed) {
                            resourcesWereAdded = true;
                        }
                        else {
                            // Skipped due to exclusion, duplicate, or error during addResource
                            skippedCount++;
                        }
                    }
                    catch (err) {
                        // Catch URI parsing errors or errors thrown by addResource
                        const errorUriStr = currentUri?.toString() ?? uriStr;
                        vscode.window.showErrorMessage(`Error processing ${getDisplayUri(errorUriStr)}: ${err.message}`);
                        console.error(`Error processing URI ${errorUriStr}:`, err);
                        skippedCount++;
                    }
                }
            });
            if (resourcesWereAdded) {
                this.sessionManager.persistSessions(); // <-- PERSIST if resources were added
                await updateCodeBlockDocument(targetSession); // Update doc if needed
            }
            if (skippedCount > 0) {
                vscode.window.showInformationMessage(`${skippedCount} item(s) were skipped (duplicates, exclusions, or errors).`);
            }
            this.refresh(); // Refresh view regardless
        }
        else {
            console.log('[handleDrop] No supported data transfer item found.');
        }
    }
}
// --- Global Variables & Activation ---
let sessionManager;
let fileIntegratorProvider;
let treeView;
function activate(context) {
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
    registerCommands(context); // Register commands
    // Register disposable for session manager cleanup
    context.subscriptions.push({ dispose: () => sessionManager.dispose() });
    console.log('File Integrator activated.');
}
// --- Command Registration ---
function registerCommands(context) {
    const register = (commandId, callback) => {
        context.subscriptions.push(vscode.commands.registerCommand(commandId, callback));
    };
    // Add Session
    register('fileintegrator.addSession', async () => {
        const n = await vscode.window.showInputBox({ prompt: "Enter new session name", value: `Session ${sessionManager.getAllSessions().length + 1}` });
        if (n && n.trim()) {
            const s = sessionManager.createSession(n.trim());
            fileIntegratorProvider.refresh();
            treeView.reveal(new SessionItem(s), { select: true, focus: true, expand: true });
        }
    });
    // Remove Session
    register('fileintegrator.removeSession', async (item) => {
        const s = item?.session ?? await selectSession('Select session to remove');
        if (!s)
            return;
        const c = await vscode.window.showWarningMessage(`Remove session "${s.name}"?`, { modal: true }, 'Yes', 'No');
        if (c === 'Yes') {
            await s.closeAssociatedDocument(true);
            if (sessionManager.removeSession(s.id)) {
                fileIntegratorProvider.refresh();
            }
        }
    });
    // Rename Session
    register('fileintegrator.renameSession', async (item) => {
        const s = item?.session ?? await selectSession('Select session to rename');
        if (!s)
            return;
        const n = await vscode.window.showInputBox({ prompt: `Enter new name for "${s.name}"`, value: s.name });
        if (n && n.trim() && n.trim() !== s.name) {
            if (sessionManager.renameSession(s.id, n.trim())) {
                fileIntegratorProvider.refresh();
            }
        }
    });
    // Clear Session
    register('fileintegrator.clearSession', async (item) => {
        const s = item?.session ?? await selectSession('Select session to clear');
        if (!s)
            return;
        if (s.storage.files.length === 0) {
            vscode.window.showInformationMessage(`Session "${s.name}" is already empty.`);
            return;
        }
        console.log(`[ClearSession] Clearing all items from session "${s.name}" (ID: ${s.id})`);
        const count = s.storage.clearFiles();
        sessionManager.persistSessions();
        fileIntegratorProvider.refresh();
        await updateCodeBlockDocument(s);
    });
    // Generate Code Block
    register('fileintegrator.generateCodeBlock', async (item) => {
        const s = item?.session ?? await selectSession('Select session to generate code block for');
        if (!s)
            return;
        if (s.storage.resourcesOnly.length === 0) {
            vscode.window.showInformationMessage(`Session "${s.name}" contains no file/resource content.`);
            return;
        }
        const doc = await showCodeBlockDocument(s);
        if (doc) {
            await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
        }
    });
    // Copy To Clipboard
    register('fileintegrator.copyToClipboard', async (item) => {
        const s = item?.session ?? await selectSession('Select session to copy content from');
        if (!s)
            return;
        if (s.storage.resourcesOnly.length === 0) {
            vscode.window.showInformationMessage(`Session "${s.name}" contains no file/resource content to copy.`);
            return;
        }
        let contentToCopy;
        if (s.associatedDocument && !s.associatedDocument.isClosed) {
            contentToCopy = s.associatedDocument.getText();
        }
        else {
            contentToCopy = await generateMarkdownContent(s);
        }
        if (contentToCopy && !contentToCopy.startsWith('<!-- No file/resource content')) {
            await vscode.env.clipboard.writeText(contentToCopy);
            vscode.window.showInformationMessage(`Session "${s.name}" content copied to clipboard!`);
        }
        else {
            vscode.window.showWarningMessage("No content was generated or found to copy.");
        }
    });
    // Remove Item
    register('fileintegrator.removeItem', async (item) => {
        if (!item || !(item instanceof ResourceItem))
            return;
        const s = sessionManager.getSession(item.sessionId);
        if (s) {
            if (s.storage.removeEntry(item.uriString)) {
                sessionManager.persistSessions();
                fileIntegratorProvider.refresh();
                await updateCodeBlockDocument(s);
            }
            else {
                fileIntegratorProvider.refresh();
            }
        }
    });
    // Refresh View
    register('fileintegrator.refreshView', () => {
        fileIntegratorProvider.refresh();
    });
    // Add Active Editor to Session
    register('fileintegrator.addActiveEditorToSession', async (sessionItemOrContext) => {
        let targetSession;
        let sessionItemForRefresh;
        // Determine target session: either from context menu item or by selection
        if (sessionItemOrContext instanceof SessionItem) {
            sessionItemForRefresh = sessionItemOrContext;
            targetSession = sessionManager.getSession(sessionItemForRefresh.session.id);
        }
        else {
            targetSession = await selectSession("Select session to add active editor to");
            // Cannot easily get the SessionItem for targeted refresh if selected via QuickPick
        }
        if (!targetSession) {
            if (!sessionItemOrContext)
                vscode.window.showErrorMessage("Could not determine the target session."); // Only show error if not cancelled QuickPick
            return;
        }
        await addActiveEditorLogic(targetSession, sessionItemForRefresh);
    });
}
// Helper logic for adding active editor
async function addActiveEditorLogic(targetSession, sessionItemForRefresh) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage("No active editor found to add.");
        return;
    }
    const document = editor.document;
    const uri = document.uri;
    const uriString = uri.toString();
    if (document === targetSession.associatedDocument) {
        vscode.window.showInformationMessage("Cannot add the generated session document to itself.");
        return;
    }
    if (targetSession.storage.findEntry(uriString)) {
        vscode.window.showInformationMessage(`"${getDisplayUri(uriString, 'treeDescription')}" is already in the session "${targetSession.name}".`);
        return;
    }
    console.log(`[AddActiveEditor] Adding ${uriString} to session ${targetSession.name}`);
    const newEntry = {
        uriString: uriString,
        isDirectory: false,
        content: null,
        parentUriString: undefined,
        sessionId: targetSession.id,
    };
    if (targetSession.storage.addItem(newEntry)) {
        sessionManager.persistSessions();
        // Refresh entire view for simplicity and reliability on add
        fileIntegratorProvider.refresh(); // <-- Use full refresh here
    }
    else {
        vscode.window.showWarningMessage(`Failed to add "${getDisplayUri(uriString)}" (perhaps already added?).`);
    }
}
// --- Deactivation ---
function deactivate() {
    console.log('Deactivating File Integrator...');
}
// --- Helper Functions ---
/** Checks exclusion rules based on file system path for 'file:' scheme URIs. */
function isPathExcluded(filePath) {
    const config = vscode.workspace.getConfiguration('fileintegrator');
    const excludePatterns = config.get('exclude');
    if (!excludePatterns)
        return false;
    const normalizedFilePath = filePath.replace(/\\/g, '/');
    const workspaceFolders = vscode.workspace.workspaceFolders;
    for (const pattern in excludePatterns) {
        if (excludePatterns[pattern]) {
            const normalizedPattern = pattern.replace(/\\/g, '/');
            const options = { dot: true, nocase: process.platform === 'win32' };
            if ((0, minimatch_1.minimatch)(normalizedFilePath, normalizedPattern, options))
                return true;
            if (workspaceFolders) {
                for (const folder of workspaceFolders) {
                    const folderPath = folder.uri.fsPath.replace(/\\/g, '/');
                    if (normalizedFilePath.startsWith(folderPath + '/')) {
                        const relativePath = normalizedFilePath.substring(folderPath.length + 1);
                        if ((0, minimatch_1.minimatch)(relativePath, normalizedPattern, options))
                            return true;
                    }
                }
            }
            if (!normalizedPattern.includes('/')) {
                if ((0, minimatch_1.minimatch)(path.basename(normalizedFilePath), normalizedPattern, options))
                    return true;
            }
        }
    }
    return false;
}
/** Prompts user to select a session via Quick Pick. */
async function selectSession(placeHolder) {
    const sessions = sessionManager.getAllSessions();
    if (sessions.length === 0) {
        vscode.window.showErrorMessage("No sessions available.");
        return undefined;
    }
    if (sessions.length === 1)
        return sessions[0];
    const picks = sessions.map(s => ({ label: s.name, description: `(${s.storage.files.length} items)`, session: s }));
    const selection = await vscode.window.showQuickPick(picks, { placeHolder, canPickMany: false });
    return selection?.session;
}
/**
 * Generates aggregated Markdown content for a session, respecting order.
 * Reads resource content asynchronously using VS Code API.
 */
async function generateMarkdownContent(session) {
    let content = '';
    const resourceEntries = session.storage.files.filter(f => !f.isDirectory);
    if (resourceEntries.length === 0) {
        return `<!-- No file/resource content in session "${session.name}" -->\n`;
    }
    console.log(`[MarkdownGen] Generating content for ${resourceEntries.length} resources in session ${session.id}`);
    for (const entry of resourceEntries) {
        let resourceContent = entry.content;
        if (resourceContent === null) {
            const uri = vscode.Uri.parse(entry.uriString);
            try {
                console.log(`[MarkdownGen] Opening URI via VS Code API: ${entry.uriString}`);
                const doc = await vscode.workspace.openTextDocument(uri);
                resourceContent = doc.getText();
            }
            catch (error) {
                console.error(`[MarkdownGen] Error opening/reading URI ${entry.uriString} via VS Code API:`, error);
                vscode.window.showWarningMessage(`Could not read content for: ${getDisplayUri(entry.uriString, 'treeDescription')}`);
                resourceContent = `--- Error reading content for ${getDisplayUri(entry.uriString)}: ${error.message} ---`;
            }
        }
        // Use the 'markdownHeader' format for the display URI
        const displayUri = getDisplayUri(entry.uriString, 'markdownHeader');
        const uriPath = vscode.Uri.parse(entry.uriString).path;
        const langPart = uriPath.includes('!/') ? uriPath.substring(uriPath.indexOf('!/') + 1) : uriPath;
        const lang = path.extname(langPart).substring(1);
        content += `${displayUri}\n\`\`\`${lang}\n`;
        content += resourceContent ?? `--- Content Unavailable ---`;
        content += `\n\`\`\`\n\n`;
    }
    return content.trimEnd();
}
/** Shows/Updates the code block document for a session. Async. */
async function showCodeBlockDocument(session) {
    const content = await generateMarkdownContent(session);
    if (session.associatedDocument && !session.associatedDocument.isClosed) {
        const doc = session.associatedDocument;
        try {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), content);
            const success = await vscode.workspace.applyEdit(edit);
            if (!success)
                throw new Error("ApplyEdit failed");
            console.log(`[ShowDoc] Updated existing associated document for session ${session.id}`);
            return doc;
        }
        catch (e) {
            console.error(`[ShowDoc] Error updating associated doc ${doc.uri}:`, e);
            vscode.window.showErrorMessage("Failed to update associated document.");
            return undefined;
        }
    }
    try {
        console.log(`[ShowDoc] Creating new associated document for session ${session.id}`);
        const doc = await vscode.workspace.openTextDocument({ content: content, language: 'markdown' });
        session.setAssociatedDocument(doc);
        return doc;
    }
    catch (e) {
        console.error(`[ShowDoc] Failed to create associated document:`, e);
        vscode.window.showErrorMessage(`Failed to create associated document: ${e.message}`);
        return undefined;
    }
}
/** Updates associated document IF it exists and is open. Async. */
async function updateCodeBlockDocument(session) {
    if (session.associatedDocument && !session.associatedDocument.isClosed) {
        const doc = session.associatedDocument;
        console.log(`[UpdateDoc] Updating associated document for session ${session.id}`);
        const content = await generateMarkdownContent(session);
        try {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), content);
            const success = await vscode.workspace.applyEdit(edit);
            if (!success) {
                console.warn(`[UpdateDoc] ApplyEdit failed for ${doc.uri}. Detaching association.`);
                session.closeAssociatedDocument(false);
            }
            else {
                console.log(`[UpdateDoc] Successfully updated associated document.`);
            }
        }
        catch (err) {
            console.error(`[UpdateDoc] Error applying edit to ${doc.uri}:`, err);
            vscode.window.showErrorMessage("Error updating associated code block document.");
        }
    }
}
/**
 * Generates a display-friendly string for a URI.
 * - For file URIs: Tries to create a relative path, falls back to shortened absolute.
 * - For archive URIs (jar:file:...!/ or file:...!/): Shows archive_name!/internal_path
 * - For other schemes: Shows scheme://path (potentially shortened)
 * @param uriString The full URI string.
 * @param type 'treeDescription' | 'markdownHeader' | 'tooltip' - controls formatting detail.
 */
function getDisplayUri(uriString, type = 'markdownHeader') {
    try {
        const uri = vscode.Uri.parse(uriString);
        const scheme = uri.scheme;
        const uriPath = uri.path; // Use uri.path for consistency
        // Handle JAR scheme specifically
        if (scheme === 'jar' && uriPath.includes('!/')) {
            const parts = uriPath.split('!/');
            const archiveUriString = parts[0];
            const internalPath = parts[1];
            let archiveName = 'unknown.jar';
            try {
                const archiveUri = vscode.Uri.parse(archiveUriString); // May fail if archive part isn't valid URI itself
                archiveName = path.basename(archiveUri.path);
            }
            catch { /* ignore */ }
            const displayInternalPath = internalPath.replace(/\\/g, '/');
            if (type === 'treeDescription') {
                const shortInternal = displayInternalPath.length > 25 ? '.../' + displayInternalPath.slice(-22) : displayInternalPath;
                return `(${archiveName}!/${shortInternal})`;
            }
            else { // markdownHeader or tooltip
                return `${archiveName}!/${displayInternalPath}`;
            }
        }
        // Handle standard file scheme (including nested archives like file:...!/)
        else if (scheme === 'file') {
            const bangIndex = uriPath.indexOf('!/'); // Check for archive separator in path
            if (bangIndex !== -1 && uriPath.length > bangIndex + 1) {
                // Archive path within a file: URI
                const archiveFsPath = uri.fsPath.substring(0, uri.fsPath.indexOf('!')); // Get fsPath part before '!'
                const internalPath = uriPath.substring(bangIndex + 1);
                const archiveName = path.basename(archiveFsPath);
                const displayInternalPath = (internalPath.startsWith('/') ? internalPath.substring(1) : internalPath).replace(/\\/g, '/');
                if (type === 'treeDescription') {
                    const shortInternal = displayInternalPath.length > 25 ? '.../' + displayInternalPath.slice(-22) : displayInternalPath;
                    return `(${archiveName}!/${shortInternal})`;
                }
                else { // markdownHeader or tooltip
                    return `${archiveName}!/${displayInternalPath}`;
                }
            }
            else {
                // Simple file path, use getDisplayPath for relative paths
                if (type === 'treeDescription') {
                    return getDisplayPath(uri.fsPath, true); // Use short version for description
                }
                else { // markdownHeader or tooltip
                    return getDisplayPath(uri.fsPath, false); // Use longer version
                }
            }
        }
        // Handle other schemes (untitled, git, http, etc.)
        else {
            let displayPath = uriPath;
            if (displayPath.length > 1 && displayPath.startsWith('/')) {
                displayPath = displayPath.substring(1);
            }
            const authority = uri.authority ? `//${uri.authority}/` : '';
            const fullDisplay = `${scheme}:${authority}${displayPath}`;
            if (type === 'treeDescription') {
                return fullDisplay.length > 40 ? fullDisplay.substring(0, 15) + '...' + fullDisplay.substring(fullDisplay.length - 22) : fullDisplay;
            }
            else { // markdownHeader or tooltip
                return fullDisplay;
            }
        }
    }
    catch (e) {
        console.warn(`[getDisplayUri] Error parsing/formatting URI string: ${uriString}`, e);
        // Fallback for unparseable strings
        if (type === 'treeDescription' && uriString.length > 40) {
            return uriString.substring(0, 15) + '...' + uriString.substring(uriString.length - 22);
        }
        return uriString;
    }
}
/** Generates display-friendly file system path, preferably relative. (Used by getDisplayUri for file: scheme) */
function getDisplayPath(filePath, short = false) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    let relativePath;
    if (workspaceFolders) {
        const sortedFolders = [...workspaceFolders].sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length);
        for (const folder of sortedFolders) {
            const folderPath = folder.uri.fsPath;
            // Use path.sep for OS-specific comparison
            if (filePath.startsWith(folderPath + path.sep)) {
                relativePath = path.relative(folderPath, filePath);
                break;
            }
            if (filePath === folderPath) {
                relativePath = path.basename(filePath);
                break;
            }
        }
    }
    if (relativePath) {
        const display = relativePath.replace(/\\/g, '/'); // Display with forward slashes
        if (short && display.length > 40) {
            const parts = display.split('/');
            if (parts.length > 2) {
                return parts[0] + '/.../' + parts[parts.length - 1];
            }
        }
        return display;
    }
    else {
        // Fallback for non-workspace paths
        const pathParts = filePath.split(/[\\/]/);
        const partsCount = pathParts.length;
        if (!short && partsCount > 2) {
            return '...' + path.sep + pathParts.slice(-2).join(path.sep);
        }
        else if (partsCount > 1) {
            return pathParts.slice(partsCount > 1 ? -2 : -1).join(path.sep);
        }
        else {
            return pathParts[0] ?? filePath;
        }
    }
}
//# sourceMappingURL=extension.js.map