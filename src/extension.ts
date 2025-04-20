import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';
import { v4 as uuidv4 } from 'uuid';
import { minimatch } from 'minimatch';

// Import Git API Types
import { GitExtension, API as GitAPI, Repository as GitRepository, Change as GitChange, Change } from './api/git'; // Assuming git.d.ts is correct

// --- Core Data Structures (Keep Existing) ---
interface FileEntry {
    uriString: string;
    isDirectory: boolean;
    content: string | null;
    parentUriString?: string;
    sessionId: string;
}
interface PersistedFileEntry { uri: string; isDirectory: boolean; parentUri?: string; }
interface PersistedSession { id: string; name: string; files: PersistedFileEntry[]; }
class SessionResourceStorage { /* Keep Existing */
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

        // Check DRAG & DROP exclusion based on file system path BEFORE adding
        // Note: This check only applies when called during directory recursion triggered by drag/drop
        // It uses the 'fileintegrator.exclude' setting.
        if (uri.scheme === 'file' && isPathExcluded(uri.fsPath)) {
            console.log(`[Exclude][AddResource] Skipping excluded file/dir during drag/drop: ${uri.fsPath}`);
            // Optionally notify user about skipped items during drag/drop - handled in handleDrop
            return false; // Don't add excluded item
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

                    // Check DRAG & DROP exclusion ('fileintegrator.exclude') based on file system path BEFORE recursive call
                    // This check is crucial here for directory recursion during add
                    if (!isPathExcluded(childPath)) {
                        processingPromises.push(this.addResource(childUri, uri)); // Pass current URI as parent
                    } else {
                        console.log(`[Exclude][AddDirRecursion] Skipping excluded: ${childPath}`);
                        // No need to return false here, just skip adding this child
                    }
                }
                await Promise.all(processingPromises);
            } catch (readDirError: any) {
                console.error(`[Storage:addResource] Error reading directory ${uri.fsPath}:`, readDirError);
                // Don't necessarily fail the whole add operation if a subdirectory fails
            }
        }
        return true; // Added successfully (or partially if subdir failed)
    }

    /** Removes entry and its descendants recursively. */
    removeEntry(uriStringToRemove: string): boolean { /* Keep Existing */
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
    clearFiles(): number { /* Keep Existing */
        const count = this._files.length;
        this._files = [];
        return count;
    }
    restoreFiles(restoredFiles: FileEntry[]): void { /* Keep Existing */
        this._files = restoredFiles;
        console.log(`[Storage:restore] Restored ${this._files.length} items for session ${this.sessionId}`);
    }
    reorderItems(draggedUriStrings: string[], targetUriString?: string, dropOnSession: boolean = false): boolean { /* Keep Existing */
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

        const firstParentUri = draggedEntries[0].parentUriString;
        if (!draggedEntries.every(e => e.parentUriString === firstParentUri)) {
            console.warn('[Storage:reorder] Dragged items have different parents. Aborted.');
            vscode.window.showWarningMessage("Cannot move items between different containers yet.");
            return false;
        }

        // Remove dragged items from their original positions
        const originalIndices = draggedEntries.map(entry => this._files.findIndex(f => f.uriString === entry.uriString)).sort((a, b) => b - a); // Sort descending to splice correctly
        originalIndices.forEach(index => {
            if (index > -1) this._files.splice(index, 1);
        });

        let targetIndex = -1;

        // Determine insertion point
        if (dropOnSession) {
            // Find the index of the first item that doesn't have a parent (root level)
            targetIndex = this._files.findIndex(f => f.parentUriString === undefined);
            if (targetIndex === -1) { // If no root items exist (empty or all nested somehow)
                targetIndex = this._files.length; // Append to end
            }
            // Make sure the dragged items have their parent reset
            draggedEntries.forEach(e => e.parentUriString = undefined);
        } else if (targetUriString) {
            // Find the target item's index
            const targetEntryIndex = this._files.findIndex(f => f.uriString === targetUriString);
            if (targetEntryIndex === -1) {
                console.error(`[Storage:reorder] Target URI not found after removal: ${targetUriString}`);
                // Put them back at the end as a fallback
                this._files.push(...draggedEntries);
                return false;
            }
            const targetEntry = this._files[targetEntryIndex];
            // Drop *before* the target item, assuming same parent
            targetIndex = targetEntryIndex;
            // Ensure the parent matches (should already be checked, but good practice)
            draggedEntries.forEach(e => e.parentUriString = targetEntry.parentUriString);

        } else {
            // Drop at the end of the sibling group (no specific target, just same level)
            const parentUri = firstParentUri; // Parent of the dragged items
            let lastIndexOfParentGroup = -1;
            for (let i = this._files.length - 1; i >= 0; i--) {
                if (this._files[i].parentUriString === parentUri) {
                    lastIndexOfParentGroup = i;
                    break;
                }
            }
            targetIndex = lastIndexOfParentGroup + 1; // Insert after the last sibling
            // Parent URI remains the same
        }

        // Insert the dragged items at the calculated target index
        this._files.splice(targetIndex, 0, ...draggedEntries);
        console.log(`[Storage:reorder] Reordering successful. New count: ${this._files.length}`);
        return true;
    }
}
class Session { /* Keep Existing */
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
        this.closeAssociatedDocument(false); // Close editor window associated if any
        this.storage.clearFiles();
    }

    setAssociatedDocument(doc: vscode.TextDocument) {
        this.docCloseListener?.dispose(); // Dispose previous listener if any
        this.associatedDocument = doc;
        this.docCloseListener = vscode.workspace.onDidCloseTextDocument(d => {
            if (d === this.associatedDocument) {
                console.log(`[Session ${this.id}] Associated document closed by user.`);
                this.associatedDocument = null; // Clear reference
                this.docCloseListener?.dispose(); // Clean up listener
                this.docCloseListener = null;
            }
        });
    }

    async closeAssociatedDocument(attemptEditorClose: boolean = true): Promise<void> {
        const docToClose = this.associatedDocument; // Store ref before clearing
        this.associatedDocument = null; // Clear internal reference first
        this.docCloseListener?.dispose(); // Clean up listener
        this.docCloseListener = null;

        if (attemptEditorClose && docToClose) {
            // Find the editor showing this document and close it
            for (const editor of vscode.window.visibleTextEditors) {
                if (editor.document === docToClose) {
                    try {
                        // Focus the editor first, then close it
                        await vscode.window.showTextDocument(docToClose, { viewColumn: editor.viewColumn, preserveFocus: false });
                        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                        console.log(`[Session ${this.id}] Closed editor for associated document.`);
                        break; // Assume only one editor shows it, exit loop
                    } catch (err) {
                        console.error(`[Session ${this.id}] Error closing editor:`, err);
                        // Continue trying other editors just in case? Unlikely needed.
                    }
                }
            }
        }
    }
}
class SessionManager { /* Keep Existing */
    private sessions: Map<string, Session> = new Map();
    private static readonly STORAGE_KEY = 'fileIntegratorSessions_v3'; // Keep v3 if structure is compatible
    private static readonly OLD_STORAGE_KEY_V2 = 'fileIntegratorSessions_v2';
    private static readonly OLD_STORAGE_KEY_V1 = 'fileIntegratorSessions';

    constructor(private context: vscode.ExtensionContext) { }

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
        // Sort alphabetically by name for consistent display
        return Array.from(this.sessions.values()).sort((a, b) => a.name.localeCompare(b.name));
    }

    removeSession(id: string): boolean {
        const session = this.sessions.get(id);
        if (session) {
            session.dispose(); // Clean up associated resources (like closing doc)
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
            const persistedData: PersistedSession[] = this.getAllSessions().map(session => ({
                id: session.id,
                name: session.name,
                files: session.storage.files.map(entry => ({ // Map internal FileEntry to PersistedFileEntry
                    uri: entry.uriString,
                    isDirectory: entry.isDirectory,
                    parentUri: entry.parentUriString, // Make sure parentUriString is saved
                }))
            }));
            // Save to V3 key, clear older keys
            this.context.workspaceState.update(SessionManager.STORAGE_KEY, persistedData);
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
            // Try loading from the current key first
            loadedData = this.context.workspaceState.get<PersistedSession[]>(SessionManager.STORAGE_KEY);

            // Migration from V2 (path-based) if V3 data not found
            if (!loadedData) {
                const oldDataV2 = this.context.workspaceState.get<any[]>(SessionManager.OLD_STORAGE_KEY_V2); // Type might be slightly different
                if (oldDataV2 && oldDataV2.length > 0) {
                    console.log("[Load] Migrating data from V2 storage key (path -> uri).");
                    // Convert V2 structure (assuming {id, name, files: [{path, isDirectory, parent}]}) to V3
                    loadedData = oldDataV2.map(metaV2 => ({
                        id: metaV2.id, name: metaV2.name,
                        files: (metaV2.files || []).map((pfV2: any) => {
                            if (!pfV2 || typeof pfV2.path !== 'string') return null; // Basic validation
                            try {
                                const fileUri = vscode.Uri.file(pfV2.path);
                                const parentUri = pfV2.parent ? vscode.Uri.file(pfV2.parent) : undefined;
                                return { uri: fileUri.toString(), isDirectory: !!pfV2.isDirectory, parentUri: parentUri?.toString() };
                            } catch (e) { console.warn(`[Load Migration V2] Error converting path ${pfV2.path} to URI:`, e); return null; }
                        }).filter((pf: unknown): pf is PersistedFileEntry => pf !== null)
                    }));
                    loadedFromOldKey = true;
                }
            }

            // Migration from V1 (only session names/ids) if V2/V3 data not found
            if (!loadedData) {
                const oldDataV1 = this.context.workspaceState.get<{ id: string, name: string }[]>(SessionManager.OLD_STORAGE_KEY_V1);
                if (oldDataV1 && oldDataV1.length > 0) {
                    console.log("[Load] Migrating data from V1 storage key (basic).");
                    loadedData = oldDataV1.map(metaV1 => ({ id: metaV1.id, name: metaV1.name, files: [] })); // Create sessions with empty file lists
                    loadedFromOldKey = true;
                } else {
                    loadedData = []; // Ensure loadedData is an array if nothing was found
                }
            }

            // Process loaded/migrated data (now assumed to be in PersistedSession[] format)
            (loadedData as PersistedSession[]).forEach(meta => {
                // Validate basic structure
                if (!meta || typeof meta.id !== 'string' || typeof meta.name !== 'string' || !Array.isArray(meta.files)) {
                    console.warn("[Load] Skipping invalid session metadata entry:", meta); return;
                }
                const session = new Session(meta.name, meta.id);
                // Restore files from persisted data
                const restoredFiles: FileEntry[] = meta.files.map((pf): FileEntry | null => {
                    // Validate each persisted file entry
                    if (!pf || typeof pf.uri !== 'string' || typeof pf.isDirectory !== 'boolean') {
                        console.warn(`[Load] Skipping invalid persisted file entry in session ${meta.id}:`, pf); return null;
                    }
                    // Validate URIs can be parsed
                    try {
                        vscode.Uri.parse(pf.uri); // Check main URI
                        if (pf.parentUri) vscode.Uri.parse(pf.parentUri); // Check parent URI if exists
                        // Create the internal FileEntry object (content is null initially)
                        return { uriString: pf.uri, isDirectory: pf.isDirectory, parentUriString: pf.parentUri, content: null, sessionId: session.id };
                    } catch (e) { console.warn(`[Load] Skipping entry with invalid URI in session ${meta.id}:`, pf.uri, e); return null; }
                }).filter((entry): entry is FileEntry => entry !== null); // Filter out nulls and type guard
                session.storage.restoreFiles(restoredFiles);
                this.sessions.set(session.id, session);
            });

            console.log(`[Load] Loaded ${this.sessions.size} sessions.`);
            // If migrated from an old key, save immediately in the new format
            if (loadedFromOldKey) {
                console.log("[Load] Data migrated from older version, persisting in new format.");
                this.persistSessions();
            }

        } catch (e) {
            console.error("[Load] Error loading session data:", e);
            this.sessions.clear(); // Clear potentially corrupted data
            vscode.window.showErrorMessage("Error loading File Integrator session data. Sessions may be reset.");
        }

        // Ensure there's always at least one session
        if (this.sessions.size === 0) {
            console.log("[Load] No sessions found or loaded, creating default session.");
            this.createSession("Default Session"); // Don't persist here, createSession already does
        }
    }

    dispose() {
        this.getAllSessions().forEach(s => s.dispose());
        this.sessions.clear();
    }
}

// --- Tree View Items (Keep Existing) ---
type IntegratorTreeItem = SessionItem | ResourceItem;
class SessionItem extends vscode.TreeItem { /* Keep Existing */
    constructor(
        public readonly session: Session,
        collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Collapsed
    ) {
        super(session.name, collapsibleState);
        this.id = session.id; // Use session ID as the tree item ID
        this.contextValue = 'session'; // Used for menu filtering
        this.iconPath = new vscode.ThemeIcon('folder-library'); // Or 'briefcase' or 'database'
        this.tooltip = `Session: ${session.name}`;
        // Show item count in description
        this.description = `(${session.storage.files.length} items)`;
    }
}
class ResourceItem extends vscode.TreeItem { /* Keep Existing */
    constructor(
        public readonly entry: FileEntry,
        collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        const uri = vscode.Uri.parse(entry.uriString);
        let label = '';
        const uriPath = uri.path;
        const bangIndex = uri.toString().lastIndexOf('!/'); // Check for archive paths like jar:file:/.../lib.jar!/path/to/Class.class

        // Handle archive paths for label
        if (bangIndex !== -1) {
            const fullUriStr = uri.toString();
            // Extract path inside the archive
            const internalPath = fullUriStr.substring(bangIndex + 1);
            // Get the base name from the internal path
            label = path.basename(internalPath.startsWith('/') ? internalPath.substring(1) : internalPath);
        } else {
            // Standard file path label
            label = path.basename(uriPath);
        }

        // Fallback for non-file URIs or if basename extraction failed
        if (!label && uri.scheme !== 'file') {
            label = uri.toString().substring(uri.scheme.length + 1); // e.g., untitled:Untitled-1 -> Untitled-1
            if (label.startsWith('//')) label = label.substring(2); // Handle authorities like git://
        }
        if (!label) label = entry.uriString; // Absolute fallback

        super(label, collapsibleState); // Use the extracted label

        // Set unique ID combining session and URI
        this.id = `${entry.sessionId}::${entry.uriString}`;
        this.resourceUri = uri; // Make the URI available

        // Command to open non-directory items on click
        if (!entry.isDirectory) {
            this.command = { command: 'vscode.open', title: "Open Resource", arguments: [uri] };
            this.collapsibleState = vscode.TreeItemCollapsibleState.None; // Files are not expandable
        }

        // Set tooltip and description using helper function
        this.tooltip = `${entry.isDirectory ? 'Directory (Git Diff applies to tracked files within)' : 'Resource (Git Diff applies if tracked)'}:\n${getDisplayUri(entry.uriString, 'tooltip')}`;
        this.description = getDisplayUri(entry.uriString, 'treeDescription'); // Show context path as description

        // Set context value for menu filtering
        this.contextValue = entry.isDirectory ? 'resourceDirectory' : 'resourceFile';
        this.iconPath = entry.isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    }

    // Convenience getters
    get sessionId(): string { return this.entry.sessionId; }
    get uriString(): string { return this.entry.uriString; }
    get isDirectory(): boolean { return this.entry.isDirectory; }
}

// --- Tree Data Provider (Update handleDrop for Drag & Drop Exclusions) ---
class FileIntegratorProvider implements vscode.TreeDataProvider<IntegratorTreeItem>, vscode.TreeDragAndDropController<IntegratorTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<IntegratorTreeItem | undefined | null | void> = new vscode.EventEmitter();
    readonly onDidChangeTreeData: vscode.Event<IntegratorTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;
    readonly dropMimeTypes = ['text/uri-list', 'application/vnd.code.tree.fileIntegratorView']; // Accept external files and internal items
    readonly dragMimeTypes = ['application/vnd.code.tree.fileIntegratorView']; // Allow dragging internal items
    private readonly customMimeType = 'application/vnd.code.tree.fileIntegratorView';

    constructor(private sessionManager: SessionManager) { }

    getTreeItem(element: IntegratorTreeItem): vscode.TreeItem { return element; }

    getChildren(element?: IntegratorTreeItem): vscode.ProviderResult<IntegratorTreeItem[]> {
        if (!element) { // Root level: Show Sessions
            return Promise.resolve(this.sessionManager.getAllSessions().map(s => new SessionItem(s,
                s.storage.files.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None // Collapse if not empty
            )));
        }
        if (element instanceof SessionItem) { // Session level: Show root items in the session
            const session = this.sessionManager.getSession(element.session.id);
            if (!session) return [];
            // Filter files to get only top-level items (no parentUriString)
            const rootEntries = session.storage.files.filter(f => !f.parentUriString);
            return Promise.resolve(rootEntries.map(e => new ResourceItem(e,
                e.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None // Directories are collapsible
            )));
        }
        if (element instanceof ResourceItem && element.isDirectory) { // Directory level: Show children
            const session = this.sessionManager.getSession(element.sessionId);
            if (!session) return [];
            // Filter files to get items whose parent is the current directory's URI
            const childEntries = session.storage.files.filter(f => f.parentUriString === element.uriString);
            return Promise.resolve(childEntries.map(e => new ResourceItem(e,
                e.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
            )));
        }
        // Should not happen for files or other item types
        return Promise.resolve([]);
    }

    refresh(element?: IntegratorTreeItem): void { this._onDidChangeTreeData.fire(element); }

    // --- Drag and Drop Implementation ---

    handleDrag(source: readonly IntegratorTreeItem[], dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): void | Thenable<void> {
        // Only allow dragging ResourceItems (files/dirs within sessions)
        const draggableItems = source.filter((item): item is ResourceItem => item instanceof ResourceItem);
        if (draggableItems.length > 0) {
            // Store identifiers (session::uri) of dragged items
            const draggedIds = draggableItems.map(item => `${item.sessionId}::${item.uriString}`);
            dataTransfer.set(this.customMimeType, new vscode.DataTransferItem(draggedIds));
        }
        // Do not allow dragging SessionItems themselves
    }

    async handleDrop(target: IntegratorTreeItem | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
        const internalDropItem = dataTransfer.get(this.customMimeType);
        const externalDropItem = dataTransfer.get('text/uri-list'); // From Explorer, etc.

        if (token.isCancellationRequested) return;

        // --- Handle Internal Reorder Drop ---
        if (internalDropItem) {
            const draggedItemIds = internalDropItem.value as string[]; // Value is string[] we set in handleDrag
            if (!Array.isArray(draggedItemIds) || draggedItemIds.length === 0) return;

            // Extract session ID and URIs from the first dragged item (assume all from same session for now)
            const firstIdParts = draggedItemIds[0].split('::');
            if (firstIdParts.length < 2) { console.warn('[handleDrop] Invalid dragged item ID format.'); return; }
            const sessionId = firstIdParts[0];
            const draggedUriStrings = draggedItemIds.map(id => id.substring(id.indexOf('::') + 2)).filter(Boolean); // Get URI part

            const session = this.sessionManager.getSession(sessionId);
            if (!session) { console.error(`[handleDrop] Session not found for internal drop: ${sessionId}`); return; }

            let targetUriString: string | undefined;
            let dropOnSessionNode = false;
            let targetParentUriString: string | undefined; // Parent of the drop target location

            if (target instanceof SessionItem) {
                // Dropping onto a session node means moving to the root level of that session
                if (target.session.id !== sessionId) {
                    vscode.window.showErrorMessage("Cannot move items between sessions yet."); // TODO: Implement cross-session move later if needed
                    return;
                }
                dropOnSessionNode = true;
                targetParentUriString = undefined; // Root level has undefined parent
            } else if (target instanceof ResourceItem) {
                // Dropping onto another resource item
                if (target.sessionId !== sessionId) {
                    vscode.window.showErrorMessage("Cannot move items between sessions yet.");
                    return;
                }
                targetUriString = target.uriString; // Target is the item we drop *before*
                targetParentUriString = target.entry.parentUriString; // Target parent is the parent of the item dropped onto
            } else {
                // Dropping onto empty space (not on a specific item) within the view
                // Assume drop into the root of the first session if no target? Or disallow?
                // For simplicity, let's assume dropping in empty space means dropping onto the nearest session node visually
                // This case needs more defined behavior. Let's require dropping *onto* an item for now.
                console.log("[handleDrop] Drop target is undefined (empty space). Requires dropping onto Session or Resource item.");
                return;
            }

            // Check if parents match (or if dropping on session to move to root)
            const firstDraggedItem = session.storage.findEntry(draggedUriStrings[0]);
            if (!firstDraggedItem) return; // Should not happen
            const sourceParentUriString = firstDraggedItem.parentUriString;

            if (!dropOnSessionNode && sourceParentUriString !== targetParentUriString) {
                vscode.window.showWarningMessage("Cannot move items between different directory levels yet.");
                return;
            }


            // Perform the reorder in storage
            const success = session.storage.reorderItems(draggedUriStrings, targetUriString, dropOnSessionNode);

            if (success) {
                this.sessionManager.persistSessions(); // Save the new order
                await updateCodeBlockDocument(session); // Update associated doc if open
                this.refresh(); // Refresh the tree view
            } else {
                this.refresh(); // Refresh even on failure to reset visual state if needed
            }
        }
        // --- Handle External File/Folder Drop (from Explorer) ---
        else if (externalDropItem) {
            let targetSession: Session | undefined;

            // Determine the target session based on where the drop occurred
            if (target instanceof SessionItem) {
                targetSession = target.session;
            } else if (target instanceof ResourceItem) {
                // If dropped on a resource, add to that resource's session
                targetSession = this.sessionManager.getSession(target.sessionId);
            } else {
                // If dropped on empty space, add to the first session (or prompt?)
                const sessions = this.sessionManager.getAllSessions();
                targetSession = sessions[0]; // Default to the first session
                if (targetSession && sessions.length > 1) {
                    // Maybe prompt if multiple sessions exist? For now, just inform.
                    vscode.window.showInformationMessage(`Added resources to the first session: "${targetSession.name}"`);
                } else if (!targetSession) {
                    vscode.window.showErrorMessage("Cannot add resources: No sessions exist.");
                    return; // No session to add to
                }
            }

            if (!targetSession) {
                vscode.window.showErrorMessage("Could not determine target session for drop.");
                return;
            }

            const uriListString = await externalDropItem.asString();
            const uriStrings = uriListString.split('\n').map(u => u.trim()).filter(Boolean);
            if (uriStrings.length === 0) return;

            let resourcesWereAdded = false;
            let skippedCount = 0;
            const skippedExclusion: string[] = []; // Track files skipped due to exclusion

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Adding to session "${targetSession.name}"...`,
                cancellable: true
            }, async (progress, progressToken) => {
                progressToken.onCancellationRequested(() => {
                    console.log("User cancelled resource adding.");
                });

                for (let i = 0; i < uriStrings.length; i++) {
                    if (progressToken.isCancellationRequested) break;
                    const uriStr = uriStrings[i];
                    let currentUri: vscode.Uri | undefined;
                    try {
                        currentUri = vscode.Uri.parse(uriStr, true); // Strict parsing
                        const displayPath = currentUri.scheme === 'file' ? currentUri.fsPath : uriStr;

                        // *** Check DRAG & DROP exclusion ('fileintegrator.exclude') here ***
                        // This is the primary check for top-level dragged items.
                        if (currentUri.scheme === 'file' && isPathExcluded(displayPath)) {
                            console.log(`[Exclude][HandleDrop] Skipping excluded: ${displayPath}`);
                            skippedExclusion.push(path.basename(displayPath));
                            skippedCount++;
                            continue; // Skip this URI entirely
                        }

                        progress.report({ message: `(${i + 1}/${uriStrings.length}) Adding ${getDisplayUri(uriStr, 'treeDescription')}`, increment: (1 / uriStrings.length) * 100 });

                        // addResource handles recursion and its own internal exclusion checks
                        if (await targetSession!.storage.addResource(currentUri)) {
                            resourcesWereAdded = true;
                        } else {
                            // Could be duplicate or internal exclusion during recursion
                            // We don't double-count skips here as addResource handles its own logging
                            // If addResource returned false and it wasn't excluded here, it's likely a duplicate
                            if (!(currentUri.scheme === 'file' && isPathExcluded(displayPath))) {
                                console.log(`[handleDrop] Item likely skipped as duplicate or error during add: ${uriStr}`);
                                // Consider adding to a general skipped count if not excluded
                            }
                        }
                    } catch (err: any) {
                        const displayUriStr = currentUri?.toString() ?? uriStr;
                        vscode.window.showErrorMessage(`Error processing ${getDisplayUri(displayUriStr)}: ${err.message}`);
                        console.error(`Error processing URI ${displayUriStr}:`, err);
                        skippedCount++; // Count errors as skipped
                    }
                }
            }); // End withProgress

            if (resourcesWereAdded) {
                this.sessionManager.persistSessions(); // Save changes
                await updateCodeBlockDocument(targetSession); // Update associated doc
            }

            // Provide feedback on skipped items
            let message = '';
            if (resourcesWereAdded && skippedExclusion.length > 0) message = `Added items. Skipped ${skippedExclusion.length} due to exclusion rules: ${skippedExclusion.slice(0, 3).join(', ')}${skippedExclusion.length > 3 ? '...' : ''}`;
            else if (resourcesWereAdded && skippedCount > 0) message = `Added items. ${skippedCount} other item(s) were skipped (duplicates, errors).`;
            else if (!resourcesWereAdded && skippedExclusion.length > 0) message = `No new items added. Skipped ${skippedExclusion.length} due to exclusion rules: ${skippedExclusion.slice(0, 3).join(', ')}${skippedExclusion.length > 3 ? '...' : ''}`;
            else if (!resourcesWereAdded && skippedCount > 0) message = `No new items added. ${skippedCount} item(s) were skipped (duplicates, errors).`;

            if (message) vscode.window.showInformationMessage(message);

            this.refresh(); // Refresh the view regardless
        } else {
            console.log('[handleDrop] No supported data transfer item found.');
        }
    }
}

// --- Global Variables & Activation (Keep Existing, Add Git API) ---
let sessionManager: SessionManager;
let fileIntegratorProvider: FileIntegratorProvider;
let treeView: vscode.TreeView<IntegratorTreeItem>;
let gitAPI: GitAPI | undefined; // Store the Git API instance

export async function activate(context: vscode.ExtensionContext) {
    console.log('Activating File Integrator...');

    // --- Git API Acquisition ---
    try {
        const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
        if (gitExtension) {
            if (!gitExtension.isActive) {
                console.log('Activating vscode.git extension...');
                await gitExtension.activate(); // Ensure the Git extension is active
            }
            gitAPI = gitExtension.exports.getAPI(1); // Get API version 1
            if (gitAPI) {
                console.log('File Integrator: Successfully obtained Git API.');
                // Optional: Log repositories found at startup
                // gitAPI.repositories.forEach(repo => console.log(`Found Git repo: ${repo.rootUri.fsPath}`));
                // gitAPI.onDidOpenRepository(repo => console.log(`Git repo opened: ${repo.rootUri.fsPath}`));
                // gitAPI.onDidCloseRepository(repo => console.log(`Git repo closed: ${repo.rootUri.fsPath}`));
            } else {
                console.error('File Integrator: Failed to get Git API from vscode.git extension.');
                vscode.window.showWarningMessage('File Integrator: Could not initialize Git features. Git API unavailable.');
            }
        } else {
            console.warn('File Integrator: vscode.git extension not found.');
            vscode.window.showWarningMessage('File Integrator: vscode.git extension not installed or disabled. Git features unavailable.');
        }
    } catch (error) {
        console.error('File Integrator: Failed to get/activate Git API:', error);
        vscode.window.showWarningMessage('File Integrator: Could not initialize Git features due to an error.');
    }
    // --- End Git API Acquisition ---

    sessionManager = new SessionManager(context);
    sessionManager.loadSessions(); // Load existing sessions

    fileIntegratorProvider = new FileIntegratorProvider(sessionManager);
    treeView = vscode.window.createTreeView('fileIntegratorView', {
        treeDataProvider: fileIntegratorProvider,
        dragAndDropController: fileIntegratorProvider, // Enable drag/drop
        showCollapseAll: true, // Add collapse all button
        canSelectMany: true // Allow multi-select for potential future actions
    });
    context.subscriptions.push(treeView);

    registerCommands(context); // Register all commands

    // Clean up session manager on deactivate
    context.subscriptions.push({ dispose: () => sessionManager.dispose() });

    console.log('File Integrator activated.');
}

// --- Command Registration (Add New Commands) ---
function registerCommands(context: vscode.ExtensionContext) {
    const register = (commandId: string, callback: (...args: any[]) => any) => {
        context.subscriptions.push(vscode.commands.registerCommand(commandId, callback));
    };

    // --- Existing Session Commands ---
    register('fileintegrator.addSession', async () => {
        const n = await vscode.window.showInputBox({ prompt: "Enter new session name", value: `Session ${sessionManager.getAllSessions().length + 1}` });
        if (n?.trim()) { const s = sessionManager.createSession(n.trim()); fileIntegratorProvider.refresh(); await treeView.reveal(new SessionItem(s), { select: true, focus: true, expand: true }); }
    });
    register('fileintegrator.removeSession', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to remove');
        if (!s) return;
        if (await vscode.window.showWarningMessage(`Remove session "${s.name}" and close its associated document (if open)?`, { modal: true }, 'Yes') === 'Yes') {
            await s.closeAssociatedDocument(true); // Attempt to close editor
            if (sessionManager.removeSession(s.id)) fileIntegratorProvider.refresh();
        }
    });
    register('fileintegrator.renameSession', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to rename');
        if (!s) return;
        const n = await vscode.window.showInputBox({ prompt: `Enter new name for "${s.name}"`, value: s.name });
        if (n?.trim() && n.trim() !== s.name && sessionManager.renameSession(s.id, n.trim())) {
            fileIntegratorProvider.refresh();
            // If associated doc exists, maybe update its name? For now, just refresh tree.
        }
    });
    register('fileintegrator.clearSession', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to clear');
        if (!s) return;
        if (s.storage.files.length === 0) { vscode.window.showInformationMessage(`Session "${s.name}" is already empty.`); return; }
        // Removed confirmation for faster workflow as per 0.0.7 release notes
        const count = s.storage.clearFiles();
        sessionManager.persistSessions();
        fileIntegratorProvider.refresh();
        await updateCodeBlockDocument(s); // Update associated doc
        vscode.window.showInformationMessage(`Cleared ${count} items from session "${s.name}".`);
    });

    // --- Existing Content Generation & Copying ---
    register('fileintegrator.generateCodeBlock', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to generate code block for');
        if (!s) return;
        if (s.storage.files.length === 0) { // Check all files, not just resourcesOnly, maybe user wants to see empty state
            vscode.window.showInformationMessage(`Session "${s.name}" is empty.`);
            // Optionally open an empty doc: await showCodeBlockDocument(s);
            return;
        }
        const doc = await showCodeBlockDocument(s);
        if (doc) await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
    });
    register('fileintegrator.copyToClipboard', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to copy content from');
        if (!s) return;
        if (s.storage.resourcesOnly.length === 0) { vscode.window.showInformationMessage(`Session "${s.name}" contains no file/resource content to copy.`); return; }
        let contentToCopy = '';
        // If doc is open and valid, copy from it (might have user edits)
        if (s.associatedDocument && !s.associatedDocument.isClosed) {
            contentToCopy = s.associatedDocument.getText();
            console.log(`[CopyToClipboard] Copying from associated document for session ${s.id}`);
        } else {
            // Otherwise, generate fresh content
            console.log(`[CopyToClipboard] Generating fresh content for session ${s.id}`);
            contentToCopy = await generateMarkdownContent(s);
        }
        if (contentToCopy && !contentToCopy.startsWith('<!-- No file/resource content')) {
            await vscode.env.clipboard.writeText(contentToCopy);
            vscode.window.showInformationMessage(`Session "${s.name}" Code Block content copied!`);
        } else { vscode.window.showWarningMessage("No code block content generated or found to copy."); }
    });

    // --- NEW: Directory-specific Content Generation (Optional, added from package.json) ---
    register('fileintegrator.generateDirectoryCodeBlock', async (item: ResourceItem) => {
        if (!(item instanceof ResourceItem) || !item.isDirectory) return;
        const session = sessionManager.getSession(item.sessionId);
        if (!session) return;
        const directoryName = path.basename(item.resourceUri?.fsPath || 'directory');
        const descendants = getDescendantEntries(session, item.uriString).filter(e => !e.isDirectory); // Only files
        if (descendants.length === 0) { vscode.window.showInformationMessage(`Directory "${directoryName}" contains no file content within the session.`); return; }

        const content = await generateMarkdownContentForEntries(descendants, `Content for Directory: ${directoryName}`);
        const doc = await vscode.workspace.openTextDocument({ content: content, language: 'markdown' });
        await vscode.window.showTextDocument(doc, { preview: false });
    });
    register('fileintegrator.copyDirectoryContentToClipboard', async (item: ResourceItem) => {
        if (!(item instanceof ResourceItem) || !item.isDirectory) return;
        const session = sessionManager.getSession(item.sessionId);
        if (!session) return;
        const directoryName = path.basename(item.resourceUri?.fsPath || 'directory');
        const descendants = getDescendantEntries(session, item.uriString).filter(e => !e.isDirectory);
        if (descendants.length === 0) { vscode.window.showInformationMessage(`Directory "${directoryName}" contains no file content to copy.`); return; }

        const content = await generateMarkdownContentForEntries(descendants, `Content for Directory: ${directoryName}`);
        await vscode.env.clipboard.writeText(content);
        vscode.window.showInformationMessage(`Content for directory "${directoryName}" copied!`);
    });

    // --- Existing Item Management ---
    register('fileintegrator.removeItem', async (item: ResourceItem) => {
        if (!(item instanceof ResourceItem)) return; // Ensure it's a resource item
        const s = sessionManager.getSession(item.sessionId);
        if (s && s.storage.removeEntry(item.uriString)) {
            sessionManager.persistSessions();
            await updateCodeBlockDocument(s); // Update associated doc
            fileIntegratorProvider.refresh();
        } else {
            // Maybe the item wasn't found, refresh just in case
            fileIntegratorProvider.refresh();
        }
    });
    register('fileintegrator.refreshView', () => fileIntegratorProvider.refresh());

    // --- Existing Adding Items ---
    register('fileintegrator.addActiveEditorToSession', async (item?: SessionItem) => {
        const targetSession = item?.session ?? await selectSession("Select session to add active editor to");
        if (targetSession) await addActiveEditorLogic(targetSession);
    });
    register('fileintegrator.addAllOpenEditorsToSession', async (item?: SessionItem) => {
        const session = item?.session ?? await selectSession("Select session to add all open editors to");
        if (session) await addAllOpenEditorsLogic(session);
    });

    // --- NEW: Copy Directory Structure Command ---
    register('fileintegrator.copyDirectoryStructure', async (item?: SessionItem | ResourceItem) => {
        let session: Session | undefined;
        let startingEntries: FileEntry[] = [];
        let baseUriString: string | undefined; // URI of the item being copied (for relative paths)
        let scopeName = '';

        if (item instanceof SessionItem) {
            session = item.session;
            startingEntries = session.storage.files.filter(f => !f.parentUriString); // Root items
            baseUriString = undefined; // Indicate copying from session root
            scopeName = `session "${session.name}"`;
        } else if (item instanceof ResourceItem && item.isDirectory) {
            session = sessionManager.getSession(item.sessionId);
            if (!session) return;
            startingEntries = session.storage.files.filter(f => f.parentUriString === item.uriString); // Direct children
            baseUriString = item.uriString;
            scopeName = `directory "${path.basename(item.resourceUri?.fsPath || 'directory')}"`;
        } else if (item instanceof ResourceItem && !item.isDirectory) {
            vscode.window.showInformationMessage("Cannot copy structure of a single file.");
            return;
        } else {
            // No specific item context, maybe prompt? For now, require context.
            vscode.window.showWarningMessage("Please right-click on a Session or Directory item to copy its structure.");
            return;
            // Alternative: Prompt to select session/directory if no context.
            // session = await selectSession("Select session to copy structure from");
            // if (!session) return;
            // startingEntries = session.storage.files.filter(f => !f.parentUriString);
            // baseUriString = undefined;
            // scopeName = `session "${session.name}"`;
        }

        if (!session) {
            vscode.window.showErrorMessage("Could not find the session for the selected item.");
            return;
        }
        // Include the starting directory itself in the output if copying a directory
        const rootEntry = baseUriString ? session.storage.findEntry(baseUriString) : null;
        if (!rootEntry && baseUriString) {
            vscode.window.showErrorMessage("Could not find the starting directory entry.");
            return;
        }

        // Get exclusion patterns
        const excludePatterns = vscode.workspace.getConfiguration('fileintegrator').get<Record<string, boolean>>('excludeFromTree') || {};
        const exclusionCheck = (relativePath: string) => isPathExcludedFromTree(relativePath, excludePatterns);

        try {
            console.log(`[CopyStructure] Building structure for ${scopeName}`);
            let structureString = '';
            if (rootEntry) {
                // Start with the root directory name if copying a specific directory
                structureString += `${path.basename(vscode.Uri.parse(rootEntry.uriString).fsPath || rootEntry.uriString)}\n`;
                structureString += buildStructureStringRecursive(startingEntries, session, "  ", 1, rootEntry.uriString, exclusionCheck);
            } else {
                // If copying a session, list root items directly
                structureString += buildStructureStringRecursive(startingEntries, session, "", 0, undefined, exclusionCheck); // No initial prefix for session root items
            }


            if (structureString.trim() === '' && rootEntry) {
                structureString = `${path.basename(vscode.Uri.parse(rootEntry.uriString).fsPath || rootEntry.uriString)}\n(Directory is empty or all contents excluded)`;
            } else if (structureString.trim() === '') {
                structureString = `(Session is empty or all contents excluded)`;
            }

            await vscode.env.clipboard.writeText(structureString.trimEnd());
            vscode.window.showInformationMessage(`Directory structure for ${scopeName} copied to clipboard!`);
            console.log(`[CopyStructure] Copied:\n${structureString.trimEnd()}`);
        } catch (error: any) {
            console.error(`[CopyStructure] Error building structure for ${scopeName}:`, error);
            vscode.window.showErrorMessage(`Failed to copy structure: ${error.message}`);
        }
    });

    // --- NEW: Git Diff Commands ---
    const diffHandler = async (item: SessionItem | ResourceItem | undefined, copy: boolean) => {
        if (!gitAPI) { vscode.window.showErrorMessage("Git integration is not available."); return; }

        let session: Session | undefined;
        let entriesToDiff: FileEntry[] = [];
        let scopeName = '';

        if (item instanceof SessionItem) {
            session = item.session;
            entriesToDiff = [...session.storage.files]; // All items in the session
            scopeName = `session "${session.name}"`;
        } else if (item instanceof ResourceItem) {
            session = sessionManager.getSession(item.sessionId);
            if (!session) return;
            const baseName = path.basename(item.resourceUri?.fsPath || item.uriString);
            if (item.isDirectory) {
                entriesToDiff = getDescendantEntries(session, item.uriString); // Dir + descendants
                scopeName = `directory "${baseName}"`;
            } else {
                entriesToDiff = [item.entry]; // Just the single file
                scopeName = `file "${baseName}"`;
            }
        } else {
            // No context, prompt for session
            session = await selectSession(`Select session to ${copy ? 'copy' : 'generate'} Git diff for`);
            if (!session) return;
            entriesToDiff = [...session.storage.files];
            scopeName = `session "${session.name}"`;
        }

        if (!session) { vscode.window.showErrorMessage("Could not determine session for Git Diff."); return; }
        if (entriesToDiff.length === 0) { vscode.window.showInformationMessage(`No items found in ${scopeName} to diff.`); return; }

        // Filter out non-file scheme items before passing to diff calculation
        const fileSystemEntries = entriesToDiff.filter(entry => {
            try { return vscode.Uri.parse(entry.uriString).scheme === 'file'; }
            catch { return false; }
        });

        if (fileSystemEntries.length === 0) {
            vscode.window.showInformationMessage(`No file system items found in ${scopeName} to diff with Git.`);
            return;
        }

        console.log(`[Diff] Initiating diff for ${scopeName} (${fileSystemEntries.length} potential file system items)`);
        await generateDiffCommon(
            fileSystemEntries, // Pass only file system entries
            scopeName,
            (msg) => vscode.window.showInformationMessage(msg), // Use info message for status
            copy
        );
    };

    // Register the specific diff commands, routing them to the common handler
    register('fileintegrator.generateDiffDocument', (item?: SessionItem) => diffHandler(item, false));
    register('fileintegrator.copyDiffToClipboard', (item?: SessionItem) => diffHandler(item, true));
    register('fileintegrator.generateDirectoryDiffDocument', (item: ResourceItem) => diffHandler(item, false));
    register('fileintegrator.copyDirectoryDiffToClipboard', (item: ResourceItem) => diffHandler(item, true));
    register('fileintegrator.generateFileDiffDocument', (item: ResourceItem) => diffHandler(item, false));
    register('fileintegrator.copyFileDiffToClipboard', (item: ResourceItem) => diffHandler(item, true));
}

// --- Command Logic Helpers (Keep Existing, Add New) ---

/** Logic for adding the active editor's resource to a session. */
async function addActiveEditorLogic(targetSession: Session) { /* Keep Existing */
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showInformationMessage("No active editor found."); return; }
    const { uri } = editor.document;
    const uriString = uri.toString();

    // Prevent adding the session's own associated document
    if (editor.document === targetSession.associatedDocument) {
        vscode.window.showInformationMessage("Cannot add the session's own generated document to itself.");
        return;
    }

    // Check if already exists
    if (targetSession.storage.findEntry(uriString)) {
        vscode.window.showInformationMessage(`"${getDisplayUri(uriString, 'treeDescription')}" is already in session "${targetSession.name}".`);
        return;
    }

    // Add the item (content will be loaded on demand or if already cached by editor)
    // For active editor, we assume it's a file, not a directory.
    const newEntry: FileEntry = { uriString: uriString, isDirectory: false, content: null /* Load on demand */, sessionId: targetSession.id };
    if (targetSession.storage.addItem(newEntry)) {
        sessionManager.persistSessions(); // Save the change
        await updateCodeBlockDocument(targetSession); // Update associated doc if open
        fileIntegratorProvider.refresh(); // Update tree view
        vscode.window.showInformationMessage(`Added "${getDisplayUri(uriString, 'treeDescription')}" to session "${targetSession.name}".`);
    } else {
        // This case should be rare now due to the check above, but handle defensively
        vscode.window.showWarningMessage(`Failed to add "${getDisplayUri(uriString)}". It might already exist.`);
    }
}

/** Logic for adding all unique open editor resources to a session. */
async function addAllOpenEditorsLogic(targetSession: Session) { /* Keep Existing */
    const openUris = new Set<string>();
    const sessionDocUriString = targetSession.associatedDocument?.uri.toString(); // Get URI of the session's doc

    // Iterate through all visible tabs in all tab groups
    vscode.window.tabGroups.all.forEach(group => {
        group.tabs.forEach(tab => {
            // The input usually holds the URI for file-based tabs
            const uri = (tab.input as any)?.uri;
            if (uri instanceof vscode.Uri) {
                const uriString = uri.toString();
                // Add if it's not the session's own document
                if (uriString !== sessionDocUriString) {
                    openUris.add(uriString);
                }
            }
        });
    });

    if (openUris.size === 0) {
        vscode.window.showInformationMessage("No other unique open editors found to add.");
        return;
    }

    let addedCount = 0;
    let skippedCount = 0;
    openUris.forEach(uriString => {
        // Check if the URI is already in the target session
        if (targetSession.storage.findEntry(uriString)) {
            skippedCount++;
        } else {
            // Add as a new file entry (assume they are files, not dirs)
            const newEntry: FileEntry = { uriString: uriString, isDirectory: false, content: null, sessionId: targetSession.id };
            if (targetSession.storage.addItem(newEntry)) {
                addedCount++;
            } else {
                // Should not happen if findEntry check passed, but log just in case
                console.warn(`[addAllOpenEditors] Failed to add item ${uriString} even after existence check.`);
                skippedCount++; // Count as skipped if add failed unexpectedly
            }
        }
    });

    if (addedCount > 0) {
        sessionManager.persistSessions(); // Save the new items
        await updateCodeBlockDocument(targetSession); // Update associated doc
        fileIntegratorProvider.refresh(); // Refresh tree
        let message = `Added ${addedCount} editor(s) to "${targetSession.name}".`;
        if (skippedCount > 0) {
            message += ` Skipped ${skippedCount} (already present or session document).`;
        }
        vscode.window.showInformationMessage(message);
    } else if (skippedCount > 0) {
        vscode.window.showInformationMessage(`All open editors were already present in session "${targetSession.name}" or represent the session document.`);
    } else {
        // This case means openUris was > 0 but nothing was added or skipped - indicates a logic error.
        console.error("[addAllOpenEditors] Inconsistent state: Found open URIs but added/skipped count is zero.");
        vscode.window.showInformationMessage("No new editors were added.");
    }
}

// --- Deactivation (Keep Existing) ---
export function deactivate() {
    console.log('Deactivating File Integrator...');
    // Release Git API reference if held? Usually not necessary.
    gitAPI = undefined;
    // Other cleanup if needed
}

// --- Utility Functions (Add New, Modify Existing) ---

/**
 * Checks if a file system path matches **DRAG & DROP** exclusion patterns.
 * Uses `fileintegrator.exclude` setting.
 */
function isPathExcluded(filePath: string): boolean {
    const config = vscode.workspace.getConfiguration('fileintegrator');
    const excludePatterns = config.get<Record<string, boolean>>('exclude'); // Read the 'exclude' setting
    if (!excludePatterns || Object.keys(excludePatterns).length === 0) {
        return false; // No patterns defined
    }

    // Normalize path separators for consistent matching
    const normalizedFilePath = filePath.replace(/\\/g, '/');
    const workspaceFolders = vscode.workspace.workspaceFolders;
    // Standard options for minimatch: dot allows matching hidden files like .git
    const options = { dot: true, nocase: process.platform === 'win32' }; // Case-insensitive on Windows

    for (const pattern in excludePatterns) {
        if (excludePatterns[pattern] === true) { // Only consider patterns set to true
            const normalizedPattern = pattern.replace(/\\/g, '/');

            // 1. Direct match against the full normalized path
            if (minimatch(normalizedFilePath, normalizedPattern, options)) {
                // console.log(`[Exclude Match] Path: ${normalizedFilePath} matched pattern: ${normalizedPattern}`);
                return true;
            }

            // 2. Match against path relative to workspace folders
            if (workspaceFolders) {
                for (const folder of workspaceFolders) {
                    const folderPath = folder.uri.fsPath.replace(/\\/g, '/');
                    // Check if the file path starts with the workspace folder path
                    if (normalizedFilePath.startsWith(folderPath + '/')) {
                        const relativePath = normalizedFilePath.substring(folderPath.length + 1);
                        if (minimatch(relativePath, normalizedPattern, options)) {
                            // console.log(`[Exclude Match] Relative Path: ${relativePath} (in ${folder.name}) matched pattern: ${normalizedPattern}`);
                            return true;
                        }
                    }
                }
            }

            // 3. Match against basename if the pattern doesn't contain slashes (e.g., "node_modules" should match "/path/to/node_modules")
            // This helps match common directory names without requiring '**/' prefix in the pattern.
            if (!normalizedPattern.includes('/')) {
                if (minimatch(path.basename(normalizedFilePath), normalizedPattern, options)) {
                    // console.log(`[Exclude Match] Basename: ${path.basename(normalizedFilePath)} matched pattern: ${normalizedPattern}`);
                    return true;
                }
            }
        }
    }
    return false; // No matching exclusion pattern found
}

/**
 * NEW: Checks if a *relative* path matches **STRUCTURE COPY** exclusion patterns.
 * Uses `fileintegrator.excludeFromTree` setting.
 */
function isPathExcludedFromTree(relativePath: string, excludePatterns: Record<string, boolean>): boolean {
    if (!excludePatterns || Object.keys(excludePatterns).length === 0) {
        return false;
    }
    // Normalize separators just in case, although relative paths should ideally use '/'
    const normalizedRelativePath = relativePath.replace(/\\/g, '/');
    const options = { dot: true, nocase: process.platform === 'win32' }; // Match hidden files, case-insensitive on Win

    for (const pattern in excludePatterns) {
        if (excludePatterns[pattern] === true) {
            const normalizedPattern = pattern.replace(/\\/g, '/');
            // Match the relative path against the pattern
            if (minimatch(normalizedRelativePath, normalizedPattern, options)) {
                // console.log(`[ExcludeTree Match] Relative Path: ${normalizedRelativePath} matched pattern: ${normalizedPattern}`);
                return true;
            }
        }
    }
    return false;
}

/** Prompts user to select a session via Quick Pick. Returns undefined if cancelled. */
async function selectSession(placeHolder: string): Promise<Session | undefined> { /* Keep Existing */
    const sessions = sessionManager.getAllSessions(); // Already sorted by name
    if (sessions.length === 0) { vscode.window.showErrorMessage("No sessions available."); return undefined; }
    if (sessions.length === 1) return sessions[0]; // Auto-select if only one

    // Create QuickPick items
    const picks = sessions.map(s => ({ label: s.name, description: `(${s.storage.files.length} items)`, session: s }));
    const selection = await vscode.window.showQuickPick(picks, { placeHolder, canPickMany: false });
    return selection?.session; // Return the selected Session object or undefined
}

/**
 * Generates aggregated Markdown content for a specific list of FileEntry items.
 * Used by session generation and directory generation.
 */
async function generateMarkdownContentForEntries(entries: readonly FileEntry[], headerComment?: string): Promise<string> {
    let content = headerComment ? `<!-- ${headerComment} -->\n\n` : '';
    const resourceEntries = entries.filter(f => !f.isDirectory);

    if (resourceEntries.length === 0) {
        return headerComment
            ? `<!-- ${headerComment} -->\n<!-- No file/resource content found for the given entries. -->\n`
            : `<!-- No file/resource content found for the given entries. -->\n`;
    }
    console.log(`[MarkdownGenEntries] Generating content for ${resourceEntries.length} resources.`);

    for (const entry of resourceEntries) {
        let resourceContent: string | null = entry.content; // Use cached content if available

        // If content not cached or explicitly null, try reading it
        if (resourceContent === null) {
            try {
                const uri = vscode.Uri.parse(entry.uriString);
                console.log(`[MarkdownGenEntries] Reading content for URI: ${entry.uriString}`);
                // Use VS Code API to read content - handles different schemes (file:, untitled:, jar:, etc.)
                const doc = await vscode.workspace.openTextDocument(uri);
                resourceContent = doc.getText();
                // Optionally cache the read content back into the entry?
                // entry.content = resourceContent; // Be mindful of memory usage if caching large files
            } catch (error: any) {
                console.error(`[MarkdownGenEntries] Error reading URI ${entry.uriString}:`, error);
                const displayUri = getDisplayUri(entry.uriString);
                // Provide informative error messages based on common error types
                resourceContent = (error?.code === 'FileNotFound' || error?.code === 'EntryNotFound' || error?.message?.includes('cannot open') || error?.message?.includes('Unable to resolve'))
                    ? `--- Error: Resource not found or inaccessible (${displayUri}) ---`
                    : `--- Error reading content for ${displayUri}: ${error.message} ---`;
            }
        }

        const displayUri = getDisplayUri(entry.uriString, 'markdownHeader');
        // Determine language for syntax highlighting
        const uriPath = vscode.Uri.parse(entry.uriString).path;
        // Handle paths inside archives (e.g., .../file.jar!/com/example/MyClass.java)
        const langPart = uriPath.includes('!/') ? uriPath.substring(uriPath.lastIndexOf('!/') + 1) : uriPath;
        const ext = path.extname(langPart);
        const lang = ext ? ext.substring(1) : ''; // Get extension without the dot

        content += `### ${displayUri}\n\`\`\`${lang}\n${resourceContent ?? '--- Content Unavailable ---'}\n\`\`\`\n\n`;
    }
    return content.trimEnd(); // Remove trailing whitespace/newlines
}


/** Generates aggregated Markdown content for a *whole session*, respecting order. */
async function generateMarkdownContent(session: Session): Promise<string> {
    return generateMarkdownContentForEntries(session.storage.files, `Content for Session: ${session.name}`);
}


/** Ensures the code block document for a session is visible and up-to-date. */
async function showCodeBlockDocument(session: Session): Promise<vscode.TextDocument | undefined> { /* Keep Existing */
    const content = await generateMarkdownContent(session); // Generate fresh content

    // If a document is already associated and open, update it
    if (session.associatedDocument && !session.associatedDocument.isClosed) {
        const doc = session.associatedDocument;
        try {
            const edit = new vscode.WorkspaceEdit();
            // Replace the entire document content
            edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), content);
            const success = await vscode.workspace.applyEdit(edit);
            if (!success) throw new Error("ApplyEdit failed to update document");
            console.log(`[ShowDoc] Updated associated document for session ${session.id}`);
            return doc; // Return the updated document
        } catch (e) {
            console.error(`[ShowDoc] Error updating associated doc ${doc.uri}:`, e);
            // If update fails, detach the link and try creating a new one
            await session.closeAssociatedDocument(false); // Detach link, don't try closing editor window again
            return createNewAssociatedDocument(session, content); // Fallback to creating new
        }
    }

    // Otherwise, create a new document
    return createNewAssociatedDocument(session, content);
}

/** Helper function solely for creating a new associated Markdown document. */
async function createNewAssociatedDocument(session: Session, content: string): Promise<vscode.TextDocument | undefined> { /* Keep Existing */
    try {
        console.log(`[ShowDoc] Creating new associated document for session ${session.id}`);
        // Create an untitled document with the generated content
        const doc = await vscode.workspace.openTextDocument({ content: content, language: 'markdown' });
        session.setAssociatedDocument(doc); // Associate the new document with the session
        return doc;
    } catch (e: any) {
        console.error(`[ShowDoc] Failed to create associated document:`, e);
        vscode.window.showErrorMessage(`Failed to create associated document: ${e.message}`);
        session.closeAssociatedDocument(false); // Ensure no dangling association on failure
        return undefined;
    }
}

/** Updates the associated document content *if* it exists and is open, without showing it. */
async function updateCodeBlockDocument(session: Session): Promise<void> { /* Keep Existing */
    // Only update if the document exists, is associated, and is currently open
    if (session.associatedDocument && !session.associatedDocument.isClosed) {
        const doc = session.associatedDocument;
        console.log(`[UpdateDoc] Updating associated document in background for session ${session.id}`);
        const content = await generateMarkdownContent(session); // Regenerate content
        try {
            const edit = new vscode.WorkspaceEdit();
            // Replace entire content
            edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), content);
            const success = await vscode.workspace.applyEdit(edit);
            if (!success) {
                console.warn(`[UpdateDoc] ApplyEdit failed silently for ${doc.uri}. Detaching link.`);
                session.closeAssociatedDocument(false); // Detach if edit fails
            } else {
                console.log(`[UpdateDoc] Successfully updated associated document.`);
            }
        } catch (err) {
            console.error(`[UpdateDoc] Error applying edit to ${doc.uri}:`, err);
            session.closeAssociatedDocument(false); // Detach on error
            vscode.window.showErrorMessage("Error updating the associated code block document."); // Inform user
        }
    } else {
        // console.log(`[UpdateDoc] No open associated document to update for session ${session.id}.`);
    }
}

/** Generates a display-friendly string for a URI */
function getDisplayUri(uriString: string, type: 'treeDescription' | 'markdownHeader' | 'tooltip' = 'markdownHeader'): string { /* Keep Existing */
    try {
        const uri = vscode.Uri.parse(uriString);
        const scheme = uri.scheme;
        const uriPath = uri.path; // Includes leading slash usually
        const bangIndex = uri.toString().lastIndexOf('!/'); // For archives

        // --- Handle URIs inside archives (e.g., JAR files) ---
        if ((scheme === 'jar' || scheme === 'zip' || scheme === 'file' /* could be file containing ! */) && bangIndex !== -1) {
            const fullUriStr = uri.toString();
            let archivePart = fullUriStr.substring(0, bangIndex); // e.g., jar:file:/path/to/lib.jar
            let internalPath = fullUriStr.substring(bangIndex + 1); // e.g., /com/example/MyClass.java
            let archiveName = 'archive';
            let archiveScheme = scheme;

            // Try to parse the archive part itself to get a cleaner name
            try {
                const archiveUri = vscode.Uri.parse(archivePart);
                // Use fsPath if available (for file URIs), otherwise path
                archiveName = path.basename(archiveUri.fsPath || archiveUri.path);
                archiveScheme = archiveUri.scheme; // Get the scheme of the container (e.g., 'file')
            } catch {
                // Fallback if parsing the archive part fails
                archiveName = path.basename(archivePart);
            }

            // Clean up internal path (remove leading slash if present)
            const displayInternalPath = (internalPath.startsWith('/') ? internalPath.substring(1) : internalPath).replace(/\\/g, '/');

            // Format the display string
            const fullDisplay = `${archiveName}!/${displayInternalPath}`;
            // Prefix with scheme only if it's not 'file' (jar: is handled by !)
            const prefix = (archiveScheme !== 'file' && archiveScheme !== scheme) ? `${archiveScheme}:` : ''; // e.g. for remote fs

            if (type === 'treeDescription') {
                // Shorten for tree view description
                const shortArchive = archiveName.length > 15 ? archiveName.substring(0, 6) + '...' + archiveName.slice(-6) : archiveName;
                const shortInternal = displayInternalPath.length > 25 ? '.../' + displayInternalPath.slice(-22) : displayInternalPath;
                return `${prefix}${shortArchive}!/${shortInternal}`;
            } else {
                // Tooltip & Markdown Header use the same longer format
                return `${prefix}${fullDisplay}`;
            }
        }
        // --- Handle standard file URIs ---
        else if (scheme === 'file') {
            // Use helper to get relative path if possible
            return getDisplayPath(uri.fsPath, type === 'treeDescription');
        }
        // --- Handle other schemes (untitled, git, etc.) ---
        else {
            let displayPath = uri.fsPath || uri.path; // Use fsPath first, fallback to path

            // Remove authority if it's duplicated in the path (common in some URI formats)
            if (uri.authority && displayPath.startsWith('/' + uri.authority)) {
                displayPath = displayPath.substring(uri.authority.length + 1);
            }
            // Remove leading slash from path for cleaner display
            if (displayPath.startsWith('/')) displayPath = displayPath.substring(1);

            // Construct authority string (e.g., //server.com/)
            const authority = uri.authority ? `//${uri.authority}/` : '';
            // Add scheme prefix (e.g., untitled:)
            const prefix = `${scheme}:`;

            const fullDisplay = `${prefix}${authority}${displayPath}`;

            if (type === 'treeDescription' && fullDisplay.length > 45) {
                // Shorten long non-file URIs for tree description
                return fullDisplay.substring(0, prefix.length + 4) + '...' + fullDisplay.substring(fullDisplay.length - (45 - prefix.length - 7));
            }
            return fullDisplay; // Return full URI string for other types
        }
    } catch (e) {
        console.warn(`[getDisplayUri] Error parsing/formatting URI string: ${uriString}`, e);
        // Fallback: return the original string, shortened if needed for description
        if (type === 'treeDescription' && uriString.length > 40) {
            return uriString.substring(0, 15) + '...' + uriString.substring(uriString.length - 22);
        }
        return uriString;
    }
}

/** Generates display path for file system URIs, preferring relative paths. */
function getDisplayPath(filePath: string, short: boolean = false): string { /* Keep Existing */
    const workspaceFolders = vscode.workspace.workspaceFolders;
    let relativePath: string | undefined;

    if (workspaceFolders) {
        // Sort folders by length descending to find the deepest containing folder first
        const sortedFolders = [...workspaceFolders].sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length);

        for (const folder of sortedFolders) {
            const folderPath = folder.uri.fsPath;
            const rel = path.relative(folderPath, filePath);

            // Check if the path is truly relative (doesn't start with '..' or absolute path chars)
            if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
                // Use folder name as path if file is the root of the folder
                relativePath = (rel === '') ? path.basename(folderPath) : rel;
                // Normalize separators
                relativePath = relativePath.replace(/\\/g, '/');

                // Prepend folder name if short mode and multiple workspaces exist
                if (short && rel !== '' && workspaceFolders.length > 1) {
                    relativePath = `${path.basename(folder.name)}/${relativePath}`;
                }
                break; // Found the best relative path, stop searching
            }
        }
    }

    if (relativePath) {
        // Shorten relative path if needed for 'short' mode
        if (short && relativePath.length > 40) {
            const parts = relativePath.split('/');
            // Show root/../file or root/file depending on depth
            return parts.length > 2 ? parts[0] + '/.../' + parts[parts.length - 1] : relativePath;
        }
        return relativePath; // Return the calculated relative path
    } else {
        // Fallback for files outside any workspace folder: Show trailing path parts
        const sep = path.sep;
        const pathParts = filePath.split(sep).filter(Boolean); // Split and remove empty parts
        const partsCount = pathParts.length;

        if (short && partsCount > 3) { // Short mode: show .../folder/file
            return `...${sep}${pathParts.slice(-2).join(sep)}`;
        } else if (!short && partsCount > 5) { // Long mode (tooltip/header): show more context
            return `...${sep}${pathParts.slice(-3).join(sep)}`;
        } else {
            return filePath; // Return full path if it's already short
        }
    }
}

/** Gets a FileEntry and all its descendants within a session's storage. */
function getDescendantEntries(session: Session, directoryUriString: string): FileEntry[] { /* Keep Existing */
    const startingEntry = session.storage.findEntry(directoryUriString);
    if (!startingEntry) return []; // Starting directory not found in session

    // If the starting point itself is not a directory, just return it
    if (!startingEntry.isDirectory) {
        console.warn(`[getDescendantEntries] Provided URI is not a directory: ${directoryUriString}`);
        return [startingEntry];
    }

    const descendants: FileEntry[] = [startingEntry]; // Include the starting directory itself
    const queue: string[] = [directoryUriString]; // URIs to process
    const processedUris = new Set<string>([directoryUriString]); // Avoid cycles/duplicates

    while (queue.length > 0) {
        const currentParentUri = queue.shift()!;
        // Find all entries whose parent is the current one being processed
        for (const file of session.storage.files) {
            if (file.parentUriString === currentParentUri && !processedUris.has(file.uriString)) {
                descendants.push(file);
                processedUris.add(file.uriString);
                // If the child is also a directory, add it to the queue to process its children
                if (file.isDirectory) {
                    queue.push(file.uriString);
                }
            }
        }
    }
    console.log(`[getDescendantEntries] Found ${descendants.length} entries (including root) for directory ${getDisplayUri(directoryUriString)}`);
    return descendants;
}

/**
 * NEW: Recursively builds the directory structure string.
 */
function buildStructureStringRecursive(
    entries: readonly FileEntry[],
    session: Session,
    prefix: string,
    level: number,
    rootUriString: string | undefined, // URI of the root directory being copied (or undefined if session root)
    isExcluded: (relativePath: string) => boolean // Function to check exclusion
): string {
    let structure = '';
    const sortedEntries = [...entries].sort((a, b) => {
        // Sort directories before files, then alphabetically
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        const nameA = path.basename(vscode.Uri.parse(a.uriString).path);
        const nameB = path.basename(vscode.Uri.parse(b.uriString).path);
        return nameA.localeCompare(nameB);
    });

    sortedEntries.forEach((entry, index) => {
        const isLast = index === sortedEntries.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        const uri = vscode.Uri.parse(entry.uriString);
        const name = path.basename(uri.path); // Get simple name

        // Calculate relative path for exclusion check
        let relativePath = '';
        try {
            if (rootUriString) {
                const rootUri = vscode.Uri.parse(rootUriString);
                // Ensure both are file URIs for reliable relative path calculation
                if (uri.scheme === 'file' && rootUri.scheme === 'file') {
                    const fullRelative = path.relative(rootUri.fsPath, uri.fsPath);
                    // Need path relative *within* the copied structure, not from the absolute root
                    // Let's adjust based on level, assuming rootUriString is level -1 effectively
                    // This gets complicated quickly. A simpler approach:
                    // Check exclusion based on the path segments *below* the rootUriString.

                    // Find common ancestor path logic might be needed for robustness,
                    // but let's try a simpler relative calculation first.
                    // path.relative gives path FROM root TO entry.
                    relativePath = path.relative(path.dirname(rootUri.fsPath), uri.fsPath).replace(/\\/g, '/');


                } else {
                    // Fallback for non-file URIs: use path segments
                    const rootParts = rootUri.path.split('/').filter(Boolean);
                    const entryParts = uri.path.split('/').filter(Boolean);
                    // Find common prefix length
                    let commonLength = 0;
                    while (commonLength < rootParts.length && commonLength < entryParts.length && rootParts[commonLength] === entryParts[commonLength]) {
                        commonLength++;
                    }
                    // Relative path is the part of entryParts after the common prefix relative to the root's parent
                    // This heuristic might need refinement.
                    relativePath = entryParts.slice(rootParts.length > 0 ? rootParts.length - 1 : 0).join('/');

                }
            } else {
                // If copying from session root, the relative path is the display path itself (potentially)
                // Or maybe just the name if level 0?
                // Let's use the full path relative to workspace root if possible.
                relativePath = getDisplayPath(uri.fsPath || uri.path, false); // Use non-short display path
            }
            if (relativePath.startsWith('../')) { // Clean up relative paths going above root
                relativePath = relativePath.split('/').pop() || name;
            }
            // If rootUriString is the direct parent, relative path is just the name
            if (entry.parentUriString === rootUriString) {
                relativePath = name;
            }


        } catch (e) {
            console.warn(`[CopyStructure] Error calculating relative path for ${entry.uriString} relative to ${rootUriString}: ${e}`);
            relativePath = name; // Fallback to just the name
        }


        // Check exclusion using the provided function
        if (isExcluded(relativePath)) {
            // console.log(`[CopyStructure] Excluding relative path: ${relativePath} (based on ${entry.uriString})`);
            return; // Skip this entry and its children
        }

        structure += `${prefix}${connector}${name}\n`;

        if (entry.isDirectory) {
            const children = session.storage.files.filter(f => f.parentUriString === entry.uriString);
            const newPrefix = prefix + (isLast ? '    ' : '│   ');
            // Recursively call for children, passing the SAME rootUriString
            structure += buildStructureStringRecursive(children, session, newPrefix, level + 1, rootUriString, isExcluded);
        }
    });

    return structure;
}


// --- Git Diff Common Logic (Keep Existing, Ensure Robustness) ---

/** Common handler for generating/copying Git diffs. */
async function generateDiffCommon(
    entriesToProcess: readonly FileEntry[], // Should be pre-filtered for file:// scheme
    scopeName: string,
    showInfoMessage: (message: string) => Thenable<unknown>, // Use Thenable<unknown> for showInformationMessage etc.
    copyToClipboard: boolean
): Promise<void> {
    if (!gitAPI) { vscode.window.showErrorMessage("Git integration is not available."); return; }
    if (entriesToProcess.length === 0) {
        showInfoMessage(`No file system items found in ${scopeName} to perform Git Diff on.`);
        return;
    }

    try {
        // Calculate the diff
        const { diffOutput, skippedFiles, diffedFilesCount, errorMessages } = await calculateDiffForEntries(entriesToProcess, scopeName);

        // Construct user messages - REVISED LOGIC
        let finalMsg = '';
        let outputToShow = diffOutput; // Start with the actual diff output

        if (errorMessages.length > 0) {
            // === 1. Handle Errors First ===
            const baseMsg = copyToClipboard ? `Diff for ${scopeName}` : `Generated diff for ${scopeName}`;
            finalMsg = `${baseMsg} with errors.`;
            // Combine normal output (if any) with errors for display/copy
            outputToShow = `${diffOutput}\n\n--- ERRORS ENCOUNTERED ---\n${errorMessages.join('\n')}`.trim();
            if (copyToClipboard) {
                await vscode.env.clipboard.writeText(outputToShow);
            } else {
                const doc = await vscode.workspace.openTextDocument({ content: outputToShow, language: 'diff' });
                await vscode.window.showTextDocument(doc, { preview: false });
            }
        } else if (diffOutput.trim() === '') {
            // === 2. Handle No Changes (if no errors) ===
            // This covers the case where files were processed (diffedFilesCount might be >0 if multiple unchanged files were processed, or 0 if one unchanged file)
            // but resulted in no actual diff text.
            finalMsg = `No changes found compared to HEAD for ${scopeName}.`;
            // No document to show or copy in this case.
        } else {
            // === 3. Handle Success (Diff Found) ===
            const baseMsg = copyToClipboard ? `Diff (vs HEAD) for ${scopeName}` : `Generated diff (vs HEAD) for ${scopeName}`;
            finalMsg = copyToClipboard ? `${baseMsg} copied.` : `${baseMsg}.`;
            if (copyToClipboard) {
                await vscode.env.clipboard.writeText(diffOutput); // Use original diffOutput
            } else {
                const doc = await vscode.workspace.openTextDocument({ content: diffOutput, language: 'diff' }); // Use original diffOutput
                await vscode.window.showTextDocument(doc, { preview: false });
            }
        }

        // === 4. Append Skipped Info (Always check, regardless of other outcomes) ===
        if (skippedFiles.length > 0) {
            const reason = skippedFiles.every(s => s.includes('(untracked')) ? ' (untracked)' : ' (untracked or not in a repo)';
            // Append to the message determined above
            if (finalMsg) { // Check if a message was already set
                finalMsg += ` Skipped ${skippedFiles.length} item(s)${reason}.`;
            } else {
                // This case should be rare (e.g., only skipped files provided), but handle it.
                finalMsg = `Skipped ${skippedFiles.length} item(s)${reason}. No diff generated.`;
            }
        }

        // === 5. Show the Final Message ===
        // Avoid showing trivial "no changes" or "no trackable files" messages if there were errors reported.
        // Only show message if it's not empty (it might be empty if only skipped files were processed and no diff/errors occurred)
        if (finalMsg) {
            showInfoMessage(finalMsg);
        } else if (skippedFiles.length === 0 && errorMessages.length === 0 && diffOutput.trim() === '' && entriesToProcess.length > 0) {
            // Fallback message if absolutely nothing happened (e.g., empty directory provided?)
            // This shouldn't be reached with the current logic, but as a safe fallback:
            showInfoMessage(`No diff generated or items skipped for ${scopeName}.`);
        }


    } catch (error: any) {
        // Catch errors from calculateDiffForEntries itself or other unexpected issues
        console.error(`[GenerateDiffCommon] Unexpected Error for scope "${scopeName}":`, error);
        vscode.window.showErrorMessage(`Failed to generate/copy diff for ${scopeName}: ${error.message}`);
    }
}

/** Calculates the scoped Git diff (changes vs HEAD) for a given list of FileEntry items. */
async function calculateDiffForEntries(
    entries: readonly FileEntry[], // Assumes entries are file:// scheme
    scopeName: string
): Promise<{ diffOutput: string; skippedFiles: string[]; diffedFilesCount: number; errorMessages: string[] }> {
    if (!gitAPI) throw new Error("Git API is not available.");

    // Group entries by Git repository
    const filesByRepo = new Map<string, { repo: GitRepository; entries: FileEntry[] }>();
    const skippedFiles: string[] = []; // URIs of files skipped
    const errorMessages: string[] = []; // Store specific error messages
    let potentialDiffFilesCount = 0; // Count files/dirs that *could* be diffed

    console.log(`[DiffCalc] Processing ${entries.length} file system items for scope ${scopeName}`);
    for (const entry of entries) {
        let uri: vscode.Uri;
        try {
            uri = vscode.Uri.parse(entry.uriString, true);
            if (uri.scheme !== 'file') {
                // Should not happen if pre-filtered, but check anyway
                skippedFiles.push(`${getDisplayUri(entry.uriString)} (non-file)`); continue;
            }
        } catch (e) {
            console.warn(`[DiffCalc][${scopeName}] Skipping invalid URI: ${entry.uriString}`, e);
            skippedFiles.push(`${entry.uriString} (invalid)`); continue;
        }

        const repo = gitAPI.getRepository(uri);
        if (!repo) {
            // Only add to skipped if it's actually a file (directories often aren't tracked directly)
            if (!entry.isDirectory) {
                skippedFiles.push(`${getDisplayUri(entry.uriString)} (untracked or no repo)`);
            } else {
                console.log(`[DiffCalc][${scopeName}] Directory not in repo or untracked: ${getDisplayUri(entry.uriString)}`);
                // We still need the directory entry in filesByRepo if its children are tracked
            }
            // Continue processing children even if parent dir isn't tracked/in repo
            // But we need *a* repo context if possible. Find repo for children?
            // Simpler: If a file's repo isn't found, skip it. If a dir's repo isn't found, process its children individually later.
            if (!repo && !entry.isDirectory) continue; // Skip untracked files
            if (!repo && entry.isDirectory) {
                // Still need to check children, but maybe associate with a workspace repo? Risky.
                // Let's rely on children finding their own repo.
                console.log(`[DiffCalc][${scopeName}] Directory ${getDisplayUri(entry.uriString)} not in repo, children will be checked individually.`);
                // Add to a placeholder? No, let children find repo.
            }
        }

        // Only add if repo found (or if it's a directory whose children might be in a repo)
        if (repo) {
            potentialDiffFilesCount++; // Count items potentially involved in diff
            const repoRootStr = repo.rootUri.toString();
            if (!filesByRepo.has(repoRootStr)) {
                filesByRepo.set(repoRootStr, { repo, entries: [] });
            }
            filesByRepo.get(repoRootStr)!.entries.push(entry);
        } else if (entry.isDirectory) {
            potentialDiffFilesCount++; // Count directory as potentially having diffable content
            // How to handle diffing children of a directory not in a repo? They might be in sub-repos.
            // The current logic handles this: each child file will look up its own repo.
        }
    } // End entry processing loop


    if (potentialDiffFilesCount === 0 && entries.length > 0) {
        console.log(`[DiffCalc][${scopeName}] No Git-tracked file system items found.`);
        // Message shown by caller generateDiffCommon
    }

    // 2. Execute git diff for each repository and its relevant files/dirs
    let combinedDiff = '';
    let actualDiffedFilesCount = 0; // Count files included in the final diff output

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Calculating Git diff (vs HEAD) for ${scopeName}...`,
        cancellable: false // Diff calculation can be quick or long, maybe allow cancel later?
    }, async (progress) => {
        let repoIndex = 0;
        const totalRepos = filesByRepo.size;

        for (const [repoRoot, data] of filesByRepo.entries()) {
            repoIndex++;
            const repoDisplayName = path.basename(data.repo.rootUri.fsPath);
            progress.report({ message: `Processing repo ${repoIndex}/${totalRepos}: ${repoDisplayName}`, increment: (1 / totalRepos) * 100 });

            // Determine the specific paths within this repo to diff
            const pathsToDiff = new Set<string>();
            let diffRepoRoot = false;

            for (const entry of data.entries) {
                const entryUri = vscode.Uri.parse(entry.uriString);
                const relativePath = path.relative(data.repo.rootUri.fsPath, entryUri.fsPath).replace(/\\/g, '/');

                if (entry.isDirectory && (relativePath === '.' || relativePath === '')) {
                    // If a directory entry corresponds to the repo root, diff the whole repo
                    diffRepoRoot = true;
                    console.log(`[DiffCalc][${scopeName}] Marked repo root '.' for full diff in ${repoDisplayName}`);
                    break; // No need to check other entries for this repo
                } else if (entry.isDirectory) {
                    // If it's a subdirectory, add it - git diff should handle recursively
                    pathsToDiff.add(relativePath);
                    console.log(`[DiffCalc][${scopeName}] Added directory path for diff: ${relativePath} in ${repoDisplayName}`);
                } else {
                    // If it's a file, add its specific relative path
                    pathsToDiff.add(relativePath);
                    console.log(`[DiffCalc][${scopeName}] Added file path for diff: ${relativePath} in ${repoDisplayName}`);
                }
            }

            let repoDiffContent = '';
            let processedRepoHeader = false; // Add repo header only once if diffs found

            try {
                let finalPaths = diffRepoRoot ? ['.'] : Array.from(pathsToDiff).filter(p => p !== '.'); // Use '.' or specific list
                if (finalPaths.length === 0) {
                    console.log(`[DiffCalc][${scopeName}] No specific paths determined for diffing in repo ${repoDisplayName}. Skipping.`);
                    continue;
                }

                console.log(`[DiffCalc][${scopeName}] Diffing paths [${finalPaths.join(', ')}] against HEAD for repo ${repoDisplayName}`);

                // Execute diff command - Git API's diffWithHEAD handles multiple paths / repo root
                const diffResult = await data.repo.diffWithHEAD(finalPaths.join(' ')); // Pass paths as space-separated string? Or does API handle array? Let's try string.
                // Correction: API expects single path or undefined. We need to call it per path or get all changes if diffRepoRoot.

                if (diffRepoRoot) {
                    // Get all changes (list of files) if root is requested
                    console.log(`[DiffCalc][${scopeName}] Getting changed files list vs HEAD for repo root ${repoDisplayName}`);
                    // diffWithHEAD() without args returns the list of changes (Change[])
                    const changes: Change[] = await data.repo.diffWithHEAD(); // <-- Correct type: Change[]

                    if (changes.length === 0) {
                        console.log(`[DiffCalc][${scopeName}] No working tree changes found vs HEAD for repo root ${repoDisplayName}`);
                    } else {
                        console.log(`[DiffCalc][${scopeName}] Found ${changes.length} changes. Getting individual diffs...`);
                        let combinedRepoDiff = '';
                        // Iterate through each change reported by Git
                        for (const change of changes) {
                            try {
                                // Determine the URI of the file in the working tree
                                // Use renameUri if it's a rename, otherwise use the original uri
                                const diffUri = change.renameUri || change.uri;
                                const relativePath = path.relative(data.repo.rootUri.fsPath, diffUri.fsPath).replace(/\\/g, '/');

                                // Now, get the actual diff string for this specific file change
                                const pathDiff: string = await data.repo.diffWithHEAD(relativePath);

                                if (pathDiff && pathDiff.trim() !== '') {
                                    // diffWithHEAD(path) should return the full diff including headers
                                    // We might not need to reconstruct the header, but check just in case
                                    if (!pathDiff.startsWith('diff --git')) {
                                        // Log a warning if the expected header is missing
                                        console.warn(`[DiffCalc][${scopeName}] Diff output for ${relativePath} missing expected 'diff --git' header. Adding manually.`);
                                        combinedRepoDiff += `diff --git a/${relativePath} b/${relativePath}\n${pathDiff}\n\n`;
                                    } else {
                                        combinedRepoDiff += pathDiff + '\n\n'; // Add separator newline
                                    }
                                    actualDiffedFilesCount++; // Increment count for files with actual diff output
                                }
                                // Even if pathDiff is empty, the file was listed in changes, so potentially count it?
                                // Let's only count if there's actual diff output for clarity.

                            } catch (changeError: any) {
                                // Handle errors getting diff for a specific changed file
                                const uriStr = (change.renameUri || change.uri).toString();
                                console.error(`[DiffCalc][${scopeName}] Error getting diff for changed file ${getDisplayUri(uriStr)} in repo ${repoDisplayName}:`, changeError);
                                // Add error message to the list to be reported later
                                errorMessages.push(`--- Error diffing changed file: ${getDisplayUri(uriStr)} ---\n${changeError.message}\n${changeError.stderr || ''}\n`);
                            }
                        }
                        // Assign the combined diff text from all successfully processed changes
                        repoDiffContent = combinedRepoDiff.trim();
                    }
                } else {
                    // Diff specific paths individually (this logic remains the same as the previous fix)
                    let pathDiffs = '';
                    for (const relativePath of finalPaths) {
                        try {
                            const pathDiff = await data.repo.diffWithHEAD(relativePath);
                            if (pathDiff && pathDiff.trim() !== '') {
                                if (!pathDiff.startsWith('diff --git')) {
                                    console.warn(`[DiffCalc][${scopeName}] Diff output for ${relativePath} missing expected 'diff --git' header. Adding manually.`);
                                    pathDiffs += `diff --git a/${relativePath} b/${relativePath}\n${pathDiff}\n`;
                                } else {
                                    pathDiffs += pathDiff + '\n'; // Add newline separator
                                }
                                actualDiffedFilesCount++;
                            }
                        } catch (pathError: any) {
                            console.error(`[DiffCalc][${scopeName}] Error diffing path ${relativePath} in repo ${repoDisplayName}:`, pathError);
                            errorMessages.push(`--- Error diffing path: ${relativePath} ---\n${pathError.message}\n${pathError.stderr || ''}\n`);
                        }
                    }
                    repoDiffContent = pathDiffs.trim();
                }


                // Append repo diff content if any changes were found
                if (repoDiffContent && repoDiffContent.trim() !== '') {
                    // Add a header if multiple repos are involved or if scoping by session
                    if (!processedRepoHeader && (filesByRepo.size > 1 || scopeName.startsWith('session'))) {
                        combinedDiff += `--- Diff for repository: ${repoDisplayName} ---\n\n`;
                        processedRepoHeader = true;
                    }
                    combinedDiff += repoDiffContent + '\n\n'; // Add extra newline between file diffs / repo sections
                }

            } catch (error: any) {
                console.error(`[DiffCalc][${scopeName}] Error running git diff for repo ${repoDisplayName}:`, error);
                if (!processedRepoHeader && (filesByRepo.size > 1 || scopeName.startsWith('session'))) {
                    combinedDiff += `--- Diff for repository: ${repoDisplayName} ---\n\n`;
                    processedRepoHeader = true;
                }
                let errMsg = `--- Error diffing in repository: ${repoDisplayName} ---\nError: ${error.message || 'Unknown Git error'}\n`;
                if (error.stderr) errMsg += `Stderr:\n${error.stderr}\n`;
                if (error.gitErrorCode) errMsg += `GitErrorCode: ${error.gitErrorCode}\n`;
                errMsg += `\n`;
                errorMessages.push(errMsg); // Add error message to list
                // Don't add to combinedDiff here, handled by caller
            }
        } // End repo loop
    }); // End withProgress

    console.log(`[DiffCalc][${scopeName}] Finished. Diff length: ${combinedDiff.length}, Skipped: ${skippedFiles.length}, Diffed Files Count: ${actualDiffedFilesCount}, Errors: ${errorMessages.length}`);
    return { diffOutput: combinedDiff.trim(), skippedFiles, diffedFilesCount: actualDiffedFilesCount, errorMessages };
}
