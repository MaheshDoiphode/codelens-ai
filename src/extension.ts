import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';
import { v4 as uuidv4 } from 'uuid';
import { minimatch } from 'minimatch';

// Import Git API Types (Ensure src/api/git.d.ts has SourceControlHistoryItem import removed if needed for your vscode version)
import { GitExtension, API as GitAPI, Repository as GitRepository, Change as GitChange } from './api/git';

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

        const firstParentUri = draggedEntries[0].parentUriString;
        if (!draggedEntries.every(e => e.parentUriString === firstParentUri)) {
            console.warn('[Storage:reorder] Dragged items have different parents. Aborted.');
            vscode.window.showWarningMessage("Cannot move items between different containers yet.");
            return false;
        }

        const originalIndices = draggedEntries.map(entry => this._files.findIndex(f => f.uriString === entry.uriString)).sort((a, b) => b - a);
        originalIndices.forEach(index => {
            if (index > -1) this._files.splice(index, 1);
        });

        let targetIndex = -1;
        if (dropOnSession) {
            targetIndex = this._files.findIndex(f => f.parentUriString === undefined);
            if (targetIndex === -1) targetIndex = this._files.length;
        } else if (targetUriString) {
            targetIndex = this._files.findIndex(f => f.uriString === targetUriString);
            if (targetIndex === -1) {
                console.error(`[Storage:reorder] Target URI not found after removal: ${targetUriString}`);
                this._files.push(...draggedEntries);
                return false;
            }
        } else {
            const parentUri = firstParentUri;
            let lastIndexOfParentGroup = -1;
            for(let i = this._files.length - 1; i >= 0; i--) {
                if (this._files[i].parentUriString === parentUri) {
                    lastIndexOfParentGroup = i;
                    break;
                }
            }
            targetIndex = lastIndexOfParentGroup + 1;
        }

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
        this.closeAssociatedDocument(false);
        this.storage.clearFiles();
    }

    setAssociatedDocument(doc: vscode.TextDocument) {
        this.docCloseListener?.dispose();
        this.associatedDocument = doc;
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
            const persistedData: PersistedSession[] = this.getAllSessions().map(session => ({
                id: session.id,
                name: session.name,
                files: session.storage.files.map(entry => ({
                    uri: entry.uriString,
                    isDirectory: entry.isDirectory,
                    parentUri: entry.parentUriString,
                }))
            }));
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
            loadedData = this.context.workspaceState.get<PersistedSession[]>(SessionManager.STORAGE_KEY);

            if (!loadedData) { // Migration from V2
                const oldDataV2 = this.context.workspaceState.get<PersistedSession[]>(SessionManager.OLD_STORAGE_KEY_V2);
                 if (oldDataV2 && oldDataV2.length > 0) {
                    console.log("[Load] Migrating data from V2 storage key (path -> uri).");
                    loadedData = oldDataV2.map(metaV2 => ({
                        id: metaV2.id, name: metaV2.name,
                        files: metaV2.files.map((pfV2: any) => {
                            if (!pfV2 || typeof pfV2.path !== 'string') return null;
                            try {
                                const fileUri = vscode.Uri.file(pfV2.path);
                                const parentUri = pfV2.parent ? vscode.Uri.file(pfV2.parent) : undefined;
                                return { uri: fileUri.toString(), isDirectory: !!pfV2.isDirectory, parentUri: parentUri?.toString() };
                            } catch (e) { console.warn(`[Load Migration V2] Error converting path ${pfV2.path} to URI:`, e); return null; }
                        }).filter(pf => pf !== null) as PersistedFileEntry[]
                    }));
                    loadedFromOldKey = true;
                 }
            }

            if (!loadedData) { // Migration from V1
                const oldDataV1 = this.context.workspaceState.get<{ id: string, name: string }[]>(SessionManager.OLD_STORAGE_KEY_V1);
                if (oldDataV1 && oldDataV1.length > 0) {
                    console.log("[Load] Migrating data from V1 storage key (basic).");
                    loadedData = oldDataV1.map(metaV1 => ({ id: metaV1.id, name: metaV1.name, files: [] }));
                    loadedFromOldKey = true;
                } else { loadedData = []; }
            }

            // Process loaded/migrated data
            (loadedData as PersistedSession[]).forEach(meta => {
                if (!meta || typeof meta.id !== 'string' || typeof meta.name !== 'string' || !Array.isArray(meta.files)) {
                    console.warn("[Load] Skipping invalid session metadata entry:", meta); return;
                }
                const session = new Session(meta.name, meta.id);
                const restoredFiles: FileEntry[] = meta.files.map((pf): FileEntry | null => {
                    if (!pf || typeof pf.uri !== 'string' || typeof pf.isDirectory !== 'boolean') {
                         console.warn(`[Load] Skipping invalid persisted file entry in session ${meta.id}:`, pf); return null;
                    }
                    try {
                        vscode.Uri.parse(pf.uri); if (pf.parentUri) vscode.Uri.parse(pf.parentUri);
                        return { uriString: pf.uri, isDirectory: pf.isDirectory, parentUriString: pf.parentUri, content: null, sessionId: session.id };
                    } catch (e) { console.warn(`[Load] Skipping entry with invalid URI in session ${meta.id}:`, pf.uri, e); return null; }
                }).filter((entry): entry is FileEntry => entry !== null);
                session.storage.restoreFiles(restoredFiles);
                this.sessions.set(session.id, session);
            });

            console.log(`[Load] Loaded ${this.sessions.size} sessions.`);
            if (loadedFromOldKey) this.persistSessions();

        } catch (e) {
            console.error("[Load] Error loading session data:", e); this.sessions.clear();
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


// --- Tree View Items ---

type IntegratorTreeItem = SessionItem | ResourceItem;

class SessionItem extends vscode.TreeItem {
    constructor(
        public readonly session: Session,
        collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Collapsed
    ) {
        super(session.name, collapsibleState);
        this.id = session.id;
        this.contextValue = 'session';
        this.iconPath = new vscode.ThemeIcon('folder-library');
        this.tooltip = `Session: ${session.name}`;
        this.description = `(${session.storage.files.length} items)`;
    }
}

class ResourceItem extends vscode.TreeItem {
    constructor(
        public readonly entry: FileEntry,
        collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        const uri = vscode.Uri.parse(entry.uriString);
        let label = '';
        const uriPath = uri.path;
        const bangIndex = uri.toString().lastIndexOf('!/');

        if (bangIndex !== -1) {
            const fullUriStr = uri.toString();
            const internalPath = fullUriStr.substring(bangIndex + 1);
            label = path.basename(internalPath.startsWith('/') ? internalPath.substring(1) : internalPath);
        } else { label = path.basename(uriPath); }

        if (!label && uri.scheme !== 'file') {
            label = uri.toString().substring(uri.scheme.length + 1);
            if (label.startsWith('//')) label = label.substring(2);
        }
        if (!label) label = entry.uriString;

        super(label, collapsibleState);

        this.id = `${entry.sessionId}::${entry.uriString}`;
        this.resourceUri = uri;

        if (!entry.isDirectory) {
            this.command = { command: 'vscode.open', title: "Open Resource", arguments: [uri] };
            this.collapsibleState = vscode.TreeItemCollapsibleState.None;
        }

        this.tooltip = `${entry.isDirectory ? 'Directory (Git Diff applies to tracked files within)' : 'Resource (Git Diff applies if tracked)'}:\n${getDisplayUri(entry.uriString, 'tooltip')}`;
        this.description = getDisplayUri(entry.uriString, 'treeDescription');
        this.contextValue = entry.isDirectory ? 'resourceDirectory' : 'resourceFile';
        this.iconPath = entry.isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    }

    get sessionId(): string { return this.entry.sessionId; }
    get uriString(): string { return this.entry.uriString; }
    get isDirectory(): boolean { return this.entry.isDirectory; }
}

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
        if (!element) { // Root: Show sessions
            return Promise.resolve(this.sessionManager.getAllSessions().map(s => new SessionItem(s,
                s.storage.files.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)));
        }
        if (element instanceof SessionItem) { // Session: Show root items
            const session = this.sessionManager.getSession(element.session.id);
            if (!session) return [];
            const rootEntries = session.storage.files.filter(f => !f.parentUriString);
            return Promise.resolve(rootEntries.map(e => new ResourceItem(e,
                e.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)));
        }
        if (element instanceof ResourceItem && element.isDirectory) { // Directory: Show children
            const session = this.sessionManager.getSession(element.sessionId);
            if (!session) return [];
            const childEntries = session.storage.files.filter(f => f.parentUriString === element.uriString);
            return Promise.resolve(childEntries.map(e => new ResourceItem(e,
                e.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)));
        }
        return Promise.resolve([]);
     }

    refresh(element?: IntegratorTreeItem): void { this._onDidChangeTreeData.fire(element); }

    handleDrag(source: readonly IntegratorTreeItem[], dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): void | Thenable<void> {
        const draggableItems = source.filter((item): item is ResourceItem => item instanceof ResourceItem);
        if (draggableItems.length > 0) {
            const draggedIds = draggableItems.map(item => `${item.sessionId}::${item.uriString}`);
            dataTransfer.set(this.customMimeType, new vscode.DataTransferItem(draggedIds));
        }
    }

    async handleDrop(target: IntegratorTreeItem | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
        const internalDropItem = dataTransfer.get(this.customMimeType);
        const externalDropItem = dataTransfer.get('text/uri-list');
        if (token.isCancellationRequested) return;

        // Handle Internal Reorder Drop
        if (internalDropItem) {
            const draggedItemIds = internalDropItem.value as string[];
            if (!Array.isArray(draggedItemIds) || draggedItemIds.length === 0) return;
            const firstIdParts = draggedItemIds[0].split('::');
            if (firstIdParts.length < 2) { console.warn('[handleDrop] Invalid dragged item ID format.'); return; }
            const sessionId = firstIdParts[0];
            const draggedUriStrings = draggedItemIds.map(id => id.substring(id.indexOf('::') + 2)).filter(Boolean);
            const session = this.sessionManager.getSession(sessionId);
            if (!session) { console.error(`[handleDrop] Session not found for internal drop: ${sessionId}`); return; }

            let targetUriString: string | undefined;
            let dropOnSessionNode = false;
            if (target instanceof SessionItem) {
                 if (target.session.id !== sessionId) { vscode.window.showErrorMessage("Cannot move items between sessions yet."); return; }
                 dropOnSessionNode = true;
            } else if (target instanceof ResourceItem) {
                 if (target.sessionId !== sessionId) { vscode.window.showErrorMessage("Cannot move items between sessions yet."); return; }
                 targetUriString = target.uriString;
            }

            const success = session.storage.reorderItems(draggedUriStrings, targetUriString, dropOnSessionNode);
            if (success) {
                this.sessionManager.persistSessions();
                await updateCodeBlockDocument(session);
                this.refresh();
            } else { this.refresh(); }
        }
        // Handle External File/Folder Drop
        else if (externalDropItem) {
             let targetSession: Session | undefined;
             if (target instanceof SessionItem) targetSession = target.session;
             else if (target instanceof ResourceItem) targetSession = this.sessionManager.getSession(target.sessionId);
             else {
                const sessions = this.sessionManager.getAllSessions(); targetSession = sessions[0];
                if (targetSession && sessions.length > 1) vscode.window.showInformationMessage(`Added resources to session: "${targetSession.name}"`);
                else if (!targetSession) { vscode.window.showErrorMessage("Cannot add resources: No sessions exist."); return; }
             }
             if (!targetSession) { vscode.window.showErrorMessage("Could not determine target session."); return; }

            const uriListString = await externalDropItem.asString();
            const uriStrings = uriListString.split('\n').map(u => u.trim()).filter(Boolean);
            if (uriStrings.length === 0) return;

            let resourcesWereAdded = false; let skippedCount = 0;
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Adding to session "${targetSession.name}"...`, cancellable: true },
                async (progress, progressToken) => {
                progressToken.onCancellationRequested(() => console.log("User cancelled resource adding."));
                for (let i = 0; i < uriStrings.length; i++) {
                    if (progressToken.isCancellationRequested) break;
                    const uriStr = uriStrings[i]; let currentUri: vscode.Uri | undefined;
                     try {
                        currentUri = vscode.Uri.parse(uriStr, true);
                        progress.report({ message: `(${i+1}/${uriStrings.length}) ${getDisplayUri(uriStr, 'treeDescription')}`, increment: 100/uriStrings.length });
                        if (await targetSession!.storage.addResource(currentUri)) resourcesWereAdded = true; else skippedCount++;
                     } catch (err: any) {
                         vscode.window.showErrorMessage(`Error processing ${getDisplayUri(currentUri?.toString() ?? uriStr)}: ${err.message}`);
                         console.error(`Error processing URI ${currentUri?.toString() ?? uriStr}:`, err); skippedCount++;
                     }
                }
             });
             if (resourcesWereAdded) { this.sessionManager.persistSessions(); await updateCodeBlockDocument(targetSession); }
             if (skippedCount > 0) vscode.window.showInformationMessage(`${skippedCount} item(s) were skipped (duplicates, exclusions, or errors).`);
             this.refresh();
        } else { console.log('[handleDrop] No supported data transfer item found.'); }
    }
}

// --- Global Variables & Activation ---

let sessionManager: SessionManager;
let fileIntegratorProvider: FileIntegratorProvider;
let treeView: vscode.TreeView<IntegratorTreeItem>;
let gitAPI: GitAPI | undefined;

export async function activate(context: vscode.ExtensionContext) {
    console.log('Activating File Integrator...');
    // --- Git API Acquisition ---
    try {
        const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
        if (gitExtension) {
            if (!gitExtension.isActive) await gitExtension.activate();
            gitAPI = gitExtension.exports.getAPI(1);
            if (gitAPI) console.log(`File Integrator: Successfully obtained Git API.`);
            else { console.error('File Integrator: Failed to get Git API'); vscode.window.showWarningMessage('File Integrator: Could not initialize Git features.'); }
        } else { console.warn('File Integrator: vscode.git extension not found.'); vscode.window.showWarningMessage('File Integrator: vscode.git not found. Git features unavailable.'); }
    } catch (error) { console.error('File Integrator: Failed to get/activate Git API:', error); vscode.window.showWarningMessage('File Integrator: Could not initialize Git features.'); }
    // --- End Git API Acquisition ---

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
    registerCommands(context);
    context.subscriptions.push({ dispose: () => sessionManager.dispose() });
    console.log('File Integrator activated.');
}

// --- Command Registration ---

function registerCommands(context: vscode.ExtensionContext) {
    const register = (commandId: string, callback: (...args: any[]) => any) => {
        context.subscriptions.push(vscode.commands.registerCommand(commandId, callback));
    };

    // Basic Session Commands
    register('fileintegrator.addSession', async () => {
        const n = await vscode.window.showInputBox({ prompt: "Enter new session name", value: `Session ${sessionManager.getAllSessions().length + 1}` });
        if (n?.trim()) { const s = sessionManager.createSession(n.trim()); fileIntegratorProvider.refresh(); await treeView.reveal(new SessionItem(s), { select: true, focus: true, expand: true }); }
    });
    register('fileintegrator.removeSession', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to remove');
        if (!s) return;
        if (await vscode.window.showWarningMessage(`Remove session "${s.name}"?`, { modal: true }, 'Yes') === 'Yes') {
            await s.closeAssociatedDocument(true);
            if (sessionManager.removeSession(s.id)) fileIntegratorProvider.refresh();
        }
    });
    register('fileintegrator.renameSession', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to rename');
        if (!s) return;
        const n = await vscode.window.showInputBox({ prompt: `Enter new name for "${s.name}"`, value: s.name });
        if (n?.trim() && n.trim() !== s.name && sessionManager.renameSession(s.id, n.trim())) fileIntegratorProvider.refresh();
    });
    register('fileintegrator.clearSession', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to clear');
        if (!s) return;
        if (s.storage.files.length === 0) { vscode.window.showInformationMessage(`Session "${s.name}" is already empty.`); return; }
        const count = s.storage.clearFiles(); sessionManager.persistSessions(); fileIntegratorProvider.refresh(); await updateCodeBlockDocument(s);
        vscode.window.showInformationMessage(`Cleared ${count} items from session "${s.name}".`);
    });

    // Content Generation & Copying
    register('fileintegrator.generateCodeBlock', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to generate code block for');
        if (!s) return;
        if (s.storage.resourcesOnly.length === 0) { vscode.window.showInformationMessage(`Session "${s.name}" contains no file/resource content.`); return; }
        const doc = await showCodeBlockDocument(s);
        if (doc) await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
    });
    register('fileintegrator.copyToClipboard', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to copy content from');
        if (!s) return;
        if (s.storage.resourcesOnly.length === 0) { vscode.window.showInformationMessage(`Session "${s.name}" contains no file/resource content.`); return; }
        let contentToCopy = (s.associatedDocument && !s.associatedDocument.isClosed) ? s.associatedDocument.getText() : await generateMarkdownContent(s);
        if (contentToCopy && !contentToCopy.startsWith('<!-- No file/resource content')) {
            await vscode.env.clipboard.writeText(contentToCopy);
            vscode.window.showInformationMessage(`Session "${s.name}" Code Block content copied!`);
        } else { vscode.window.showWarningMessage("No code block content generated/found."); }
    });

    // Item Management
    register('fileintegrator.removeItem', async (item: ResourceItem) => {
        if (!(item instanceof ResourceItem)) return;
        const s = sessionManager.getSession(item.sessionId);
        if (s && s.storage.removeEntry(item.uriString)) {
            sessionManager.persistSessions(); await updateCodeBlockDocument(s); fileIntegratorProvider.refresh();
        } else fileIntegratorProvider.refresh();
    });
    register('fileintegrator.refreshView', () => fileIntegratorProvider.refresh());

    // Adding Items
    register('fileintegrator.addActiveEditorToSession', async (item?: SessionItem) => {
        const targetSession = item?.session ?? await selectSession("Select session to add active editor to");
        if (targetSession) await addActiveEditorLogic(targetSession);
    });
    register('fileintegrator.addAllOpenEditorsToSession', async (item?: SessionItem) => {
        const session = item?.session ?? await selectSession("Select session to add all open editors to");
        if (session) await addAllOpenEditorsLogic(session);
    });

    // --- Session Git Diff Commands ---
    register('fileintegrator.generateDiffDocument', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to generate Git diff for');
        if (s) await generateDiffCommon(s.storage.files, `session "${s.name}"`, (msg) => vscode.window.showInformationMessage(msg), false);
    });
    register('fileintegrator.copyDiffToClipboard', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to copy Git diff from');
        if (s) await generateDiffCommon(s.storage.files, `session "${s.name}"`, (msg) => vscode.window.showInformationMessage(msg), true);
    });

    // --- Directory Git Diff Commands ---
    register('fileintegrator.generateDirectoryDiffDocument', async (item: ResourceItem) => {
        if (!(item instanceof ResourceItem) || !item.isDirectory) return;
        const session = sessionManager.getSession(item.sessionId);
        if (!session) return;
        const directoryName = path.basename(item.resourceUri?.fsPath || 'directory');
        const descendantEntries = getDescendantEntries(session, item.uriString);
        await generateDiffCommon(descendantEntries, `directory "${directoryName}"`, (msg) => vscode.window.showInformationMessage(msg), false);
    });
    register('fileintegrator.copyDirectoryDiffToClipboard', async (item: ResourceItem) => {
         if (!(item instanceof ResourceItem) || !item.isDirectory) return;
        const session = sessionManager.getSession(item.sessionId);
        if (!session) return;
        const directoryName = path.basename(item.resourceUri?.fsPath || 'directory');
        const descendantEntries = getDescendantEntries(session, item.uriString);
        await generateDiffCommon(descendantEntries, `directory "${directoryName}"`, (msg) => vscode.window.showInformationMessage(msg), true);
    });
}


// --- Command Logic Helpers ---

/** Logic for adding the active editor's resource to a session. */
async function addActiveEditorLogic(targetSession: Session) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showInformationMessage("No active editor found."); return; }
    const { uri } = editor.document;
    const uriString = uri.toString();
    if (editor.document === targetSession.associatedDocument) { vscode.window.showInformationMessage("Cannot add the session document to itself."); return; }
    if (targetSession.storage.findEntry(uriString)) { vscode.window.showInformationMessage(`"${getDisplayUri(uriString, 'treeDescription')}" is already in session.`); return; }

    const newEntry: FileEntry = { uriString, isDirectory: false, content: null, sessionId: targetSession.id };
    if (targetSession.storage.addItem(newEntry)) {
        sessionManager.persistSessions(); await updateCodeBlockDocument(targetSession); fileIntegratorProvider.refresh();
    } else { vscode.window.showWarningMessage(`Failed to add "${getDisplayUri(uriString)}".`); }
}

/** Logic for adding all unique open editor resources to a session. */
async function addAllOpenEditorsLogic(targetSession: Session) {
    const openUris = new Set<string>();
    const sessionDocUriString = targetSession.associatedDocument?.uri.toString();
    vscode.window.tabGroups.all.forEach(group => group.tabs.forEach(tab => {
        const uri = (tab.input as any)?.uri;
        if (uri instanceof vscode.Uri && uri.toString() !== sessionDocUriString) openUris.add(uri.toString());
    }));
    if (openUris.size === 0) { vscode.window.showInformationMessage("No other open editors found."); return; }

    let addedCount = 0, skippedCount = 0;
    openUris.forEach(uriString => {
        if (targetSession.storage.findEntry(uriString)) skippedCount++;
        else {
            const newEntry: FileEntry = { uriString, isDirectory: false, content: null, sessionId: targetSession.id };
            if (targetSession.storage.addItem(newEntry)) addedCount++;
        }
    });

    if (addedCount > 0) {
        sessionManager.persistSessions(); await updateCodeBlockDocument(targetSession); fileIntegratorProvider.refresh();
        let message = `Added ${addedCount} editor(s).`; if (skippedCount > 0) message += ` Skipped ${skippedCount} (already present).`;
        vscode.window.showInformationMessage(message);
    } else if (skippedCount > 0) vscode.window.showInformationMessage(`All open editors already present in session.`);
    else vscode.window.showInformationMessage("No new editors added.");
}

// --- Deactivation ---

export function deactivate() {
    console.log('Deactivating File Integrator...');
    gitAPI = undefined;
}

// --- Utility Functions ---

/** Checks if a file system path matches exclusion patterns from settings. */
function isPathExcluded(filePath: string): boolean {
    const config = vscode.workspace.getConfiguration('fileintegrator');
    const excludePatterns = config.get<Record<string, boolean>>('exclude');
    if (!excludePatterns) return false;
    const normalizedFilePath = filePath.replace(/\\/g, '/');
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const options = { dot: true, nocase: process.platform === 'win32' };

    for (const pattern in excludePatterns) {
        if (excludePatterns[pattern]) {
            const normalizedPattern = pattern.replace(/\\/g, '/');
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
            if (!normalizedPattern.includes('/') && minimatch(path.basename(normalizedFilePath), normalizedPattern, options )) return true;
        }
    }
    return false;
 }

/** Prompts user to select a session via Quick Pick. Returns undefined if cancelled. */
 async function selectSession(placeHolder: string): Promise<Session | undefined> {
    const sessions = sessionManager.getAllSessions();
    if (sessions.length === 0) { vscode.window.showErrorMessage("No sessions available."); return undefined; }
    if (sessions.length === 1) return sessions[0];
    const picks = sessions.map(s => ({ label: s.name, description: `(${s.storage.files.length} items)`, session: s }));
    const selection = await vscode.window.showQuickPick(picks, { placeHolder, canPickMany: false });
    return selection?.session;
 }

/** Generates aggregated Markdown content for a session, respecting order. */
 async function generateMarkdownContent(session: Session): Promise<string> {
    let content = '';
    const resourceEntries = session.storage.files.filter(f => !f.isDirectory);
    if (resourceEntries.length === 0) return `<!-- No file/resource content in session "${session.name}" -->\n`;
    console.log(`[MarkdownGen] Generating content for ${resourceEntries.length} resources in session ${session.id}`);

    for (const entry of resourceEntries) {
        let resourceContent: string | null = entry.content;
        if (resourceContent === null) {
            const uri = vscode.Uri.parse(entry.uriString);
            try {
                console.log(`[MarkdownGen] Reading content for URI: ${entry.uriString}`);
                const doc = await vscode.workspace.openTextDocument(uri);
                resourceContent = doc.getText();
                // entry.content = resourceContent; // Optional caching
            } catch (error: any) {
                console.error(`[MarkdownGen] Error reading URI ${entry.uriString}:`, error);
                const displayUri = getDisplayUri(entry.uriString);
                resourceContent = (error?.code === 'FileNotFound' || error?.code === 'EntryNotFound' || error?.message?.includes('cannot open'))
                    ? `--- Error: Resource not found or inaccessible (${displayUri}) ---`
                    : `--- Error reading content for ${displayUri}: ${error.message} ---`;
            }
        }
        const displayUri = getDisplayUri(entry.uriString, 'markdownHeader');
        const uriPath = vscode.Uri.parse(entry.uriString).path;
        const langPart = uriPath.includes('!/') ? uriPath.substring(uriPath.lastIndexOf('!/') + 1) : uriPath;
        const ext = path.extname(langPart); const lang = ext ? ext.substring(1) : '';
        content += `${displayUri}\n\`\`\`${lang}\n${resourceContent ?? '--- Content Unavailable ---'}\n\`\`\`\n\n`;
    }
    return content.trimEnd();
}

/** Ensures the code block document for a session is visible and up-to-date. */
async function showCodeBlockDocument(session: Session): Promise<vscode.TextDocument | undefined> {
    const content = await generateMarkdownContent(session);
    if (session.associatedDocument && !session.associatedDocument.isClosed) {
        const doc = session.associatedDocument;
        try {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), content);
            if (!await vscode.workspace.applyEdit(edit)) throw new Error("ApplyEdit failed");
            console.log(`[ShowDoc] Updated associated document for session ${session.id}`);
            return doc;
        } catch (e) {
            console.error(`[ShowDoc] Error updating associated doc ${doc.uri}:`, e);
            await session.closeAssociatedDocument(false); // Detach link on failure
            return createNewAssociatedDocument(session, content); // Try creating new
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
            if (!await vscode.workspace.applyEdit(edit)) {
                console.warn(`[UpdateDoc] ApplyEdit failed for ${doc.uri}. Detaching.`);
                session.closeAssociatedDocument(false);
            } else console.log(`[UpdateDoc] Successfully updated associated document.`);
        } catch (err) {
            console.error(`[UpdateDoc] Error applying edit to ${doc.uri}:`, err);
            session.closeAssociatedDocument(false);
            vscode.window.showErrorMessage("Error updating associated code block document.");
        }
    }
}

/** Generates a display-friendly string for a URI */
function getDisplayUri(uriString: string, type: 'treeDescription' | 'markdownHeader' | 'tooltip' = 'markdownHeader'): string {
     try {
        const uri = vscode.Uri.parse(uriString); const scheme = uri.scheme; const uriPath = uri.path;
        const bangIndex = uri.toString().lastIndexOf('!/');
        if ((scheme === 'jar' || scheme === 'file') && bangIndex !== -1) {
            const fullUriStr = uri.toString(); let archivePart = fullUriStr.substring(0, bangIndex);
            let internalPath = fullUriStr.substring(bangIndex + 1); let archiveName = 'archive'; let archiveScheme = scheme;
             try { const archiveUri = vscode.Uri.parse(archivePart); archiveName = path.basename(archiveUri.fsPath || archiveUri.path); archiveScheme = archiveUri.scheme; }
             catch { archiveName = path.basename(archivePart); }
            const displayInternalPath = (internalPath.startsWith('/') ? internalPath.substring(1) : internalPath).replace(/\\/g, '/');
            const fullDisplay = `${archiveName}!/${displayInternalPath}`; const prefix = archiveScheme !== 'file' ? `${archiveScheme}:` : '';
            if (type === 'treeDescription') {
                const shortArchive = archiveName.length > 15 ? archiveName.substring(0, 6) + '...' + archiveName.slice(-6) : archiveName;
                const shortInternal = displayInternalPath.length > 20 ? '.../' + displayInternalPath.slice(-17) : displayInternalPath;
                return `${prefix}${shortArchive}!/${shortInternal}`;
            } else return `${prefix}${fullDisplay}`; // Tooltip/Header use same longer format
        }
        else if (scheme === 'file') return getDisplayPath(uri.fsPath, type === 'treeDescription');
        else {
            let displayPath = uri.fsPath || uri.path;
             if (uri.authority && displayPath.startsWith('/' + uri.authority)) displayPath = displayPath.substring(uri.authority.length + 1);
             if (displayPath.startsWith('/')) displayPath = displayPath.substring(1);
             const authority = uri.authority ? `//${uri.authority}/` : (uri.scheme === 'untitled' ? '' : ':');
             const fullDisplay = `${scheme}${authority}${displayPath}`;
             if (type === 'treeDescription' && fullDisplay.length > 45) return fullDisplay.substring(0, scheme.length + 1) + '...' + fullDisplay.substring(fullDisplay.length - (45 - scheme.length - 4));
             return fullDisplay;
        }
    } catch (e) {
        console.warn(`[getDisplayUri] Error parsing/formatting URI string: ${uriString}`, e);
        if (type === 'treeDescription' && uriString.length > 40) return uriString.substring(0, 15) + '...' + uriString.substring(uriString.length - 22);
        return uriString;
    }
}

/** Generates display path for file system URIs, preferring relative paths. */
function getDisplayPath(filePath: string, short: boolean = false): string {
    const workspaceFolders = vscode.workspace.workspaceFolders; let relativePath: string | undefined;
    if (workspaceFolders) {
        const sortedFolders = [...workspaceFolders].sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length);
        for (const folder of sortedFolders) {
            const rel = path.relative(folder.uri.fsPath, filePath);
            if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
                relativePath = (rel === '') ? path.basename(folder.uri.fsPath) : rel.replace(/\\/g, '/');
                 if (rel !== '' && workspaceFolders.length > 1 && short) relativePath = `${path.basename(folder.uri.fsPath)}/${relativePath}`;
                break;
            }
        }
    }
    if (relativePath) {
        if (short && relativePath.length > 40) { const parts = relativePath.split('/'); return parts.length > 2 ? parts[0] + '/.../' + parts[parts.length-1] : relativePath; }
        return relativePath;
    } else { // Fallback for non-workspace
        const pathParts = filePath.split(path.sep).filter(Boolean); const partsCount = pathParts.length; const sep = path.sep;
        if (short && partsCount > 3) return `...${sep}${pathParts.slice(-2).join(sep)}`;
        else if (!short && partsCount > 4) return `...${sep}${pathParts.slice(-3).join(sep)}`;
        else return filePath;
    }
}

/** Gets a FileEntry and all its descendants within a session. */
function getDescendantEntries(session: Session, directoryUriString: string): FileEntry[] {
    const startingEntry = session.storage.findEntry(directoryUriString);
    if (!startingEntry) return [];
    if (!startingEntry.isDirectory) return [startingEntry]; // Return only the file if it's not a directory

    const descendants: FileEntry[] = [startingEntry];
    const queue: string[] = [directoryUriString];
    const processedUris = new Set<string>([directoryUriString]);

    while (queue.length > 0) {
        const currentParentUri = queue.shift()!;
        for (const file of session.storage.files) {
            if (file.parentUriString === currentParentUri && !processedUris.has(file.uriString)) {
                descendants.push(file);
                processedUris.add(file.uriString);
                if (file.isDirectory) queue.push(file.uriString);
            }
        }
    }
    console.log(`[getDescendantEntries] Found ${descendants.length} entries for directory ${directoryUriString}`);
    return descendants;
}

// --- Git Diff Common Logic ---

/** Common handler for generating/copying Git diffs. */
async function generateDiffCommon(
    entriesToProcess: readonly FileEntry[],
    scopeName: string,
    showInfoMessage: (message: string) => void,
    copyToClipboard: boolean
): Promise<void> {
     if (!gitAPI) { vscode.window.showErrorMessage("Git integration is not available."); return; }
    try {
        const { diffOutput, skippedFiles, diffedFilesCount } = await calculateDiffForEntries(entriesToProcess, scopeName, showInfoMessage);
        let infoMsg = skippedFiles.length > 0 ? ` (Skipped ${skippedFiles.length} item(s))` : '';
        if (diffedFilesCount === 0) return; // Message shown by calculateDiffForEntries
        if (!diffOutput || diffOutput.trim() === '') { showInfoMessage(`No changes found compared to HEAD for ${scopeName}.${infoMsg}`); return; }

        if (copyToClipboard) {
            await vscode.env.clipboard.writeText(diffOutput);
            showInfoMessage(`Diff (vs HEAD) for ${scopeName} copied.${infoMsg}`);
        } else {
            const doc = await vscode.workspace.openTextDocument({ content: diffOutput, language: 'diff' });
            await vscode.window.showTextDocument(doc, { preview: false });
            if (skippedFiles.length > 0) showInfoMessage(`Generated diff (vs HEAD).${infoMsg}`);
        }
    } catch (error: any) {
        console.error(`[GenerateDiffCommon] Error for scope "${scopeName}":`, error);
        vscode.window.showErrorMessage(`Failed to generate/copy diff for ${scopeName}: ${error.message}`);
    }
}

/** Calculates the scoped Git diff (changes vs HEAD) for a given list of FileEntry items. */
async function calculateDiffForEntries(
    entries: readonly FileEntry[],
    scopeName: string,
    showInfoMessage?: (message: string) => void
): Promise<{ diffOutput: string; skippedFiles: string[]; diffedFilesCount: number }> {
    if (!gitAPI) throw new Error("Git API is not available.");

    const filesToDiff = new Map<string, { repo: GitRepository, paths: string[] }>();
    const skippedFiles: string[] = [];
    let diffedFilesCount = 0;

    // 1. Filter and Group files/repo roots by repository
    console.log(`[DiffCalc] Processing ${entries.length} items for scope ${scopeName}`);
    for (const entry of entries) {
        let uri: vscode.Uri;
        try { uri = vscode.Uri.parse(entry.uriString, true); }
        catch (e) { console.warn(`[DiffCalc][${scopeName}] Skipping invalid URI: ${entry.uriString}`, e); skippedFiles.push(entry.uriString); continue; }
        if (uri.scheme !== 'file') { skippedFiles.push(entry.uriString); continue; }
        const repo = gitAPI.getRepository(uri);
        if (!repo) { skippedFiles.push(entry.uriString); continue; }

        if (!entry.isDirectory) diffedFilesCount++; // Count potential files
        const repoRootStr = repo.rootUri.toString();
        if (!filesToDiff.has(repoRootStr)) filesToDiff.set(repoRootStr, { repo, paths: [] });
        const relativePath = path.relative(repo.rootUri.fsPath, uri.fsPath).replace(/\\/g, '/');
        const repoData = filesToDiff.get(repoRootStr)!;

        if (!entry.isDirectory && relativePath && relativePath !== '.' && !repoData.paths.includes('.') && !repoData.paths.includes(relativePath)) {
            repoData.paths.push(relativePath); // Add specific file if not covered by '.'
            console.log(`[DiffCalc][${scopeName}] Adding file path for repo ${repoRootStr}: ${relativePath}`);
        } else if (entry.isDirectory && (relativePath === '.' || relativePath === '')) {
             if (!repoData.paths.includes('.')) { repoData.paths = ['.']; console.log(`[DiffCalc][${scopeName}] Marking repo root '.' for full diff: ${repoRootStr}`); } // Mark full repo diff
        } else if (entry.isDirectory) {
             console.log(`[DiffCalc][${scopeName}] Directory entry ${relativePath} noted.`); // Don't add non-root dirs directly
        }
    }

    if (diffedFilesCount === 0 && entries.length > 0 && showInfoMessage) {
        let msg = `No Git-tracked files found in ${scopeName}.`;
         if (skippedFiles.length > 0) msg += ` (Skipped ${skippedFiles.length} item(s))`;
        showInfoMessage(msg);
    }

    // 2. Execute git diff for each repository path
    let combinedDiff = '';
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Calculating Git diff (vs HEAD) for ${scopeName}...`, cancellable: false },
        async (progress) => {
        let repoIndex = 0; const totalRepos = filesToDiff.size;
        for (const [repoRoot, data] of filesToDiff.entries()) {
            repoIndex++; const repoDisplayName = path.basename(data.repo.rootUri.fsPath);
            progress.report({ message: `Processing repo ${repoIndex}/${totalRepos}: ${repoDisplayName}`, increment: (1 / totalRepos) * 100 });
            let pathsToProcess = data.paths.filter(p => p.length > 0);
            if (pathsToProcess.length === 0) { console.log(`[DiffCalc][${scopeName}] No specific paths to diff in repo ${repoDisplayName}.`); continue; }

            let repoDiff = '';
            let processedRepo = false; // Flag to add repo header only once if needed

            // If repo root '.' is requested, get all changed paths vs HEAD first
            if (pathsToProcess.includes('.')) {
                try {
                    console.log(`[DiffCalc][${scopeName}] Getting changed files vs HEAD for repo root ${repoDisplayName}`);
                    const allChanges: GitChange[] = await data.repo.diffWithHEAD();
                    pathsToProcess = allChanges.map(change => {
                        try { return path.relative(data.repo.rootUri.fsPath, (change.renameUri || change.uri).fsPath).replace(/\\/g, '/'); }
                        catch (e) { console.warn(`[DiffCalc][${scopeName}] Error getting relative path for change: ${change.uri.toString()}`, e); return null; }
                    }).filter((p): p is string => !!p); // Filter nulls and empty strings
                    console.log(`[DiffCalc][${scopeName}] Found ${pathsToProcess.length} changed files vs HEAD in repo ${repoDisplayName}`);
                    if (pathsToProcess.length === 0) continue; // Skip if no files actually changed
                } catch (error: any) {
                    console.error(`[DiffCalc][${scopeName}] Error getting changes vs HEAD for repo root ${repoDisplayName}:`, error);
                    repoDiff += `--- Error getting changes for repository root: ${repoDisplayName} ---\nError: ${error.message || 'Unknown Git error'}\n\n`;
                    pathsToProcess = []; // Prevent further processing for this repo
                }
            }

            // Diff each required path individually
            console.log(`[DiffCalc][${scopeName}] Diffing ${pathsToProcess.length} paths against HEAD for repo ${repoDisplayName}`);
            for (const relativePath of pathsToProcess) {
                try {
                    const pathDiff = await data.repo.diffWithHEAD(relativePath);
                    if (pathDiff && pathDiff.trim() !== '') {
                         if (!processedRepo && (filesToDiff.size > 1 || scopeName.startsWith('session'))) {
                            repoDiff += `--- Diff for repository: ${repoDisplayName} ---\n\n`;
                            processedRepo = true;
                         }
                        repoDiff += `diff --git a/${relativePath} b/${relativePath}\n${pathDiff}\n\n`;
                    }
                } catch (error: any) {
                    console.error(`[DiffCalc][${scopeName}] Error running git diff for path ${relativePath}:`, error);
                    if (!processedRepo && (filesToDiff.size > 1 || scopeName.startsWith('session'))) {
                        repoDiff += `--- Diff for repository: ${repoDisplayName} ---\n\n`;
                        processedRepo = true;
                    }
                    repoDiff += `--- Error diffing path: ${relativePath} ---\nError: ${error.message || 'Unknown Git error'}\n`;
                     if (error.stderr) repoDiff += `Stderr:\n${error.stderr}\n`;
                     if (error.gitErrorCode) repoDiff += `GitErrorCode: ${error.gitErrorCode}\n`;
                    repoDiff += `\n\n`;
                }
            }
            combinedDiff += repoDiff; // Append diffs (or errors) for this repo
        }
    });

    console.log(`[DiffCalc][${scopeName}] Finished. Diff length: ${combinedDiff.length}, Skipped: ${skippedFiles.length}, Diffed Files Count: ${diffedFilesCount}`);
    return { diffOutput: combinedDiff.trim(), skippedFiles, diffedFilesCount };
}