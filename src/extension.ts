import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';
import { v4 as uuidv4 } from 'uuid';
import { minimatch } from 'minimatch';

// Import Git API Types (Ensure src/api/git.d.ts has SourceControlHistoryItem import removed if needed for your vscode version)
import { GitExtension, API as GitAPI, Repository as GitRepository } from './api/git';

// --- Core Data Structures ---

interface FileEntry {
    uriString: string;   // vscode.Uri.toString()
    isDirectory: boolean;
    content: string | null; // Loaded on demand
    parentUriString?: string; // For hierarchy
    sessionId: string;
}

// Structure for persisting file metadata (order is preserved)
interface PersistedFileEntry {
    uri: string;
    isDirectory: boolean;
    parentUri?: string;
}

// Structure for persisting session metadata
interface PersistedSession {
    id: string;
    name: string;
    files: PersistedFileEntry[];
}

/**
 * Manages resource storage for a single session, preserving order.
 * Uses URI strings as primary identifiers.
 */
class SessionResourceStorage {
    private _files: FileEntry[] = [];
    public readonly sessionId: string;

    constructor(sessionId: string) {
        this.sessionId = sessionId;
    }

    get files(): readonly FileEntry[] {
        return this._files;
    }

    // Filter for non-directories
    get resourcesOnly(): { uriString: string; content: string | null }[] {
        return this._files.filter(f => !f.isDirectory).map(f => ({ uriString: f.uriString, content: f.content }));
    }

    findEntry(uriString: string): FileEntry | undefined {
        return this._files.find(f => f.uriString === uriString);
    }

    /** Adds a pre-constructed FileEntry. Returns true if added, false if duplicate. */
    addItem(entry: FileEntry): boolean {
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
    async addResource(uri: vscode.Uri, parentUri?: vscode.Uri): Promise<boolean> {
        const uriString = uri.toString();
        const parentUriString = parentUri?.toString();

        if (this._files.some(f => f.uriString === uriString)) {
            return false; // Duplicate
        }

        let isDirectory = false;
        let content: string | null = null;
        let canRecurse = false;

        try {
            // Attempt to stat standard file URIs (not inside archives)
            if (uri.scheme === 'file' && !uri.path.includes('!/')) {
                const stats = await fs.stat(uri.fsPath);
                isDirectory = stats.isDirectory();
                canRecurse = isDirectory;
                if (!isDirectory) {
                    try {
                        // Don't read large files initially
                        if (stats.size < 1 * 1024 * 1024) { // e.g., < 1MB
                           content = await fs.readFile(uri.fsPath, 'utf8');
                        } else {
                            console.warn(`[Storage:addResource] File too large for initial read, load on demand: ${uri.fsPath}`);
                            content = null; // Load on demand
                        }
                    } catch (readErr: any) {
                        console.warn(`[Storage:addResource] Failed initial read ${uri.fsPath}: ${readErr.message}`);
                        content = null; // Load on demand
                    }
                }
            } else {
                // Assume non-file URIs (jar:, untitled:, etc.) or archives are single resources
                isDirectory = false;
                canRecurse = false;
                // Content will be loaded on demand via vscode.workspace.openTextDocument
            }
        } catch (statError: any) {
             if (statError.code === 'ENOENT') {
                 console.warn(`[Storage:addResource] Resource not found: ${uriString}`);
                 vscode.window.showWarningMessage(`Item not found: ${getDisplayUri(uriString)}`);
             } else {
                console.error(`[Storage:addResource] Error processing URI ${uriString}:`, statError);
                vscode.window.showErrorMessage(`Error adding ${getDisplayUri(uriString)}: ${statError.message}`);
             }
            return false; // Cannot add
        }

        const entry: FileEntry = {
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
                const processingPromises: Promise<boolean>[] = [];

                for (const dirEntry of dirEntries) {
                    const childPath = path.join(uri.fsPath, dirEntry.name);
                    const childUri = vscode.Uri.file(childPath);

                    // Check exclusion based on file system path BEFORE recursive call
                    if (!isPathExcluded(childPath)) {
                        processingPromises.push(this.addResource(childUri, uri)); // Pass current URI as parent
                    } else {
                        console.log(`[Exclude][AddDir] Skipping excluded: ${childPath}`);
                    }
                }
                await Promise.all(processingPromises);
            } catch (readDirError: any) {
                console.error(`[Storage:addResource] Error reading directory ${uri.fsPath}:`, readDirError);
                // Don't necessarily fail the whole add operation if a subdirectory fails
                // return false;
            }
        }
        return true; // Added successfully (or partially if subdir failed)
    }

    /** Removes entry and its descendants recursively. */
    removeEntry(uriStringToRemove: string): boolean {
        const initialLength = this._files.length;
        const entryToRemove = this.findEntry(uriStringToRemove);
        if (!entryToRemove) return false;

        const removedUris = new Set<string>();
        const queue: string[] = [uriStringToRemove];

        // Find all descendant URIs using parentUriString links
        while (queue.length > 0) {
            const currentUri = queue.shift()!;
            if (removedUris.has(currentUri)) continue;
            removedUris.add(currentUri);
            // Find children based on parentUriString link
            this._files.forEach(f => {
                if (f.parentUriString === currentUri) {
                    queue.push(f.uriString);
                }
            });
        }

        this._files = this._files.filter(f => !removedUris.has(f.uriString));
        return this._files.length < initialLength;
    }

    clearFiles(): number {
        const count = this._files.length;
        this._files = [];
        return count;
    }

    /** Restores the file list from persisted data. */
    restoreFiles(restoredFiles: FileEntry[]): void {
        this._files = restoredFiles;
        console.log(`[Storage:restore] Restored ${this._files.length} items for session ${this.sessionId}`);
    }

    /** Reorders items within the same parent based on URI strings. */
    reorderItems(draggedUriStrings: string[], targetUriString?: string, dropOnSession: boolean = false): boolean {
        console.log(`[Storage:reorder] Dragged: ${draggedUriStrings.length}, Target: ${targetUriString}, OnSession: ${dropOnSession}`);

        const draggedEntries: FileEntry[] = [];
        for (const draggedUri of draggedUriStrings) {
            const entry = this.findEntry(draggedUri);
            if (!entry) {
                console.error(`[Storage:reorder] Dragged entry not found: ${draggedUri}`);
                return false;
            }
            draggedEntries.push(entry);
        }
        if (draggedEntries.length === 0) return false;

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
            if (index > -1) this._files.splice(index, 1);
        });

        // Determine insertion index
        let targetIndex = -1;
        if (dropOnSession) {
            // Dropped onto the session node: Insert at the beginning of root items
            targetIndex = this._files.findIndex(f => f.parentUriString === undefined);
            if (targetIndex === -1) targetIndex = this._files.length; // If no root items, insert at end
        } else if (targetUriString) {
            // Dropped onto another item: Insert *before* that item
            targetIndex = this._files.findIndex(f => f.uriString === targetUriString);
            if (targetIndex === -1) {
                console.error(`[Storage:reorder] Target URI not found after removal: ${targetUriString}`);
                // Fallback: Put back at end
                this._files.push(...draggedEntries);
                return false;
            }
        } else {
            // Dropped in empty space within a parent group: Insert at the end of that group
            const parentUri = firstParentUri; // The parent of the items being dragged
            let lastIndexOfParentGroup = -1;
            for(let i = this._files.length - 1; i >= 0; i--) {
                if (this._files[i].parentUriString === parentUri) {
                    lastIndexOfParentGroup = i;
                    break;
                }
            }
            // Insert after the last item of the group
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
    public readonly id: string;
    public name: string;
    public readonly storage: SessionResourceStorage;
    public associatedDocument: vscode.TextDocument | null = null;
    private docCloseListener: vscode.Disposable | null = null;

    constructor(name: string, id: string = uuidv4()) {
        this.id = id;
        this.name = name;
        this.storage = new SessionResourceStorage(this.id);
    }

    dispose() {
        this.closeAssociatedDocument(false); // Detach listener, clear link
        this.storage.clearFiles();
    }

    setAssociatedDocument(doc: vscode.TextDocument) {
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

    async closeAssociatedDocument(attemptEditorClose: boolean = true): Promise<void> {
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
                    } catch (err) {
                        console.error(`[Session ${this.id}] Error closing editor:`, err);
                    }
                }
            }
        }
    }
}

// --- Session Manager Class ---
class SessionManager {
    private sessions: Map<string, Session> = new Map();
    // Storage key includes version for migration purposes
    private static readonly STORAGE_KEY = 'fileIntegratorSessions_v3';
    private static readonly OLD_STORAGE_KEY_V2 = 'fileIntegratorSessions_v2';
    private static readonly OLD_STORAGE_KEY_V1 = 'fileIntegratorSessions';

    constructor(private context: vscode.ExtensionContext) {}

    createSession(name?: string): Session {
        const sessionName = name || `Session ${this.sessions.size + 1}`;
        const newSession = new Session(sessionName);
        this.sessions.set(newSession.id, newSession);
        this.persistSessions();
        return newSession;
    }

    getSession(id: string): Session | undefined {
        return this.sessions.get(id);
    }

    getAllSessions(): Session[] {
        return Array.from(this.sessions.values()).sort((a, b) => a.name.localeCompare(b.name));
    }

    removeSession(id: string): boolean {
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

    renameSession(id: string, newName: string): boolean {
        const session = this.sessions.get(id);
        if(session) {
            session.name = newName;
            this.persistSessions();
            return true;
        }
        return false;
    }

    /** Saves all sessions and their file metadata (URIs, hierarchy) to workspace state. */
    persistSessions() {
        try {
            const persistedData: PersistedSession[] = this.getAllSessions().map(session => {
                const persistedFiles: PersistedFileEntry[] = session.storage.files.map(entry => ({
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

        } catch (e) {
            console.error("[Persist] Error saving session data:", e);
            vscode.window.showErrorMessage("Error saving File Integrator session data.");
        }
    }

    /** Loads sessions from workspace state, handling migration from older formats. */
    loadSessions() {
        this.sessions.clear();
        let loadedData: any[] | undefined = undefined;
        let loadedFromOldKey = false;

        try {
            // Try loading from the newest key first
            loadedData = this.context.workspaceState.get<PersistedSession[]>(SessionManager.STORAGE_KEY);

            // Migration from V2 (path-based) if V3 not found
            if (!loadedData) {
                const oldDataV2 = this.context.workspaceState.get<PersistedSession[]>(SessionManager.OLD_STORAGE_KEY_V2);
                 if (oldDataV2 && oldDataV2.length > 0) {
                    console.log("[Load] Migrating data from V2 storage key (path -> uri).");
                    loadedData = oldDataV2.map(metaV2 => ({
                        id: metaV2.id,
                        name: metaV2.name,
                        // Convert PersistedFileEntry (path-based) to PersistedFileEntry (uri-based)
                        files: metaV2.files
                            .map((pfV2: any) => { // Use 'any' for old structure flexibility
                                if (!pfV2 || typeof pfV2.path !== 'string') return null;
                                try {
                                    // Assume old paths were file system paths
                                    const fileUri = vscode.Uri.file(pfV2.path);
                                    const parentUri = pfV2.parent ? vscode.Uri.file(pfV2.parent) : undefined;
                                    return {
                                        uri: fileUri.toString(),
                                        isDirectory: !!pfV2.isDirectory,
                                        parentUri: parentUri?.toString()
                                    };
                                } catch (e) {
                                    console.warn(`[Load Migration V2] Error converting path ${pfV2.path} to URI:`, e);
                                    return null;
                                }
                            })
                            .filter(pf => pf !== null) as PersistedFileEntry[]
                    }));
                    loadedFromOldKey = true;
                 }
            }

            // Migration from V1 (basic name/id) if V2/V3 not found
            if (!loadedData) {
                const oldDataV1 = this.context.workspaceState.get<{ id: string, name: string }[]>(SessionManager.OLD_STORAGE_KEY_V1);
                if (oldDataV1 && oldDataV1.length > 0) {
                    console.log("[Load] Migrating data from V1 storage key (basic).");
                    loadedData = oldDataV1.map(metaV1 => ({
                        id: metaV1.id,
                        name: metaV1.name,
                        files: [] // Initialize with empty files
                    }));
                    loadedFromOldKey = true;
                } else {
                    loadedData = []; // No data found anywhere
                }
            }

            // Process the loaded (and potentially migrated) data
            (loadedData as PersistedSession[]).forEach(meta => {
                if (!meta || typeof meta.id !== 'string' || typeof meta.name !== 'string' || !Array.isArray(meta.files)) {
                    console.warn("[Load] Skipping invalid session metadata entry:", meta);
                    return;
                }

                const session = new Session(meta.name, meta.id);
                const restoredFiles: FileEntry[] = meta.files
                    .map((pf): FileEntry | null => {
                        if (!pf || typeof pf.uri !== 'string' || typeof pf.isDirectory !== 'boolean') {
                            console.warn(`[Load] Skipping invalid persisted file entry in session ${meta.id}:`, pf);
                            return null;
                        }
                        try {
                            // Validate URI can be parsed
                            vscode.Uri.parse(pf.uri);
                            if (pf.parentUri) vscode.Uri.parse(pf.parentUri);

                            return {
                                uriString: pf.uri,
                                isDirectory: pf.isDirectory,
                                parentUriString: pf.parentUri,
                                content: null, // Content is never persisted, loaded on demand
                                sessionId: session.id,
                            };
                        } catch (e) {
                            console.warn(`[Load] Skipping entry with invalid URI in session ${meta.id}:`, pf.uri, e);
                            return null;
                        }
                    })
                    .filter((entry): entry is FileEntry => entry !== null); // Filter out nulls from mapping

                session.storage.restoreFiles(restoredFiles);
                this.sessions.set(session.id, session);
            });

            console.log(`[Load] Loaded ${this.sessions.size} sessions.`);
            // If migrated from an older format, save immediately in the new format
            if (loadedFromOldKey) {
                this.persistSessions();
            }

        } catch (e) {
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


// --- Tree View Items ---

type IntegratorTreeItem = SessionItem | ResourceItem;

// Represents a Session in the Tree View
class SessionItem extends vscode.TreeItem {
    constructor(
        public readonly session: Session,
        collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Collapsed
    ) {
        super(session.name, collapsibleState);
        this.id = session.id;
        this.contextValue = 'session'; // Used for context menu targeting
        this.iconPath = new vscode.ThemeIcon('folder-library');
        this.tooltip = `Session: ${session.name}`;
        this.description = `(${session.storage.files.length} items)`;
    }
}

// Represents a FileEntry (file, directory, or other resource) in the Tree View
class ResourceItem extends vscode.TreeItem {
    constructor(
        public readonly entry: FileEntry,
        collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        const uri = vscode.Uri.parse(entry.uriString);
        let label = ''; // This will be just the base name

        // Extract Base Name for Label
        const uriPath = uri.path;
        const bangIndex = uri.toString().lastIndexOf('!/'); // Use toString() to reliably find !/

        if (bangIndex !== -1) {
            const fullUriStr = uri.toString();
            const internalPath = fullUriStr.substring(bangIndex + 1);
            label = path.basename(internalPath.startsWith('/') ? internalPath.substring(1) : internalPath);
        } else {
            // Standard path (file:, untitled:, git:, etc.)
             label = path.basename(uriPath);
        }

        // Handle cases where basename might be empty or unhelpful
        if (!label && uri.scheme !== 'file') {
            label = uri.toString().substring(uri.scheme.length + 1);
            if (label.startsWith('//')) label = label.substring(2);
        }
        if (!label) label = entry.uriString; // Fallback to full URI string

        // Initialize TreeItem
        super(label, collapsibleState);

        // Set Other Properties
        this.id = `${entry.sessionId}::${entry.uriString}`;
        this.resourceUri = uri;

        if (!entry.isDirectory) {
            this.command = {
                command: 'vscode.open',
                title: "Open Resource",
                arguments: [uri]
            };
            this.collapsibleState = vscode.TreeItemCollapsibleState.None;
        }

        // Update Tooltips for Clarity
        if (entry.isDirectory) {
             this.tooltip = `Directory (Git Diff applies to tracked files within):\n${getDisplayUri(entry.uriString, 'tooltip')}`;
        } else {
             this.tooltip = `Resource (Git Diff applies if tracked):\n${getDisplayUri(entry.uriString, 'tooltip')}`;
        }

        this.description = getDisplayUri(entry.uriString, 'treeDescription');
        this.contextValue = entry.isDirectory ? 'resourceDirectory' : 'resourceFile';
        this.iconPath = entry.isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    }

    // Convenience getters
    get sessionId(): string { return this.entry.sessionId; }
    get uriString(): string { return this.entry.uriString; }
    get isDirectory(): boolean { return this.entry.isDirectory; }
}

// --- Tree Data Provider ---

class FileIntegratorProvider implements vscode.TreeDataProvider<IntegratorTreeItem>, vscode.TreeDragAndDropController<IntegratorTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<IntegratorTreeItem | undefined | null | void> = new vscode.EventEmitter();
    readonly onDidChangeTreeData: vscode.Event<IntegratorTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    // Declare supported MIME types for drag and drop
    readonly dropMimeTypes = ['text/uri-list', 'application/vnd.code.tree.fileIntegratorView'];
    readonly dragMimeTypes = ['application/vnd.code.tree.fileIntegratorView'];
    private readonly customMimeType = 'application/vnd.code.tree.fileIntegratorView';

    constructor(private sessionManager: SessionManager) {}

    getTreeItem(element: IntegratorTreeItem): vscode.TreeItem { return element; }

    getChildren(element?: IntegratorTreeItem): vscode.ProviderResult<IntegratorTreeItem[]> {
        if (!element) {
            // Root level: Show all sessions
            return Promise.resolve(
                this.sessionManager.getAllSessions().map(s => new SessionItem(s,
                    s.storage.files.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
                ))
            );
        }
        if (element instanceof SessionItem) {
            // Session level: Show root items (no parent) within this session
            const session = this.sessionManager.getSession(element.session.id);
            if (!session) return [];
            const rootEntries = session.storage.files.filter(f => !f.parentUriString);
            return Promise.resolve(
                rootEntries.map(e => new ResourceItem(e,
                    e.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
                ))
            );
        }
        if (element instanceof ResourceItem && element.isDirectory) {
            // Directory level: Show children of this directory
            const session = this.sessionManager.getSession(element.sessionId);
            if (!session) return [];
            const childEntries = session.storage.files.filter(f => f.parentUriString === element.uriString);
            return Promise.resolve(
                childEntries.map(e => new ResourceItem(e,
                    e.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
                ))
            );
        }
        return Promise.resolve([]); // Should not happen for valid elements
     }

    /** Signals VS Code to refresh the view (optionally starting from a specific element). */
    refresh(element?: IntegratorTreeItem): void {
        this._onDidChangeTreeData.fire(element);
    }

    // --- Drag and Drop Controller Implementation ---

    /** Handles dragging items *from* the File Integrator view. */
    handleDrag(source: readonly IntegratorTreeItem[], dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): void | Thenable<void> {
        console.log(`[handleDrag] Starting drag for ${source.length} items.`);
        const draggableItems = source.filter((item): item is ResourceItem => item instanceof ResourceItem);

        if (draggableItems.length > 0) {
            // Package identifiers as 'sessionId::uriString' for internal reordering
            const draggedIds = draggableItems.map(item => `${item.sessionId}::${item.uriString}`);
            dataTransfer.set(this.customMimeType, new vscode.DataTransferItem(draggedIds));
        }
    }

    /** Handles dropping items *onto* the File Integrator view. */
    async handleDrop(target: IntegratorTreeItem | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
        console.log(`[handleDrop] Drop detected. Target: ${target?.id ?? 'view root'}`);
        const internalDropItem = dataTransfer.get(this.customMimeType);
        const externalDropItem = dataTransfer.get('text/uri-list');

        if (token.isCancellationRequested) return;

        // --- Handle INTERNAL Reorder Drop ---
        if (internalDropItem) {
            console.log('[handleDrop] Handling internal drop (reorder).');
            const draggedItemIds = internalDropItem.value as string[];
            if (!Array.isArray(draggedItemIds) || draggedItemIds.length === 0) return;

            // Robustly parse 'sessionId::uriString' format
            const firstIdParts = draggedItemIds[0].split('::');
            if (firstIdParts.length < 2) { console.warn('[handleDrop] Invalid dragged item ID format.'); return; }
            const sessionId = firstIdParts[0];
            const draggedUriStrings = draggedItemIds.map(id => id.substring(id.indexOf('::') + 2)).filter(Boolean);

            const session = this.sessionManager.getSession(sessionId);
            if (!session) { console.error(`[handleDrop] Session not found for internal drop: ${sessionId}`); return; }

            let targetUriString: string | undefined;
            let dropOnSessionNode = false;

            // Determine drop context and check if target session matches source session
            if (target instanceof SessionItem) {
                 if (target.session.id !== sessionId) { vscode.window.showErrorMessage("Cannot move items between sessions yet."); return; }
                 dropOnSessionNode = true;
            } else if (target instanceof ResourceItem) {
                 if (target.sessionId !== sessionId) { vscode.window.showErrorMessage("Cannot move items between sessions yet."); return; }
                 targetUriString = target.uriString;
            }
            // else: dropped on empty space (handled by reorderItems logic)

            // Perform reorder in storage model
            const success = session.storage.reorderItems(draggedUriStrings, targetUriString, dropOnSessionNode);

            if (success) {
                this.sessionManager.persistSessions();
                await updateCodeBlockDocument(session); // Update associated doc content
                this.refresh(); // Refresh the entire view after reorder
            } else {
                this.refresh(); // Refresh even if reorder failed (e.g., different parents)
            }
        }
        // --- Handle EXTERNAL File/Folder Drop (e.g., from Explorer) ---
        else if (externalDropItem) {
            console.log('[handleDrop] Handling external drop (uri-list).');
             let targetSession: Session | undefined;

             // Determine target session based on drop location
             if (target instanceof SessionItem) {
                targetSession = target.session;
             } else if (target instanceof ResourceItem) {
                 targetSession = this.sessionManager.getSession(target.sessionId);
            } else {
                // Dropped on view background - use first session or show error
                const sessions = this.sessionManager.getAllSessions();
                targetSession = sessions.length > 0 ? sessions[0] : undefined;
                if (targetSession && sessions.length > 1) {
                    vscode.window.showInformationMessage(`Added resources to session: "${targetSession.name}" (Dropped on view background)`);
                } else if (!targetSession) {
                     vscode.window.showErrorMessage("Cannot add resources: No sessions exist."); return;
                }
            }
             if (!targetSession) { vscode.window.showErrorMessage("Could not determine target session."); return; }

            const uriListString = await externalDropItem.asString();
            const uriStrings = uriListString.split('\n').map(u => u.trim()).filter(Boolean);
            if (uriStrings.length === 0) return;

            let resourcesWereAdded = false;
            let skippedCount = 0;
            // Show progress for potentially long operations
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Adding to session "${targetSession.name}"...`, cancellable: true }, async (progress, progressToken) => {
                progressToken.onCancellationRequested(() => { console.log("User cancelled resource adding."); });

                for (let i = 0; i < uriStrings.length; i++) {
                    if (progressToken.isCancellationRequested) break;
                    const uriStr = uriStrings[i];
                    let currentUri: vscode.Uri | undefined;
                     try {
                        currentUri = vscode.Uri.parse(uriStr, true); // Strict parsing
                        const displayName = getDisplayUri(uriStr, 'treeDescription');
                        progress.report({ message: `(${i+1}/${uriStrings.length}) ${displayName}`, increment: 100/uriStrings.length });

                        // addResource handles fs checks, recursion, and exclusion checks
                        const processed = await targetSession!.storage.addResource(currentUri);
                        if (processed) {
                             resourcesWereAdded = true;
                         } else {
                             // Skipped (duplicate, exclusion, or error during addResource)
                             skippedCount++;
                         }
                     } catch (err: any) {
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
        } else {
             console.log('[handleDrop] No supported data transfer item found.');
         }
    }
}

// --- Global Variables & Activation ---

let sessionManager: SessionManager;
let fileIntegratorProvider: FileIntegratorProvider;
let treeView: vscode.TreeView<IntegratorTreeItem>;
let gitAPI: GitAPI | undefined; // Store the Git API instance

export async function activate(context: vscode.ExtensionContext) {
    console.log('Activating File Integrator...');

    // Get Git API
    try {
        const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
        if (gitExtension) {
            if (!gitExtension.isActive) {
                 console.log('File Integrator: Activating vscode.git extension...');
                 await gitExtension.activate();
            }
            gitAPI = gitExtension.exports.getAPI(1);
            if (gitAPI) {
                // Removed logging API version
                console.log(`File Integrator: Successfully obtained Git API.`);
                 gitAPI.repositories.forEach(repo => console.log(`  Found Git repo: ${repo.rootUri.fsPath}`));
                 gitAPI.onDidOpenRepository(repo => console.log(`  Git repo opened: ${repo.rootUri.fsPath}`));
                 gitAPI.onDidCloseRepository(repo => console.log(`  Git repo closed: ${repo.rootUri.fsPath}`));
            } else {
                 console.error('File Integrator: Failed to get Git API (getAPI(1) returned undefined).');
                 vscode.window.showWarningMessage('File Integrator: Could not initialize Git features. Failed to get Git API.');
            }
        } else {
            console.warn('File Integrator: vscode.git extension not found.');
            vscode.window.showWarningMessage('File Integrator: vscode.git extension not found. Git diff features will be unavailable.');
        }
    } catch (error) {
        console.error('File Integrator: Failed to get or activate Git API:', error);
        vscode.window.showWarningMessage('File Integrator: Could not initialize Git features. The vscode.git extension might be disabled or encountered an error.');
    }

    // Initialize SessionManager, Provider, TreeView
    sessionManager = new SessionManager(context);
    sessionManager.loadSessions();

    fileIntegratorProvider = new FileIntegratorProvider(sessionManager);

    treeView = vscode.window.createTreeView('fileIntegratorView', {
        treeDataProvider: fileIntegratorProvider,
        dragAndDropController: fileIntegratorProvider,
        showCollapseAll: true,
        canSelectMany: true
    });

    context.subscriptions.push(treeView);
    registerCommands(context); // Register all commands

    context.subscriptions.push({ dispose: () => sessionManager.dispose() });

    console.log('File Integrator activated.');
}

// --- Command Registration ---

function registerCommands(context: vscode.ExtensionContext) {
    const register = (commandId: string, callback: (...args: any[]) => any) => {
        context.subscriptions.push(vscode.commands.registerCommand(commandId, callback));
    };

    // Command: Add New Session
    register('fileintegrator.addSession', async () => {
        const n = await vscode.window.showInputBox({ prompt: "Enter new session name", value: `Session ${sessionManager.getAllSessions().length + 1}`, placeHolder: "New Session Name" });
        if (n && n.trim()) {
            const s = sessionManager.createSession(n.trim());
            fileIntegratorProvider.refresh();
            await treeView.reveal(new SessionItem(s), { select: true, focus: true, expand: vscode.TreeItemCollapsibleState.Expanded });
        }
    });

    // Command: Remove Session
    register('fileintegrator.removeSession', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to remove');
        if (!s) return;
        const c = await vscode.window.showWarningMessage(`Remove session "${s.name}" and its ${s.storage.files.length} item links? (Files are not deleted)`, { modal: true }, 'Yes', 'No');
        if (c === 'Yes') {
            await s.closeAssociatedDocument(true);
            if (sessionManager.removeSession(s.id)) {
                fileIntegratorProvider.refresh();
            }
        }
    });

    // Command: Rename Session
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

    // Command: Clear All Items from Session
    register('fileintegrator.clearSession', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to clear');
        if (!s) return;
        if (s.storage.files.length === 0) {
            vscode.window.showInformationMessage(`Session "${s.name}" is already empty.`);
            return;
        }
        console.log(`[ClearSession] Clearing session "${s.name}" (ID: ${s.id})`);
        const count = s.storage.clearFiles();
        sessionManager.persistSessions();
        fileIntegratorProvider.refresh();
        await updateCodeBlockDocument(s);
        vscode.window.showInformationMessage(`Cleared ${count} items from session "${s.name}".`);
    });

    // Command: Generate/Show Code Block Document
    register('fileintegrator.generateCodeBlock', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to generate code block for');
        if (!s) return;
        if (s.storage.resourcesOnly.length === 0) {
            vscode.window.showInformationMessage(`Session "${s.name}" contains no file/resource content.`);
            return;
        }
        const doc = await showCodeBlockDocument(s);
        if (doc) {
            await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
        }
    });

    // Command: Copy Generated Content to Clipboard
    register('fileintegrator.copyToClipboard', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to copy content from');
        if (!s) return;
        if (s.storage.resourcesOnly.length === 0) {
            vscode.window.showInformationMessage(`Session "${s.name}" contains no file/resource content to copy.`);
            return;
        }
        let contentToCopy: string;
        if (s.associatedDocument && !s.associatedDocument.isClosed) {
            contentToCopy = s.associatedDocument.getText();
        } else {
            contentToCopy = await generateMarkdownContent(s);
        }
        if (contentToCopy && !contentToCopy.startsWith('<!-- No file/resource content')) {
            await vscode.env.clipboard.writeText(contentToCopy);
            vscode.window.showInformationMessage(`Session "${s.name}" Code Block content copied to clipboard!`);
        } else {
            vscode.window.showWarningMessage("No code block content was generated or found to copy.");
        }
    });

    // Command: Remove Single Item
    register('fileintegrator.removeItem', async (item: ResourceItem) => {
        if (!item || !(item instanceof ResourceItem)) return;
        const s = sessionManager.getSession(item.sessionId);
        if (s) {
            if (s.storage.removeEntry(item.uriString)) {
                sessionManager.persistSessions();
                await updateCodeBlockDocument(s);
                fileIntegratorProvider.refresh();
            } else {
                fileIntegratorProvider.refresh();
            }
        }
    });

    // Command: Refresh Tree View
    register('fileintegrator.refreshView', () => {
        fileIntegratorProvider.refresh();
    });

    // Command: Add Active Editor to Session
    register('fileintegrator.addActiveEditorToSession', async (item?: SessionItem) => {
        const targetSession = item?.session ?? await selectSession("Select session to add active editor to");
        if (!targetSession) return;
        await addActiveEditorLogic(targetSession);
    });

    // Command: Add All Open Editors to Session
    register('fileintegrator.addAllOpenEditorsToSession', async (item?: SessionItem) => {
        const session = item?.session ?? await selectSession("Select session to add all open editors to");
        if (!session) return;
        await addAllOpenEditorsLogic(session);
    });


    // --- NEW GIT COMMANDS ---

    // Command: Generate Diff Document (vs HEAD)
    register('fileintegrator.generateDiffDocument', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to generate Git diff for');
        if (!s) return;

        if (!gitAPI) {
            vscode.window.showErrorMessage("Git integration is not available. Ensure the built-in Git extension is enabled.");
            return;
        }

        try {
            // Pass showMessage function for feedback within calculateSessionDiff
            const { diffOutput, skippedFiles, diffedFilesCount } = await calculateSessionDiff(s, (msg) => vscode.window.showInformationMessage(msg));

            let infoMsg = '';
            if (skippedFiles.length > 0) {
                infoMsg = ` (Skipped ${skippedFiles.length} non-Git or non-file item(s))`;
            }

            if (diffedFilesCount === 0) {
                 // Message shown by calculateSessionDiff if needed
                 return;
            }

            if (!diffOutput || diffOutput.trim() === '') {
                vscode.window.showInformationMessage(`No changes found compared to HEAD for items in session "${s.name}".${infoMsg}`);
                return;
            }

            const doc = await vscode.workspace.openTextDocument({ content: diffOutput, language: 'diff' });
            await vscode.window.showTextDocument(doc, { preview: false });

             if (skippedFiles.length > 0 && diffOutput && diffOutput.trim() !== '') {
                 vscode.window.showInformationMessage(`Generated diff (vs HEAD).${infoMsg}`);
             }

        } catch (error: any) {
            console.error(`[GenerateDiff] Error:`, error);
            vscode.window.showErrorMessage(`Failed to generate diff: ${error.message}`);
        }
    });

    // Command: Copy Diff to Clipboard (vs HEAD)
    register('fileintegrator.copyDiffToClipboard', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to copy Git diff from');
        if (!s) return;

        if (!gitAPI) {
            vscode.window.showErrorMessage("Git integration is not available. Ensure the built-in Git extension is enabled.");
            return;
        }

         try {
            // Pass showMessage function for feedback within calculateSessionDiff
            const { diffOutput, skippedFiles, diffedFilesCount } = await calculateSessionDiff(s, (msg) => vscode.window.showInformationMessage(msg));

            let infoMsg = '';
            if (skippedFiles.length > 0) {
                infoMsg = ` (Skipped ${skippedFiles.length} non-Git or non-file item(s))`;
            }

            if (diffedFilesCount === 0) {
                // Message shown by calculateSessionDiff if needed
                return;
           }

            if (!diffOutput || diffOutput.trim() === '') {
                vscode.window.showInformationMessage(`No changes found compared to HEAD for items in session "${s.name}".${infoMsg}`);
                return;
            }

            await vscode.env.clipboard.writeText(diffOutput);
            vscode.window.showInformationMessage(`Diff (vs HEAD) for session "${s.name}" copied to clipboard.${infoMsg}`);

        } catch (error: any) {
            console.error(`[CopyDiff] Error:`, error);
            vscode.window.showErrorMessage(`Failed to copy diff: ${error.message}`);
        }
    });
}


// --- Command Logic Helpers ---

/** Logic for adding the active editor's resource to a session. */
async function addActiveEditorLogic(targetSession: Session) {
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
    const newEntry: FileEntry = {
        uriString: uriString,
        isDirectory: false, // Active editor represents a single resource
        content: null,      // Content loaded on demand
        parentUriString: undefined, // Add to root
        sessionId: targetSession.id,
    };

    if (targetSession.storage.addItem(newEntry)) {
        sessionManager.persistSessions();
        await updateCodeBlockDocument(targetSession);
        fileIntegratorProvider.refresh();
    } else {
        vscode.window.showWarningMessage(`Failed to add "${getDisplayUri(uriString)}" (perhaps already added?).`);
    }
}

/** Logic for adding all unique open editor resources to a session. */
async function addAllOpenEditorsLogic(targetSession: Session) {
    const openUris = new Set<string>();
    const sessionDocUriString = targetSession.associatedDocument?.uri.toString();

    // Collect unique URIs from all open tabs, excluding the target session's doc
    for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
            const uri = (tab.input as any)?.uri;
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
        } else {
            console.log(`[AddAllOpen] Adding ${uriString} to session ${targetSession.name}`);
            const newEntry: FileEntry = {
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
        fileIntegratorProvider.refresh();
        let message = `Added ${addedCount} unique open editor(s) to session "${targetSession.name}".`;
        if (skippedCount > 0) {
            message += ` Skipped ${skippedCount} item(s) (already present or session doc).`;
        }
        vscode.window.showInformationMessage(message);
    } else if (skippedCount > 0) {
        vscode.window.showInformationMessage(`All open editors were already present or skipped in session "${targetSession.name}".`);
    } else {
        vscode.window.showInformationMessage("No new editors were added.");
    }
}

// --- Deactivation ---

export function deactivate() {
    console.log('Deactivating File Integrator...');
    gitAPI = undefined; // Clear API reference
}

// --- Utility Functions ---

/** Checks if a file system path matches exclusion patterns from settings. */
function isPathExcluded(filePath: string): boolean {
    const config = vscode.workspace.getConfiguration('fileintegrator');
    const excludePatterns = config.get<Record<string, boolean>>('exclude');
    if (!excludePatterns) return false;

    const normalizedFilePath = filePath.replace(/\\/g, '/');
    const workspaceFolders = vscode.workspace.workspaceFolders;

    for (const pattern in excludePatterns) {
        if (excludePatterns[pattern]) {
            const normalizedPattern = pattern.replace(/\\/g, '/');
            const options = { dot: true, nocase: process.platform === 'win32' };

            if (minimatch(normalizedFilePath, normalizedPattern, options)) return true;

            if (workspaceFolders) {
                for (const folder of workspaceFolders) {
                    const folderPath = folder.uri.fsPath.replace(/\\/g, '/');
                    if (normalizedFilePath.startsWith(folderPath + '/')) {
                        const relativePath = normalizedFilePath.substring(folderPath.length + 1);
                        if (minimatch(relativePath, normalizedPattern, options)) return true;
                    }
                }
            }
            if (!normalizedPattern.includes('/')) {
                if (minimatch(path.basename(normalizedFilePath), normalizedPattern, options )) return true;
            }
        }
    }
    return false;
 }

/** Prompts user to select a session via Quick Pick. Returns undefined if cancelled. */
 async function selectSession(placeHolder: string): Promise<Session | undefined> {
    const sessions = sessionManager.getAllSessions();
    if (sessions.length === 0) {
        vscode.window.showErrorMessage("No sessions available.");
        return undefined;
    }
    if (sessions.length === 1) return sessions[0];

    const picks = sessions.map(s => ({ label: s.name, description: `(${s.storage.files.length} items)`, session: s }));
    const selection = await vscode.window.showQuickPick(picks, { placeHolder, canPickMany: false });
    return selection?.session;
 }

/**
 * Generates aggregated Markdown content for a session, respecting order.
 * Reads resource content asynchronously using VS Code API if not already loaded.
 */
 async function generateMarkdownContent(session: Session): Promise<string> {
    let content = '';
    const resourceEntries = session.storage.files.filter(f => !f.isDirectory);

    if (resourceEntries.length === 0) {
        return `<!-- No file/resource content in session "${session.name}" -->\n`;
    }

    console.log(`[MarkdownGen] Generating content for ${resourceEntries.length} resources in session ${session.id}`);

    for (const entry of resourceEntries) {
        let resourceContent: string | null = entry.content;

        if (resourceContent === null) {
            const uri = vscode.Uri.parse(entry.uriString);
            try {
                console.log(`[MarkdownGen] Reading content for URI: ${entry.uriString}`);
                const doc = await vscode.workspace.openTextDocument(uri);
                resourceContent = doc.getText();
                // Optionally cache content back to entry.content if memory is not a concern
                // entry.content = resourceContent;
            } catch (error: any) {
                console.error(`[MarkdownGen] Error reading URI ${entry.uriString}:`, error);
                const displayUri = getDisplayUri(entry.uriString);
                 if (error?.code === 'FileNotFound' || error?.code === 'EntryNotFound' || error?.message?.includes('cannot open')) {
                     resourceContent = `--- Error: Resource not found or inaccessible (${displayUri}) ---`;
                     // Only show warning once per generation perhaps? Or rely on console.
                     // vscode.window.showWarningMessage(`Resource not found or inaccessible: ${displayUri}`);
                 } else {
                     resourceContent = `--- Error reading content for ${displayUri}: ${error.message} ---`;
                     // vscode.window.showWarningMessage(`Could not read content for: ${displayUri}`);
                 }
            }
        }

        const displayUri = getDisplayUri(entry.uriString, 'markdownHeader');
        const uriPath = vscode.Uri.parse(entry.uriString).path;
        const langPart = uriPath.includes('!/') ? uriPath.substring(uriPath.lastIndexOf('!/') + 1) : uriPath;
        const ext = path.extname(langPart);
        const lang = ext ? ext.substring(1) : '';

        content += `${displayUri}\n\`\`\`${lang}\n`;
        content += resourceContent ?? `--- Content Unavailable ---`;
        content += `\n\`\`\`\n\n`;
    }

    return content.trimEnd();
}

/**
 * Ensures the code block document for a session is visible and up-to-date.
 * Creates the document if it doesn't exist, updates it if it does.
 * Returns the TextDocument or undefined on failure.
 */
async function showCodeBlockDocument(session: Session): Promise<vscode.TextDocument | undefined> {
    const content = await generateMarkdownContent(session);

    if (session.associatedDocument && !session.associatedDocument.isClosed) {
        const doc = session.associatedDocument;
        try {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), content);
            const success = await vscode.workspace.applyEdit(edit);
            if (!success) throw new Error("ApplyEdit failed");
            console.log(`[ShowDoc] Updated associated document for session ${session.id}`);
            return doc;
        } catch (e) {
            console.error(`[ShowDoc] Error updating associated doc ${doc.uri}:`, e);
            await session.closeAssociatedDocument(false);
            return createNewAssociatedDocument(session, content);
        }
    }
     return createNewAssociatedDocument(session, content);
}

/** Helper function solely for creating a new associated Markdown document. */
async function createNewAssociatedDocument(session: Session, content: string): Promise<vscode.TextDocument | undefined> {
    try {
        console.log(`[ShowDoc] Creating new associated document for session ${session.id}`);
        const doc = await vscode.workspace.openTextDocument({ content: content, language: 'markdown' });
        session.setAssociatedDocument(doc);
        return doc;
    } catch (e: any) {
        console.error(`[ShowDoc] Failed to create associated document:`, e);
        vscode.window.showErrorMessage(`Failed to create associated document: ${e.message}`);
        session.closeAssociatedDocument(false);
        return undefined;
    }
}

/** Updates the associated document content *if* it exists and is open, without showing it. */
async function updateCodeBlockDocument(session: Session): Promise<void> {
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
            } else {
                 console.log(`[UpdateDoc] Successfully updated associated document.`);
             }
        } catch (err) {
            console.error(`[UpdateDoc] Error applying edit to ${doc.uri}:`, err);
            session.closeAssociatedDocument(false);
            vscode.window.showErrorMessage("Error updating associated code block document.");
        }
    }
}

/**
 * Generates a display-friendly string for a URI, handling various schemes and shortening.
 * @param type Controls formatting detail ('treeDescription' is shortest).
 */
function getDisplayUri(uriString: string, type: 'treeDescription' | 'markdownHeader' | 'tooltip' = 'markdownHeader'): string {
     try {
        const uri = vscode.Uri.parse(uriString);
        const scheme = uri.scheme;
        const uriPath = uri.path; // Use path for consistency, fsPath is only for 'file' scheme

        // Handle Archive URIs (jar:, or file:...!)
        const bangIndex = uri.toString().lastIndexOf('!/');
        if ((scheme === 'jar' || scheme === 'file') && bangIndex !== -1) {
            const fullUriStr = uri.toString();
            let archivePart = fullUriStr.substring(0, bangIndex);
            let internalPath = fullUriStr.substring(bangIndex + 1);
            let archiveName = 'archive';
            let archiveScheme = scheme;

             try {
                 const archiveUri = vscode.Uri.parse(archivePart);
                 archiveName = path.basename(archiveUri.fsPath || archiveUri.path);
                 archiveScheme = archiveUri.scheme;
             } catch {
                 archiveName = path.basename(archivePart);
             }

            const displayInternalPath = (internalPath.startsWith('/') ? internalPath.substring(1) : internalPath).replace(/\\/g, '/');
            const fullDisplay = `${archiveName}!/${displayInternalPath}`;

            if (type === 'treeDescription') {
                const shortArchive = archiveName.length > 15 ? archiveName.substring(0, 6) + '...' + archiveName.slice(-6) : archiveName;
                const shortInternal = displayInternalPath.length > 20 ? '.../' + displayInternalPath.slice(-17) : displayInternalPath;
                const prefix = archiveScheme !== 'file' ? `${archiveScheme}:` : '';
                return `${prefix}${shortArchive}!/${shortInternal}`;
            } else if (type === 'tooltip') {
                 const prefix = archiveScheme !== 'file' ? `${archiveScheme}:` : '';
                 return `${prefix}${fullDisplay}`;
            } else { // markdownHeader
                 return fullDisplay; // Use full name for header for clarity
            }
        }
        // Handle Standard File URIs
        else if (scheme === 'file') {
             return getDisplayPath(uri.fsPath, type === 'treeDescription');
        }
        // Handle Other Schemes
        else {
            let displayPath = uri.fsPath || uri.path;
             if (uri.authority && displayPath.startsWith('/' + uri.authority)) {
                 displayPath = displayPath.substring(uri.authority.length + 1);
             }
             if (displayPath.startsWith('/')) displayPath = displayPath.substring(1);

             const authority = uri.authority ? `//${uri.authority}/` : (uri.scheme === 'untitled' ? '' : ':');
             const fullDisplay = `${scheme}${authority}${displayPath}`;

             if (type === 'treeDescription') {
                 const maxLength = 45;
                 if (fullDisplay.length > maxLength) {
                    return fullDisplay.substring(0, scheme.length + 1) + '...' + fullDisplay.substring(fullDisplay.length - (maxLength - scheme.length - 4));
                 }
             }
             return fullDisplay;
        }
    } catch (e) {
        console.warn(`[getDisplayUri] Error parsing/formatting URI string: ${uriString}`, e);
        if (type === 'treeDescription' && uriString.length > 40) {
             return uriString.substring(0, 15) + '...' + uriString.substring(uriString.length - 22);
        }
        return uriString;
    }
}

/** Generates display path for file system URIs, preferring relative paths. */
function getDisplayPath(filePath: string, short: boolean = false): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    let relativePath: string | undefined;

    if (workspaceFolders) {
        const sortedFolders = [...workspaceFolders].sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length);
        for (const folder of sortedFolders) {
            const folderPath = folder.uri.fsPath;
            const rel = path.relative(folderPath, filePath);

            if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
                relativePath = rel;
                 if (relativePath === '') {
                      relativePath = path.basename(folderPath);
                 }
                 else if (workspaceFolders.length > 1 && short) {
                     relativePath = `${path.basename(folderPath)}/${relativePath.replace(/\\/g, '/')}`;
                 }
                break;
            }
        }
    }

    if (relativePath) {
        const display = relativePath.replace(/\\/g, '/');
        if (short && display.length > 40) {
             const parts = display.split('/');
             if (parts.length > 2) {
                 return parts[0] + '/.../' + parts[parts.length-1];
             } else {
                 return display;
             }
        }
        return display;
    } else {
        const pathParts = filePath.split(path.sep).filter(Boolean);
        const partsCount = pathParts.length;
        const sep = path.sep;

        if (short && partsCount > 3) {
            return `...${sep}${pathParts.slice(-2).join(sep)}`;
        } else if (!short && partsCount > 4) {
             return `...${sep}${pathParts.slice(-3).join(sep)}`;
         } else {
             return filePath;
         }
    }
}


// --- Git Diff Helper Function ---
/**
 * Calculates the scoped Git diff (changes vs HEAD) for file items in a session.
 * @param showInfoMessage Optional callback to display intermediate messages to the user.
 */
async function calculateSessionDiff(
    session: Session,
    showInfoMessage?: (message: string) => void
): Promise<{ diffOutput: string; skippedFiles: string[]; diffedFilesCount: number }> {
    if (!gitAPI) {
        throw new Error("Git API is not available.");
    }

    const filesToDiff = new Map<string, { repo: GitRepository, paths: string[] }>(); // Map repo root URI string to repo object and RELATIVE paths
    const skippedFiles: string[] = [];
    let diffedFilesCount = 0;

    // 1. Filter and Group files by repository
    console.log(`[DiffCalc] Processing ${session.storage.files.length} items for session ${session.id}`);
    for (const entry of session.storage.files) {
        let uri: vscode.Uri;
        try {
            uri = vscode.Uri.parse(entry.uriString, true); // Strict parsing
        } catch (e) {
            console.warn(`[DiffCalc] Skipping invalid URI: ${entry.uriString}`, e);
            skippedFiles.push(entry.uriString);
            continue;
        }

        if (uri.scheme !== 'file') {
            skippedFiles.push(entry.uriString);
            console.log(`[DiffCalc] Skipping non-file URI: ${entry.uriString}`);
            continue;
        }

        const repo = gitAPI.getRepository(uri);
        if (!repo) {
            skippedFiles.push(entry.uriString);
            console.log(`[DiffCalc] Skipping file outside Git repo: ${uri.fsPath}`);
            continue;
        }

        diffedFilesCount++;
        const repoRootStr = repo.rootUri.toString();
        if (!filesToDiff.has(repoRootStr)) {
            filesToDiff.set(repoRootStr, { repo, paths: [] });
        }

        // Get the relative path for the diff command within that repo context
        const relativePath = path.relative(repo.rootUri.fsPath, uri.fsPath).replace(/\\/g, '/');

        if (relativePath && relativePath !== '.') {
            const existingPaths = filesToDiff.get(repoRootStr)!.paths;
            // Check if path is already covered by a parent directory or '.'
            const isAlreadyCovered = existingPaths.some(p => p === '.' || relativePath.startsWith(p + '/'));
            // Check if path itself is already added
            const isAlreadyAdded = existingPaths.includes(relativePath);

            if (!isAlreadyCovered && !isAlreadyAdded) {
                 // If adding a directory, remove any files *within* it already added
                if (entry.isDirectory) {
                     filesToDiff.get(repoRootStr)!.paths = existingPaths.filter(p => !p.startsWith(relativePath + '/'));
                     console.log(`[DiffCalc] Adding directory path for repo ${repoRootStr}: ${relativePath}`);
                 } else {
                     console.log(`[DiffCalc] Adding file path for repo ${repoRootStr}: ${relativePath}`);
                 }
                 filesToDiff.get(repoRootStr)!.paths.push(relativePath);
            } else {
                 console.log(`[DiffCalc] Path ${relativePath} already covered or added in repo ${repoRootStr}`);
            }

        } else if (entry.isDirectory && (relativePath === '.' || relativePath === '')) {
           // If the entry IS the repo root directory, add '.' (covers all)
           const existingPaths = filesToDiff.get(repoRootStr)!.paths;
            if (!existingPaths.includes('.')) {
                filesToDiff.get(repoRootStr)!.paths = ['.']; // Replace specific paths with '.'
                console.log(`[DiffCalc] Adding '.' for repo root ${repoRootStr} (covers all)`);
            } else {
                console.log(`[DiffCalc] Repo root '.' already added for ${repoRootStr}`);
            }
        }
         else if (!entry.isDirectory && (relativePath === '' || relativePath === '.')) {
             // This case (a file mapping to the repo root) shouldn't happen with valid Git repos.
             console.warn(`[DiffCalc] Calculated empty/root relative path for file: ${uri.fsPath} in repo ${repo.rootUri.fsPath}`);
             skippedFiles.push(entry.uriString);
         }
    }

    if (diffedFilesCount === 0 && showInfoMessage) {
        let msg = `No Git-tracked file items found in session "${session.name}".`;
         if(skippedFiles.length > 0) {
            msg += ` (Skipped ${skippedFiles.length} non-Git or non-file item(s))`;
         }
        showInfoMessage(msg);
    }

    // 2. Execute git diff for each repository path
    let combinedDiff = '';
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Calculating Git diff (vs HEAD) for session "${session.name}"...`,
        cancellable: false // Keep it simple, no cancellation for now
    }, async (progress) => {
        let repoIndex = 0;
        const totalRepos = filesToDiff.size;

        for (const [repoRoot, data] of filesToDiff.entries()) {
            repoIndex++;
            const repoDisplayName = path.basename(data.repo.rootUri.fsPath);
            progress.report({ message: `Processing repo ${repoIndex}/${totalRepos}: ${repoDisplayName}`, increment: (1 / totalRepos) * 100 });

            // Filter out empty paths just in case
            const pathsToProcess = data.paths.filter(p => p.length > 0);
            if (pathsToProcess.length === 0) {
                console.log(`[DiffCalc] No specific paths to diff in repo ${repoDisplayName}.`);
                continue;
            }

            // If '.' is the only path, we diff the entire repo against HEAD
            if (pathsToProcess.length === 1 && pathsToProcess[0] === '.') {
                 try {
                     console.log(`[DiffCalc] Diffing repo root '.' against HEAD for ${repoDisplayName}`);
                     // Request diff against HEAD for the whole repository
                     const repoRootDiff = await data.repo.diffWithHEAD(); // Returns Change[]

                     // We need the raw diff text. The API doesn't directly give `git diff HEAD -- .`
                     // Let's try `git diff HEAD` via show - less ideal but might work
                     // This is a limitation; ideally, we'd use exec if available.
                     // For now, indicate this limitation or skip.
                     // Let's try diffing HEAD vs working tree for files instead?
                     // Option: Get structured changes vs HEAD and format them (complex)
                     // Option: Show message about limitation
                     // Option: Fallback to diffing individual files known to the repo (might be huge)

                     // Workaround: Let's try `show` on HEAD which sometimes includes a diff? No, not reliable.
                     // Workaround 2: Diff with empty tree (initial commit)? No, that's not HEAD.
                     // Workaround 3: Use available API. Call diffWithHEAD for *all files* in the repo? Inefficient.

                     // Best current approach with THIS API: Iterate individual files if '.' is present.
                     // Get all tracked files in the repo? API doesn't expose ls-files easily.

                     // Simplest approach for now: If '.' is present, skip detailed diffing for this repo and note it.
                     console.warn(`[DiffCalc] Diffing entire repo root ('.') against HEAD is not directly supported by the currently used API methods. Skipping detailed diff for ${repoDisplayName}.`);
                     combinedDiff += `--- Diff for repository root: ${repoDisplayName} (Specific file diffs not generated due to API limitations) ---\n\n`;
                     continue; // Skip to the next repo

                 } catch (error: any) {
                    console.error(`[DiffCalc] Error during repo root diff attempt for ${repoDisplayName}:`, error);
                     // Append error details to the combined diff
                    if (filesToDiff.size > 1) {
                        combinedDiff += `--- Error diffing repository root: ${repoDisplayName} ---\n`;
                    }
                    combinedDiff += `Error: ${error.message || 'Unknown Git error'}\n\n`;
                 }
                 continue; // Skip the path iteration below
            }

            // Diff each path individually using diffWithHEAD
            let repoDiff = '';
            console.log(`[DiffCalc] Diffing individual paths against HEAD for repo ${repoDisplayName}:`, pathsToProcess);
            for (const relativePath of pathsToProcess) {
                try {
                    // diffWithHEAD(path) diffs working tree vs HEAD for that path
                    const pathDiff = await data.repo.diffWithHEAD(relativePath);
                    if (pathDiff && pathDiff.trim() !== '') {
                        // Add a header for the specific file within the repo's section
                        // Use standard diff header format
                        repoDiff += `diff --git a/${relativePath} b/${relativePath}\n`;
                        // Note: We don't get index hashes or modes easily here.
                        // Append the diff content directly
                        repoDiff += `${pathDiff}\n\n`; // Add extra newline for spacing
                        console.log(`[DiffCalc] Found diff for path ${relativePath} in repo ${repoDisplayName}`);
                    }
                } catch (error: any) {
                    console.error(`[DiffCalc] Error running git diff for path ${relativePath} in repo ${repoDisplayName}:`, error);
                    // Include error details in the output for debugging
                    repoDiff += `--- Error diffing path: ${relativePath} ---\n`;
                    repoDiff += `Error: ${error.message || 'Unknown Git error'}\n`;
                    if (error.stderr) { // If error object has stderr (from potential exec behind the scenes)
                        repoDiff += `Stderr:\n${error.stderr}\n`;
                    }
                    if (error.gitErrorCode) { // If error object has gitErrorCode
                        repoDiff += `GitErrorCode: ${error.gitErrorCode}\n`;
                    }
                    repoDiff += `\n\n`;
                }
            }

            if (repoDiff.trim() !== '') {
                 if (filesToDiff.size > 1) {
                     // Add repo header only if there was actual diff content for this repo
                     combinedDiff += `--- Diff for repository: ${repoDisplayName} ---\n\n`;
                 }
                 combinedDiff += repoDiff; // Append the accumulated diff for this repo
             } else {
                 console.log(`[DiffCalc] No diff output for repo ${repoDisplayName} after checking paths.`);
             }
        }
    });

    console.log(`[DiffCalc] Finished. Diff length: ${combinedDiff.length}, Skipped: ${skippedFiles.length}, Diffed Files Count: ${diffedFilesCount}`);
    // Return trimmed diff, skipped files list, and the count of files considered for diffing
    return { diffOutput: combinedDiff.trim(), skippedFiles, diffedFilesCount };
}