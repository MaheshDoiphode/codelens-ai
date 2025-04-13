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
const fs = __importStar(require("fs-extra"));
const uuid_1 = require("uuid");
const minimatch_1 = require("minimatch");
/**
 * Manages resource storage for a single session, preserving order.
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
    // Filter for non-directories
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
     * Adds a resource from a URI, handling initial content read for 'file:' URIs
     * and recursive addition for directories (checking exclusions).
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
            // Attempt to stat standard file URIs (not inside archives)
            if (uri.scheme === 'file' && !uri.path.includes('!/')) {
                const stats = await fs.stat(uri.fsPath);
                isDirectory = stats.isDirectory();
                canRecurse = isDirectory;
                if (!isDirectory) {
                    try {
                        content = await fs.readFile(uri.fsPath, 'utf8');
                    }
                    catch (readErr) {
                        console.warn(`[Storage:addResource] Failed initial read ${uri.fsPath}: ${readErr.message}`);
                        // Content remains null, loaded later via VS Code API
                    }
                }
            }
            else {
                // Assume non-file URIs (jar:, untitled:, etc.) or archives are single resources
                isDirectory = false;
                canRecurse = false;
                // Content will be loaded on demand via vscode.workspace.openTextDocument
            }
        }
        catch (statError) {
            if (statError.code === 'ENOENT') {
                console.warn(`[Storage:addResource] Resource not found: ${uriString}`);
                vscode.window.showWarningMessage(`Item not found: ${getDisplayUri(uriString)}`);
            }
            else {
                console.error(`[Storage:addResource] Error processing URI ${uriString}:`, statError);
                vscode.window.showErrorMessage(`Error adding ${getDisplayUri(uriString)}: ${statError.message}`);
            }
            return false; // Cannot add
        }
        const entry = {
            uriString: uriString,
            isDirectory: isDirectory,
            content: content,
            parentUriString: parentUriString,
            sessionId: this.sessionId,
        };
        this._files.push(entry);
        // --- Recursion for file system directories ---
        if (canRecurse && uri.scheme === 'file') {
            try {
                const dirEntries = await fs.readdir(uri.fsPath, { withFileTypes: true });
                const processingPromises = [];
                for (const dirEntry of dirEntries) {
                    const childPath = path.join(uri.fsPath, dirEntry.name);
                    const childUri = vscode.Uri.file(childPath);
                    // Check exclusion based on file system path BEFORE recursive call
                    if (!isPathExcluded(childPath)) {
                        processingPromises.push(this.addResource(childUri, uri)); // Pass current URI as parent
                    }
                    else {
                        console.log(`[Exclude][AddDir] Skipping excluded: ${childPath}`);
                    }
                }
                await Promise.all(processingPromises);
            }
            catch (readDirError) {
                console.error(`[Storage:addResource] Error reading directory ${uri.fsPath}:`, readDirError);
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
        const queue = [uriStringToRemove];
        // Find all descendant URIs using parentUriString links
        while (queue.length > 0) {
            const currentUri = queue.shift();
            if (removedUris.has(currentUri))
                continue;
            removedUris.add(currentUri);
            this._files.forEach(f => {
                if (f.parentUriString === currentUri) {
                    queue.push(f.uriString);
                }
            });
        }
        this._files = this._files.filter(f => !removedUris.has(f.uriString));
        return this._files.length < initialLength;
    }
    clearFiles() {
        const count = this._files.length;
        this._files = [];
        return count;
    }
    /** Restores the file list from persisted data. */
    restoreFiles(restoredFiles) {
        this._files = restoredFiles;
        console.log(`[Storage:restore] Restored ${this._files.length} items for session ${this.sessionId}`);
    }
    /** Reorders items within the same parent based on URI strings. */
    reorderItems(draggedUriStrings, targetUriString, dropOnSession = false) {
        console.log(`[Storage:reorder] Dragged: ${draggedUriStrings.length}, Target: ${targetUriString}, OnSession: ${dropOnSession}`);
        const draggedEntries = [];
        for (const draggedUri of draggedUriStrings) {
            const entry = this.findEntry(draggedUri);
            if (!entry) {
                console.error(`[Storage:reorder] Dragged entry not found: ${draggedUri}`);
                return false;
            }
            draggedEntries.push(entry);
        }
        if (draggedEntries.length === 0)
            return false;
        // Basic check: Ensure all dragged items share the same parent initially
        const firstParentUri = draggedEntries[0].parentUriString;
        if (!draggedEntries.every(e => e.parentUriString === firstParentUri)) {
            console.warn('[Storage:reorder] Dragged items have different parents. Aborted.');
            vscode.window.showWarningMessage("Cannot move items between different containers yet.");
            return false;
        }
        // Remove dragged items temporarily (iterate backwards for splice safety)
        const originalIndices = draggedEntries.map(entry => this._files.findIndex(f => f.uriString === entry.uriString)).sort((a, b) => b - a);
        originalIndices.forEach(index => {
            if (index > -1)
                this._files.splice(index, 1);
        });
        // Determine insertion index
        let targetIndex = -1;
        if (dropOnSession) {
            // Find first root item's index, or end of list if no root items exist after removal
            targetIndex = this._files.findIndex(f => f.parentUriString === undefined);
            if (targetIndex === -1)
                targetIndex = this._files.length;
        }
        else if (targetUriString) {
            // Find index of the item dropped onto
            targetIndex = this._files.findIndex(f => f.uriString === targetUriString);
            if (targetIndex === -1) {
                console.error(`[Storage:reorder] Target URI not found after removal: ${targetUriString}`);
                this._files.push(...draggedEntries); // Put back at end as fallback
                return false;
            }
        }
        else {
            // Dropped in empty space within a parent group: find last item of that group + 1
            const parentUri = firstParentUri;
            let lastIndexOfParentGroup = -1;
            for (let i = this._files.length - 1; i >= 0; i--) {
                if (this._files[i].parentUriString === parentUri) {
                    lastIndexOfParentGroup = i;
                    break;
                }
            }
            targetIndex = lastIndexOfParentGroup + 1;
        }
        // Insert dragged items at the calculated index
        this._files.splice(targetIndex, 0, ...draggedEntries);
        console.log(`[Storage:reorder] Reordering successful. New count: ${this._files.length}`);
        return true;
    }
}
// --- Session Class ---
class Session {
    id;
    name;
    storage;
    associatedDocument = null;
    docCloseListener = null;
    constructor(name, id = (0, uuid_1.v4)()) {
        this.id = id;
        this.name = name;
        this.storage = new SessionResourceStorage(this.id);
    }
    dispose() {
        this.closeAssociatedDocument(false); // Detach listener, clear link
        this.storage.clearFiles();
    }
    setAssociatedDocument(doc) {
        this.docCloseListener?.dispose(); // Dispose previous listener if any
        this.associatedDocument = doc;
        // Listen for when the user closes the associated document
        this.docCloseListener = vscode.workspace.onDidCloseTextDocument(d => {
            if (d === this.associatedDocument) {
                console.log(`[Session ${this.id}] Associated document closed by user.`);
                this.associatedDocument = null;
                this.docCloseListener?.dispose();
                this.docCloseListener = null;
            }
        });
    }
    async closeAssociatedDocument(attemptEditorClose = true) {
        const docToClose = this.associatedDocument;
        // Always clear the internal link and listener
        this.associatedDocument = null;
        this.docCloseListener?.dispose();
        this.docCloseListener = null;
        // Optionally attempt to close the editor tab as well
        if (attemptEditorClose && docToClose) {
            for (const editor of vscode.window.visibleTextEditors) {
                if (editor.document === docToClose) {
                    try {
                        // Focus the editor containing the doc and execute close command
                        await vscode.window.showTextDocument(docToClose, { viewColumn: editor.viewColumn, preserveFocus: false });
                        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                        console.log(`[Session ${this.id}] Closed editor for associated document.`);
                        break; // Stop after closing the first matching editor
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
    // Storage key includes version for migration purposes
    static STORAGE_KEY = 'fileIntegratorSessions_v3';
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
    /** Saves all sessions and their file metadata (URIs, hierarchy) to workspace state. */
    persistSessions() {
        try {
            const persistedData = this.getAllSessions().map(session => {
                const persistedFiles = session.storage.files.map(entry => ({
                    uri: entry.uriString,
                    isDirectory: entry.isDirectory,
                    parentUri: entry.parentUriString,
                }));
                return {
                    id: session.id,
                    name: session.name,
                    files: persistedFiles, // Order is preserved
                };
            });
            this.context.workspaceState.update(SessionManager.STORAGE_KEY, persistedData);
            // Clean up data stored under old keys after successful save
            this.context.workspaceState.update(SessionManager.OLD_STORAGE_KEY_V2, undefined);
            this.context.workspaceState.update(SessionManager.OLD_STORAGE_KEY_V1, undefined);
            console.log(`[Persist] Saved ${persistedData.length} sessions.`);
        }
        catch (e) {
            console.error("[Persist] Error saving session data:", e);
            vscode.window.showErrorMessage("Error saving File Integrator session data.");
        }
    }
    /** Loads sessions from workspace state, handling migration from older formats. */
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
                            .filter(pf => pf !== null)
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
            // Process the loaded (and potentially migrated) data
            loadedData.forEach(meta => {
                if (!meta || typeof meta.id !== 'string' || typeof meta.name !== 'string' || !Array.isArray(meta.files)) {
                    console.warn("[Load] Skipping invalid session metadata entry:", meta);
                    return;
                }
                const session = new Session(meta.name, meta.id);
                const restoredFiles = meta.files
                    .map((pf) => {
                    if (!pf || typeof pf.uri !== 'string' || typeof pf.isDirectory !== 'boolean') {
                        console.warn(`[Load] Skipping invalid persisted file entry in session ${meta.id}:`, pf);
                        return null;
                    }
                    try {
                        // Validate URI can be parsed
                        vscode.Uri.parse(pf.uri);
                        if (pf.parentUri)
                            vscode.Uri.parse(pf.parentUri);
                        return {
                            uriString: pf.uri,
                            isDirectory: pf.isDirectory,
                            parentUriString: pf.parentUri,
                            content: null, // Content is never persisted, loaded on demand
                            sessionId: session.id,
                        };
                    }
                    catch (e) {
                        console.warn(`[Load] Skipping entry with invalid URI in session ${meta.id}:`, pf.uri, e);
                        return null;
                    }
                })
                    .filter((entry) => entry !== null); // Filter out nulls from mapping
                session.storage.restoreFiles(restoredFiles);
                this.sessions.set(session.id, session);
            });
            console.log(`[Load] Loaded ${this.sessions.size} sessions.`);
            // If migrated from an older format, save immediately in the new format
            if (loadedFromOldKey) {
                this.persistSessions();
            }
        }
        catch (e) {
            console.error("[Load] Error loading session data:", e);
            this.sessions.clear();
            vscode.window.showErrorMessage("Error loading File Integrator session data. Sessions may be reset.");
        }
        // Ensure there's at least one session
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
// Represents a Session in the Tree View
class SessionItem extends vscode.TreeItem {
    session;
    constructor(session, collapsibleState = vscode.TreeItemCollapsibleState.Collapsed) {
        super(session.name, collapsibleState);
        this.session = session;
        this.id = session.id;
        this.contextValue = 'session'; // Used for context menu targeting
        this.iconPath = new vscode.ThemeIcon('folder-library');
        this.tooltip = `Session: ${session.name}`;
        this.description = `(${session.storage.files.length} items)`;
    }
}
// Represents a FileEntry (file, directory, or other resource) in the Tree View
class ResourceItem extends vscode.TreeItem {
    entry;
    constructor(entry, collapsibleState) {
        const uri = vscode.Uri.parse(entry.uriString);
        let label = ''; // This will be just the base name
        // --- Extract Base Name for Label ---
        const uriPath = uri.path;
        const bangIndex = uriPath.lastIndexOf('!/');
        if (bangIndex !== -1) {
            // It's an archive path (e.g., jar:...!/path/to/file.java or file:...!/path/to/file.java)
            const internalPath = uriPath.substring(bangIndex + 1);
            // Remove leading slash if present before getting basename
            label = path.basename(internalPath.startsWith('/') ? internalPath.substring(1) : internalPath);
        }
        else {
            // Standard path (file:, untitled:, git:, etc.)
            label = path.basename(uriPath);
        }
        // Handle cases where basename might be empty or unhelpful (e.g., untitled:, root paths)
        if (!label && uri.scheme !== 'file') {
            label = uri.toString().substring(uri.scheme.length + 1); // Use scheme-specific part
            if (label.startsWith('//'))
                label = label.substring(2); // Remove authority slashes if present
        }
        // Final fallback if label is still empty
        if (!label)
            label = entry.uriString; // Fallback to full URI string if basename fails
        // --- End of Label Extraction ---
        // Initialize TreeItem with the extracted base name as the label
        super(label, collapsibleState);
        this.entry = entry;
        // --- Set Other Properties ---
        this.id = `${entry.sessionId}::${entry.uriString}`; // Unique ID for the tree item
        this.resourceUri = uri; // The actual URI, essential for commands like 'vscode.open'
        // Set command to open non-directory items on click
        if (!entry.isDirectory) {
            this.command = {
                command: 'vscode.open',
                title: "Open Resource",
                arguments: [uri]
            };
            this.collapsibleState = vscode.TreeItemCollapsibleState.None; // Non-directories aren't expandable
        }
        // Tooltip shows full path/URI
        this.tooltip = `${entry.isDirectory ? 'Directory' : 'Resource'}:\n${getDisplayUri(entry.uriString, 'tooltip')}`;
        // Description shows shortened contextual path (next to the label)
        this.description = getDisplayUri(entry.uriString, 'treeDescription');
        this.contextValue = entry.isDirectory ? 'resourceDirectory' : 'resourceFile'; // For context menus
        this.iconPath = entry.isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    }
    // Convenience getters
    get sessionId() { return this.entry.sessionId; }
    get uriString() { return this.entry.uriString; }
    get isDirectory() { return this.entry.isDirectory; }
}
// --- Tree Data Provider ---
class FileIntegratorProvider {
    sessionManager;
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    // Declare supported MIME types for drag and drop
    dropMimeTypes = ['text/uri-list', 'application/vnd.code.tree.fileIntegratorView'];
    dragMimeTypes = ['application/vnd.code.tree.fileIntegratorView'];
    customMimeType = 'application/vnd.code.tree.fileIntegratorView';
    constructor(sessionManager) {
        this.sessionManager = sessionManager;
    }
    getTreeItem(element) { return element; }
    getChildren(element) {
        if (!element) {
            // Root level: Show all sessions
            return Promise.resolve(this.sessionManager.getAllSessions().map(s => new SessionItem(s, s.storage.files.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)));
        }
        if (element instanceof SessionItem) {
            // Session level: Show root items (no parent) within this session
            const session = this.sessionManager.getSession(element.session.id);
            if (!session)
                return [];
            const rootEntries = session.storage.files.filter(f => !f.parentUriString);
            return Promise.resolve(rootEntries.map(e => new ResourceItem(e, e.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)));
        }
        if (element instanceof ResourceItem && element.isDirectory) {
            // Directory level: Show children of this directory
            const session = this.sessionManager.getSession(element.sessionId);
            if (!session)
                return [];
            const childEntries = session.storage.files.filter(f => f.parentUriString === element.uriString);
            return Promise.resolve(childEntries.map(e => new ResourceItem(e, e.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)));
        }
        return Promise.resolve([]); // Should not happen for valid elements
    }
    /** Signals VS Code to refresh the view (optionally starting from a specific element). */
    refresh(element) {
        this._onDidChangeTreeData.fire(element);
    }
    // --- Drag and Drop Controller Implementation ---
    /** Handles dragging items *from* the File Integrator view. */
    handleDrag(source, dataTransfer, token) {
        console.log(`[handleDrag] Starting drag for ${source.length} items.`);
        const draggableItems = source.filter((item) => item instanceof ResourceItem);
        if (draggableItems.length > 0) {
            // Package identifiers as 'sessionId::uriString' for internal reordering
            const draggedIds = draggableItems.map(item => `${item.sessionId}::${item.uriString}`);
            dataTransfer.set(this.customMimeType, new vscode.DataTransferItem(draggedIds));
        }
    }
    /** Handles dropping items *onto* the File Integrator view. */
    async handleDrop(target, dataTransfer, token) {
        console.log(`[handleDrop] Drop detected. Target: ${target?.id ?? 'view root'}`);
        const internalDropItem = dataTransfer.get(this.customMimeType);
        const externalDropItem = dataTransfer.get('text/uri-list');
        if (token.isCancellationRequested)
            return;
        // --- Handle INTERNAL Reorder Drop ---
        if (internalDropItem) {
            console.log('[handleDrop] Handling internal drop (reorder).');
            const draggedItemIds = internalDropItem.value;
            if (!Array.isArray(draggedItemIds) || draggedItemIds.length === 0)
                return;
            // Robustly parse 'sessionId::uriString' format
            const firstIdParts = draggedItemIds[0].split('::');
            if (firstIdParts.length < 2) {
                console.warn('[handleDrop] Invalid dragged item ID format.');
                return;
            }
            const sessionId = firstIdParts[0];
            const draggedUriStrings = draggedItemIds.map(id => id.substring(id.indexOf('::') + 2)).filter(Boolean);
            const session = this.sessionManager.getSession(sessionId);
            if (!session) {
                console.error(`[handleDrop] Session not found for internal drop: ${sessionId}`);
                return;
            }
            let targetUriString;
            let dropOnSessionNode = false;
            // Determine drop context and check if target session matches source session
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
                targetUriString = target.uriString;
            }
            // else: dropped on empty space (handled by reorderItems logic)
            // Perform reorder in storage model
            const success = session.storage.reorderItems(draggedUriStrings, targetUriString, dropOnSessionNode);
            if (success) {
                this.sessionManager.persistSessions();
                await updateCodeBlockDocument(session); // Update associated doc content
                this.refresh(); // Refresh the entire view after reorder
            }
            else {
                this.refresh(); // Refresh even if reorder failed (e.g., different parents)
            }
        }
        // --- Handle EXTERNAL File/Folder Drop (e.g., from Explorer) ---
        else if (externalDropItem) {
            console.log('[handleDrop] Handling external drop (uri-list).');
            let targetSession;
            // Determine target session based on drop location
            if (target instanceof SessionItem) {
                targetSession = target.session;
            }
            else if (target instanceof ResourceItem) {
                targetSession = this.sessionManager.getSession(target.sessionId);
            }
            else {
                // Dropped on view background - use first session or show error
                const sessions = this.sessionManager.getAllSessions();
                targetSession = sessions.length > 0 ? sessions[0] : undefined;
                if (targetSession && sessions.length > 1) {
                    vscode.window.showInformationMessage(`Added resources to session: "${targetSession.name}" (Dropped on view background)`);
                }
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
            // Show progress for potentially long operations
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Adding to session "${targetSession.name}"...`, cancellable: true }, async (progress, progressToken) => {
                progressToken.onCancellationRequested(() => { console.log("User cancelled resource adding."); });
                for (let i = 0; i < uriStrings.length; i++) {
                    if (progressToken.isCancellationRequested)
                        break;
                    const uriStr = uriStrings[i];
                    let currentUri;
                    try {
                        currentUri = vscode.Uri.parse(uriStr, true); // Strict parsing
                        const displayName = getDisplayUri(uriStr, 'treeDescription');
                        progress.report({ message: `(${i + 1}/${uriStrings.length}) ${displayName}`, increment: 100 / uriStrings.length });
                        // addResource handles fs checks, recursion, and exclusion checks
                        const processed = await targetSession.storage.addResource(currentUri);
                        if (processed) {
                            resourcesWereAdded = true;
                        }
                        else {
                            // Skipped (duplicate, exclusion, or error during addResource)
                            skippedCount++;
                        }
                    }
                    catch (err) {
                        const errorUriStr = currentUri?.toString() ?? uriStr;
                        vscode.window.showErrorMessage(`Error processing ${getDisplayUri(errorUriStr)}: ${err.message}`);
                        console.error(`Error processing URI ${errorUriStr}:`, err);
                        skippedCount++;
                    }
                }
            });
            if (resourcesWereAdded) {
                this.sessionManager.persistSessions();
                await updateCodeBlockDocument(targetSession);
            }
            if (skippedCount > 0) {
                vscode.window.showInformationMessage(`${skippedCount} item(s) were skipped (duplicates, exclusions, or errors).`);
            }
            this.refresh(); // Refresh view regardless of outcome
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
    sessionManager.loadSessions(); // Load persisted sessions, handles migration
    fileIntegratorProvider = new FileIntegratorProvider(sessionManager);
    treeView = vscode.window.createTreeView('fileIntegratorView', {
        treeDataProvider: fileIntegratorProvider,
        dragAndDropController: fileIntegratorProvider, // Enable drag/drop functionality
        showCollapseAll: true, // Add collapse all button to view
        canSelectMany: true // Allow multi-select in the tree
    });
    context.subscriptions.push(treeView);
    registerCommands(context); // Register all commands
    // Ensure session manager cleans up on extension deactivation
    context.subscriptions.push({ dispose: () => sessionManager.dispose() });
    console.log('File Integrator activated.');
}
// --- Command Registration ---
function registerCommands(context) {
    // Helper to simplify command registration
    const register = (commandId, callback) => {
        context.subscriptions.push(vscode.commands.registerCommand(commandId, callback));
    };
    // Command: Add New Session
    register('fileintegrator.addSession', async () => {
        const n = await vscode.window.showInputBox({ prompt: "Enter new session name", value: `Session ${sessionManager.getAllSessions().length + 1}` });
        if (n && n.trim()) {
            const s = sessionManager.createSession(n.trim());
            fileIntegratorProvider.refresh();
            // Reveal and select the new session in the tree
            treeView.reveal(new SessionItem(s), { select: true, focus: true, expand: true });
        }
    });
    // Command: Remove Session (takes optional SessionItem from context menu)
    register('fileintegrator.removeSession', async (item) => {
        // If triggered without context, prompt user to select session
        const s = item?.session ?? await selectSession('Select session to remove');
        if (!s)
            return;
        const c = await vscode.window.showWarningMessage(`Remove session "${s.name}"?`, { modal: true }, 'Yes', 'No');
        if (c === 'Yes') {
            await s.closeAssociatedDocument(true); // Try to close the generated doc editor
            if (sessionManager.removeSession(s.id)) {
                fileIntegratorProvider.refresh();
            }
        }
    });
    // Command: Rename Session (takes optional SessionItem from context menu)
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
    // Command: Clear All Items from Session (takes optional SessionItem from context menu)
    register('fileintegrator.clearSession', async (item) => {
        const s = item?.session ?? await selectSession('Select session to clear');
        if (!s)
            return;
        if (s.storage.files.length === 0) {
            vscode.window.showInformationMessage(`Session "${s.name}" is already empty.`);
            return;
        }
        console.log(`[ClearSession] Clearing session "${s.name}" (ID: ${s.id})`);
        s.storage.clearFiles(); // Clears the session's storage array
        sessionManager.persistSessions(); // Save the now-empty session
        fileIntegratorProvider.refresh();
        await updateCodeBlockDocument(s); // Update the associated doc (will show empty state)
    });
    // Command: Generate/Show Code Block Document (takes optional SessionItem from context menu)
    register('fileintegrator.generateCodeBlock', async (item) => {
        const s = item?.session ?? await selectSession('Select session to generate code block for');
        if (!s)
            return;
        if (s.storage.resourcesOnly.length === 0) {
            vscode.window.showInformationMessage(`Session "${s.name}" contains no file/resource content.`);
            return;
        }
        // showCodeBlockDocument handles creating/updating and linking the document
        const doc = await showCodeBlockDocument(s);
        if (doc) {
            // Show the generated/updated document to the user
            await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
        }
    });
    // Command: Copy Generated Content to Clipboard (takes optional SessionItem from context menu)
    register('fileintegrator.copyToClipboard', async (item) => {
        const s = item?.session ?? await selectSession('Select session to copy content from');
        if (!s)
            return;
        if (s.storage.resourcesOnly.length === 0) {
            vscode.window.showInformationMessage(`Session "${s.name}" contains no file/resource content to copy.`);
            return;
        }
        let contentToCopy;
        // Prefer content directly from the associated document if it's open
        if (s.associatedDocument && !s.associatedDocument.isClosed) {
            contentToCopy = s.associatedDocument.getText();
        }
        else {
            // Otherwise, generate the content on the fly
            contentToCopy = await generateMarkdownContent(s);
        }
        // Check if content was actually generated/retrieved before copying
        if (contentToCopy && !contentToCopy.startsWith('<!-- No file/resource content')) {
            await vscode.env.clipboard.writeText(contentToCopy);
            vscode.window.showInformationMessage(`Session "${s.name}" content copied to clipboard!`);
        }
        else {
            vscode.window.showWarningMessage("No content was generated or found to copy.");
        }
    });
    // Command: Remove Single Item (triggered only from ResourceItem context menu)
    register('fileintegrator.removeItem', async (item) => {
        // Guard against incorrect context
        if (!item || !(item instanceof ResourceItem))
            return;
        const s = sessionManager.getSession(item.sessionId);
        if (s) {
            // removeEntry handles recursive removal of children
            if (s.storage.removeEntry(item.uriString)) {
                sessionManager.persistSessions();
                await updateCodeBlockDocument(s); // Update associated doc
                fileIntegratorProvider.refresh();
            }
            else {
                fileIntegratorProvider.refresh(); // Refresh even if removal failed (shouldn't normally)
            }
        }
    });
    // Command: Refresh Tree View
    register('fileintegrator.refreshView', () => {
        fileIntegratorProvider.refresh();
    });
    // Command: Add Active Editor to Session (takes optional SessionItem from context menu)
    register('fileintegrator.addActiveEditorToSession', async (item) => {
        const targetSession = item?.session ?? await selectSession("Select session to add active editor to");
        if (!targetSession)
            return;
        await addActiveEditorLogic(targetSession);
    });
    // Command: Add All Open Editors to Session (triggered only from SessionItem context menu)
    register('fileintegrator.addAllOpenEditorsToSession', async (item) => {
        // This command is now triggered via context menu, so 'item' should be the SessionItem
        if (!item || !(item instanceof SessionItem)) {
            // If somehow triggered without context, fallback or error
            const session = await selectSession("Select session to add all open editors to");
            if (!session)
                return;
            await addAllOpenEditorsLogic(session); // Call helper with selected session
            return;
        }
        await addAllOpenEditorsLogic(item.session); // Call helper with the session from context
    });
}
// --- Command Logic Helpers ---
/** Logic for adding the active editor's resource to a session. */
async function addActiveEditorLogic(targetSession) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage("No active editor found to add.");
        return;
    }
    const document = editor.document;
    const uri = document.uri;
    const uriString = uri.toString();
    // Prevent adding the session's own generated document
    if (document === targetSession.associatedDocument) {
        vscode.window.showInformationMessage("Cannot add the generated session document to itself.");
        return;
    }
    // Check if already present
    if (targetSession.storage.findEntry(uriString)) {
        vscode.window.showInformationMessage(`"${getDisplayUri(uriString, 'treeDescription')}" is already in session "${targetSession.name}".`);
        return;
    }
    console.log(`[AddActiveEditor] Adding ${uriString} to session ${targetSession.name}`);
    const newEntry = {
        uriString: uriString,
        isDirectory: false, // Active editor represents a single resource
        content: null, // Content loaded on demand
        parentUriString: undefined, // Add to root
        sessionId: targetSession.id,
    };
    if (targetSession.storage.addItem(newEntry)) {
        sessionManager.persistSessions();
        await updateCodeBlockDocument(targetSession);
        // Refresh the specific session node if possible, otherwise full refresh
        fileIntegratorProvider.refresh(); // Full refresh is simpler for now
    }
    else {
        vscode.window.showWarningMessage(`Failed to add "${getDisplayUri(uriString)}" (perhaps already added?).`);
    }
}
/** Logic for adding all unique open editor resources to a session. */
async function addAllOpenEditorsLogic(targetSession) {
    const openUris = new Set();
    const sessionDocUriString = targetSession.associatedDocument?.uri.toString();
    // Collect unique URIs from all open tabs, excluding the target session's doc
    for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
            // The tab.input object structure varies, try to get 'uri'
            const uri = tab.input?.uri;
            if (uri instanceof vscode.Uri) {
                const uriString = uri.toString();
                if (uriString !== sessionDocUriString) {
                    openUris.add(uriString);
                }
            }
        }
    }
    if (openUris.size === 0) {
        vscode.window.showInformationMessage("No suitable open editors found to add (excluding the session document).");
        return;
    }
    let addedCount = 0;
    let skippedCount = 0;
    // Add each unique URI if not already present in the session
    for (const uriString of openUris) {
        if (targetSession.storage.findEntry(uriString)) {
            skippedCount++;
        }
        else {
            console.log(`[AddAllOpen] Adding ${uriString} to session ${targetSession.name}`);
            const newEntry = {
                uriString: uriString,
                isDirectory: false,
                content: null,
                parentUriString: undefined,
                sessionId: targetSession.id,
            };
            if (targetSession.storage.addItem(newEntry)) {
                addedCount++;
            }
        }
    }
    // Report results and update state if changes occurred
    if (addedCount > 0) {
        sessionManager.persistSessions();
        await updateCodeBlockDocument(targetSession);
        fileIntegratorProvider.refresh(); // Refresh the view
        let message = `Added ${addedCount} unique open editor(s) to session "${targetSession.name}".`;
        if (skippedCount > 0) {
            message += ` Skipped ${skippedCount} item(s) (already present or session doc).`;
        }
        vscode.window.showInformationMessage(message);
    }
    else if (skippedCount > 0) {
        vscode.window.showInformationMessage(`All open editors were already present or skipped in session "${targetSession.name}".`);
    }
    else {
        vscode.window.showInformationMessage("No new editors were added.");
    }
}
// --- Deactivation ---
function deactivate() {
    console.log('Deactivating File Integrator...');
    // Dispose SessionManager (which disposes individual sessions) if needed,
    // but subscriptions handle this automatically via context.subscriptions.push({ dispose: ... })
}
// --- Utility Functions ---
/** Checks if a file system path matches exclusion patterns from settings. */
function isPathExcluded(filePath) {
    const config = vscode.workspace.getConfiguration('fileintegrator');
    const excludePatterns = config.get('exclude');
    if (!excludePatterns)
        return false;
    // Normalize path separators for consistent matching
    const normalizedFilePath = filePath.replace(/\\/g, '/');
    const workspaceFolders = vscode.workspace.workspaceFolders;
    for (const pattern in excludePatterns) {
        if (excludePatterns[pattern]) { // Only check patterns set to true
            const normalizedPattern = pattern.replace(/\\/g, '/');
            // Options for minimatch: dot allows matching hidden files, nocase for Windows
            const options = { dot: true, nocase: process.platform === 'win32' };
            // Direct match against the full normalized path
            if ((0, minimatch_1.minimatch)(normalizedFilePath, normalizedPattern, options))
                return true;
            // Check relative path within workspace folders
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
            // Check basename match if pattern doesn't contain a separator (e.g., "node_modules")
            if (!normalizedPattern.includes('/')) {
                if ((0, minimatch_1.minimatch)(path.basename(normalizedFilePath), normalizedPattern, options))
                    return true;
            }
        }
    }
    return false; // Not excluded by any pattern
}
/** Prompts user to select a session via Quick Pick. Returns undefined if cancelled. */
async function selectSession(placeHolder) {
    const sessions = sessionManager.getAllSessions();
    if (sessions.length === 0) {
        vscode.window.showErrorMessage("No sessions available.");
        return undefined;
    }
    // If only one session exists, return it directly
    if (sessions.length === 1)
        return sessions[0];
    // Map sessions to QuickPick items
    const picks = sessions.map(s => ({ label: s.name, description: `(${s.storage.files.length} items)`, session: s }));
    const selection = await vscode.window.showQuickPick(picks, { placeHolder, canPickMany: false });
    return selection?.session; // Return the session object from the selected pick
}
/**
 * Generates aggregated Markdown content for a session, respecting order.
 * Reads resource content asynchronously using VS Code API if not already loaded.
 */
async function generateMarkdownContent(session) {
    let content = '';
    // Get only non-directory entries in their current order
    const resourceEntries = session.storage.files.filter(f => !f.isDirectory);
    if (resourceEntries.length === 0) {
        return `<!-- No file/resource content in session "${session.name}" -->\n`;
    }
    console.log(`[MarkdownGen] Generating content for ${resourceEntries.length} resources in session ${session.id}`);
    for (const entry of resourceEntries) {
        let resourceContent = entry.content;
        // Load content via VS Code API if it wasn't read initially or loaded from persistence
        if (resourceContent === null) {
            const uri = vscode.Uri.parse(entry.uriString);
            try {
                console.log(`[MarkdownGen] Reading content for URI: ${entry.uriString}`);
                // openTextDocument works for various schemes (file:, untitled:, jar:, etc.)
                const doc = await vscode.workspace.openTextDocument(uri);
                resourceContent = doc.getText();
                // Consider caching content back to entry.content? Might increase memory usage.
                // entry.content = resourceContent;
            }
            catch (error) {
                console.error(`[MarkdownGen] Error reading URI ${entry.uriString}:`, error);
                const displayUri = getDisplayUri(entry.uriString);
                // Provide specific error messages for common cases
                if (error?.code === 'FileNotFound' || error?.code === 'EntryNotFound') {
                    resourceContent = `--- Error: Resource not found (${displayUri}) ---`;
                    vscode.window.showWarningMessage(`Resource not found: ${displayUri}`);
                }
                else {
                    resourceContent = `--- Error reading content for ${displayUri}: ${error.message} ---`;
                    vscode.window.showWarningMessage(`Could not read content for: ${displayUri}`);
                }
            }
        }
        // Get display URI for the header and determine language for code block
        const displayUri = getDisplayUri(entry.uriString, 'markdownHeader');
        const uriPath = vscode.Uri.parse(entry.uriString).path;
        // Extract part after the last '!/' for archives, otherwise use full path
        const langPart = uriPath.includes('!/') ? uriPath.substring(uriPath.lastIndexOf('!/') + 1) : uriPath;
        const ext = path.extname(langPart);
        const lang = ext ? ext.substring(1) : ''; // Get extension without dot
        content += `${displayUri}\n\`\`\`${lang}\n`;
        content += resourceContent ?? `--- Content Unavailable ---`; // Fallback message
        content += `\n\`\`\`\n\n`;
    }
    return content.trimEnd(); // Remove trailing whitespace
}
/**
 * Ensures the code block document for a session is visible and up-to-date.
 * Creates the document if it doesn't exist, updates it if it does.
 * Returns the TextDocument or undefined on failure.
 */
async function showCodeBlockDocument(session) {
    const content = await generateMarkdownContent(session);
    // If associated document exists and is open, update it in place
    if (session.associatedDocument && !session.associatedDocument.isClosed) {
        const doc = session.associatedDocument;
        try {
            const edit = new vscode.WorkspaceEdit();
            // Replace the entire document content
            edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), content);
            const success = await vscode.workspace.applyEdit(edit);
            if (!success)
                throw new Error("ApplyEdit failed");
            console.log(`[ShowDoc] Updated associated document for session ${session.id}`);
            return doc;
        }
        catch (e) {
            console.error(`[ShowDoc] Error updating associated doc ${doc.uri}:`, e);
            // If update fails, detach the old link and attempt to create a new doc as fallback
            await session.closeAssociatedDocument(false); // Detach only
            return createNewAssociatedDocument(session, content);
        }
    }
    // If no associated document, create a new one
    return createNewAssociatedDocument(session, content);
}
/** Helper function solely for creating a new associated Markdown document. */
async function createNewAssociatedDocument(session, content) {
    try {
        console.log(`[ShowDoc] Creating new associated document for session ${session.id}`);
        // Open an untitled document with the generated content and Markdown language mode
        const doc = await vscode.workspace.openTextDocument({ content: content, language: 'markdown' });
        session.setAssociatedDocument(doc); // Link the session to the new document
        return doc;
    }
    catch (e) {
        console.error(`[ShowDoc] Failed to create associated document:`, e);
        vscode.window.showErrorMessage(`Failed to create associated document: ${e.message}`);
        session.closeAssociatedDocument(false); // Ensure link is cleared on failure
        return undefined;
    }
}
/** Updates the associated document content *if* it exists and is open, without showing it. */
async function updateCodeBlockDocument(session) {
    // Only proceed if the document link exists and the document hasn't been closed by the user
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
                session.closeAssociatedDocument(false); // Detach link if update fails
            }
            else {
                console.log(`[UpdateDoc] Successfully updated associated document.`);
            }
        }
        catch (err) {
            console.error(`[UpdateDoc] Error applying edit to ${doc.uri}:`, err);
            session.closeAssociatedDocument(false); // Detach link on error
            vscode.window.showErrorMessage("Error updating associated code block document.");
        }
    }
}
/**
 * Generates a display-friendly string for a URI, handling various schemes and shortening.
 * @param type Controls formatting detail ('treeDescription' is shortest).
 */
function getDisplayUri(uriString, type = 'markdownHeader') {
    try {
        const uri = vscode.Uri.parse(uriString);
        const scheme = uri.scheme;
        const uriPath = uri.path;
        // --- Handle Archive URIs (jar:, or file:...!) ---
        const bangIndex = uriPath.lastIndexOf('!/'); // Find the last separator
        if ((scheme === 'jar' || scheme === 'file') && bangIndex !== -1) {
            let archivePart = '';
            let internalPath = uriPath.substring(bangIndex + 1); // Path inside archive
            let archiveName = 'archive';
            if (scheme === 'jar') {
                // jar:file:/path/to/archive.jar!/internal/path
                archivePart = uriPath.substring(0, bangIndex); // Includes scheme etc.
                try {
                    archiveName = path.basename(vscode.Uri.parse(archivePart).path);
                }
                catch { /* Use default */ }
            }
            else { // scheme === 'file'
                // file:/path/to/archive.zip!/internal/path
                // fsPath might be more reliable for the outer file path
                archivePart = uri.fsPath;
                const fsBangIndex = archivePart.lastIndexOf('!');
                archiveName = path.basename(fsBangIndex !== -1 ? archivePart.substring(0, fsBangIndex) : archivePart);
            }
            // Clean internal path and format output
            const displayInternalPath = (internalPath.startsWith('/') ? internalPath.substring(1) : internalPath).replace(/\\/g, '/');
            const fullDisplay = `${archiveName}!/${displayInternalPath}`;
            if (type === 'treeDescription') {
                // Shorten both parts for tree view label
                const shortArchive = archiveName.length > 15 ? archiveName.substring(0, 6) + '...' + archiveName.slice(-6) : archiveName;
                const shortInternal = displayInternalPath.length > 20 ? '.../' + displayInternalPath.slice(-17) : displayInternalPath;
                return `${shortArchive}!/${shortInternal}`; // No parentheses for label
            }
            else {
                return fullDisplay; // Longer version for tooltip/header
            }
        }
        // --- Handle Standard File URIs ---
        else if (scheme === 'file') {
            // Use helper to get potentially relative path
            return getDisplayPath(uri.fsPath, type === 'treeDescription');
        }
        // --- Handle Other Schemes (untitled, git, http, etc.) ---
        else {
            let displayPath = uri.fsPath || uri.path; // Prefer fsPath if available
            // Basic path cleanup
            if (uri.authority && displayPath.startsWith('/' + uri.authority)) {
                displayPath = displayPath.substring(uri.authority.length + 1);
            }
            if (displayPath.startsWith('/'))
                displayPath = displayPath.substring(1);
            // Format like scheme:<authority>//<path>
            const authority = uri.authority ? `//${uri.authority}/` : (uri.scheme === 'untitled' ? '' : '//');
            const fullDisplay = `${scheme}:${authority}${displayPath}`;
            if (type === 'treeDescription') {
                // Shorten reasonably for tree label
                const maxLength = 45;
                if (fullDisplay.length > maxLength) {
                    return fullDisplay.substring(0, scheme.length + 1) + '...' + fullDisplay.substring(fullDisplay.length - (maxLength - scheme.length - 4));
                }
            }
            // Return full display for tooltips/headers or if short enough
            return fullDisplay;
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
/** Generates display path for file system URIs, preferring relative paths. */
function getDisplayPath(filePath, short = false) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    let relativePath;
    // Try to find the workspace folder containing the file path
    if (workspaceFolders) {
        // Sort folders by length descending to match deepest containing folder first
        const sortedFolders = [...workspaceFolders].sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length);
        for (const folder of sortedFolders) {
            const folderPath = folder.uri.fsPath;
            // Use path.relative which handles path separators and case sensitivity correctly
            const rel = path.relative(folderPath, filePath);
            // If path.relative doesn't start with '..', it's inside the folder or is the folder itself
            if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
                relativePath = rel;
                // If the path *is* the workspace folder path, rel will be empty. Use basename.
                if (relativePath === '') {
                    relativePath = path.basename(folderPath);
                }
                // Add workspace folder name prefix only if 'short' (treeDescription) is requested
                // and there are multiple roots, to disambiguate.
                else if (workspaceFolders.length > 1 && short) {
                    relativePath = `${path.basename(folderPath)}/${relativePath}`;
                }
                break; // Found the containing folder
            }
        }
    }
    // Use relative path if found
    if (relativePath) {
        const display = relativePath.replace(/\\/g, '/'); // Use forward slashes
        if (short && display.length > 40) {
            const parts = display.split('/');
            if (parts.length > 2) {
                // Show first part (folder?) / ... / last part (file)
                return parts[0] + '/.../' + parts[parts.length - 1];
            }
        }
        return display;
    }
    else {
        // Fallback: Show shortened absolute path for non-workspace files
        const pathParts = filePath.split(/[\\/]/).filter(Boolean);
        const partsCount = pathParts.length;
        if (short && partsCount > 3) {
            return '...' + path.sep + pathParts.slice(-2).join(path.sep); // ".../dir/file"
        }
        else if (!short && partsCount > 4) {
            return '...' + path.sep + pathParts.slice(-3).join(path.sep); // ".../dir1/dir2/file"
        }
        else if (partsCount > 0) {
            return filePath; // Return full absolute path if short
        }
        else {
            return filePath; // Should not happen for valid paths
        }
    }
}
//# sourceMappingURL=extension.js.map