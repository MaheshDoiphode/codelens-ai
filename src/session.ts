import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';
import { v4 as uuidv4 } from 'uuid';
// import { Minimatch } from 'minimatch'; // Not used in this file directly
import { isPathExcluded, getDisplayUri } from './utils';

// --- Core Data Structures ---
export interface FileEntry {
    uriString: string;
    isDirectory: boolean;
    content: string | null;
    parentUriString?: string;
    sessionId: string;
}
export interface PersistedFileEntry { uri: string; isDirectory: boolean; parentUri?: string; }
export interface PersistedSession { id: string; name: string; files: PersistedFileEntry[]; }

export class SessionResourceStorage {
    private _files: FileEntry[] = [];
    public readonly sessionId: string;
    private lastRemovedFiles: FileEntry[] = [];

    constructor(sessionId: string) {
        this.sessionId = sessionId;
    }

    get files(): readonly FileEntry[] {
        return this._files;
    }

    get resourcesOnly(): { uriString: string; content: string | null }[] {
        return this._files.filter(f => !f.isDirectory).map(f => ({ uriString: f.uriString, content: f.content }));
    }

    /** Finds an entry by its URI string. */
    findEntry(uriString: string): FileEntry | undefined {
        return this._files.find(f => f.uriString === uriString);
    }

    /** Adds a pre-constructed FileEntry. Returns true if added, false if duplicate. */
    addItem(entry: FileEntry): boolean {
        if (this._files.some(f => f.uriString === entry.uriString)) {
            // console.log(`[CodeLensAI:Storage] Item already exists: ${entry.uriString}`);
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
            return false;
        }

        if (uri.scheme === 'file' && isPathExcluded(uri.fsPath)) {
            // console.log(`[CodeLensAI:Exclude][AddResource] Skipping excluded file/dir during drag/drop: ${uri.fsPath}`);
            return false;
        }

        let isDirectory = false;
        let content: string | null = null;
        let canRecurse = false;

        try {
            if (uri.scheme === 'file' && !uri.path.includes('!/')) {
                const stats = await fs.stat(uri.fsPath);
                isDirectory = stats.isDirectory();
                canRecurse = isDirectory;
                if (!isDirectory) {
                    try {
                        if (stats.size < 1 * 1024 * 1024) { // < 1MB
                            content = await fs.readFile(uri.fsPath, 'utf8');
                        } else {
                            console.warn(`[CodeLensAI:Storage:addResource] File too large for initial read, load on demand: ${uri.fsPath}`);
                            content = null;
                        }
                    } catch (readErr: any) {
                        console.warn(`[CodeLensAI:Storage:addResource] Failed initial read ${uri.fsPath}: ${readErr.message}`);
                        content = null;
                    }
                }
            } else {
                isDirectory = false;
                canRecurse = false;
            }
        } catch (statError: any) {
            if (statError.code === 'ENOENT') {
                console.warn(`[CodeLensAI:Storage:addResource] Resource not found: ${uriString}`);
                vscode.window.showWarningMessage(`Item not found: ${getDisplayUri(uriString)}`);
            } else {
                console.error(`[CodeLensAI:Storage:addResource] Error processing URI ${uriString}:`, statError);
                vscode.window.showErrorMessage(`Error adding ${getDisplayUri(uriString)}: ${statError.message}`);
            }
            return false;
        }

        const entry: FileEntry = {
            uriString: uriString,
            isDirectory: isDirectory,
            content: content,
            parentUriString: parentUriString,
            sessionId: this.sessionId,
        };
        this._files.push(entry);

        if (canRecurse && uri.scheme === 'file') {
            try {
                const dirEntries = await fs.readdir(uri.fsPath, { withFileTypes: true });
                const processingPromises: Promise<boolean>[] = [];

                for (const dirEntry of dirEntries) {
                    const childPath = path.join(uri.fsPath, dirEntry.name);
                    const childUri = vscode.Uri.file(childPath);

                    if (!isPathExcluded(childPath)) {
                        processingPromises.push(this.addResource(childUri, uri));
                    } else {
                        // console.log(`[CodeLensAI:Exclude][AddDirRecursion] Skipping excluded: ${childPath}`);
                    }
                }
                await Promise.all(processingPromises);
            } catch (readDirError: any) {
                console.error(`[CodeLensAI:Storage:addResource] Error reading directory ${uri.fsPath}:`, readDirError);
            }
        }
        return true;
    }

    /** Removes entry and its descendants recursively. */
    removeEntry(uriStringToRemove: string): boolean {
        const initialLength = this._files.length;
        const entryToRemove = this.findEntry(uriStringToRemove);
        if (!entryToRemove) return false;

        const removedUris = new Set<string>();
        const queue: string[] = [uriStringToRemove];

        while (queue.length > 0) {
            const currentUri = queue.shift()!;
            if (removedUris.has(currentUri)) continue;
            removedUris.add(currentUri);
            this._files.forEach(f => {
                if (f.parentUriString === currentUri) {
                    queue.push(f.uriString);
                }
            });
        }
        this.lastRemovedFiles = this._files.filter(f => removedUris.has(f.uriString));
        this._files = this._files.filter(f => !removedUris.has(f.uriString));
        return this._files.length < initialLength;
    }

    /** Clears all files from the storage, returning the count of cleared files. */
    clearFiles(): number {
        const count = this._files.length;
        this.lastRemovedFiles = [...this._files];
        this._files = [];
        return count;
    }

    /** Restores a given list of files into the storage. */
    restoreFiles(restoredFiles: FileEntry[]): void {
        this._files = restoredFiles;
        // console.log(`[CodeLensAI:Storage:restore] Restored ${this._files.length} items for session ${this.sessionId}`);
    }

    /**
     * Reorders items within the storage.
     * @param draggedUriStrings URIs of the items being dragged.
     * @param targetUriString Optional URI of the item to drop before.
     * @param dropOnSession If true, items are moved to the root of the session.
     */
    reorderItems(draggedUriStrings: string[], targetUriString?: string, dropOnSession: boolean = false): boolean {
        // console.log(`[CodeLensAI:Storage:reorder] Dragged: ${draggedUriStrings.length}, Target: ${targetUriString}, OnSession: ${dropOnSession}`);

        const draggedEntries: FileEntry[] = [];
        for (const draggedUri of draggedUriStrings) {
            const entry = this.findEntry(draggedUri);
            if (!entry) {
                console.error(`[CodeLensAI:Storage:reorder] Dragged entry not found: ${draggedUri}`);
                return false;
            }
            draggedEntries.push(entry);
        }
        if (draggedEntries.length === 0) return false;

        const firstParentUri = draggedEntries[0].parentUriString;
        if (!draggedEntries.every(e => e.parentUriString === firstParentUri)) {
            // console.warn('[CodeLensAI:Storage:reorder] Dragged items have different parents. Aborted.');
            vscode.window.showWarningMessage("CodeLens AI: Cannot move items between different containers yet.");
            return false;
        }

        const originalIndices = draggedEntries.map(entry => this._files.findIndex(f => f.uriString === entry.uriString)).sort((a, b) => b - a);
        originalIndices.forEach(index => {
            if (index > -1) this._files.splice(index, 1);
        });

        let targetIndex = -1;

        if (dropOnSession) {
            targetIndex = this._files.findIndex(f => f.parentUriString === undefined);
            if (targetIndex === -1) {
                targetIndex = this._files.length;
            }
            draggedEntries.forEach(e => e.parentUriString = undefined);
        } else if (targetUriString) {
            const targetEntryIndex = this._files.findIndex(f => f.uriString === targetUriString);
            if (targetEntryIndex === -1) {
                console.error(`[CodeLensAI:Storage:reorder] Target URI not found after removal: ${targetUriString}`);
                this._files.push(...draggedEntries);
                return false;
            }
            const targetEntry = this._files[targetEntryIndex];
            targetIndex = targetEntryIndex;
            draggedEntries.forEach(e => e.parentUriString = targetEntry.parentUriString);

        } else {
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

        this._files.splice(targetIndex, 0, ...draggedEntries);
        // console.log(`[CodeLensAI:Storage:reorder] Reordering successful. New count: ${this._files.length}`);
        return true;
    }

    /** Checks if there are any files in the last removed buffer. */
    hasLastRemovedFiles(): boolean {
        return this.lastRemovedFiles.length > 0;
    }

    /**
     * Restores the last removed files.
     * @returns The array of FileEntry items that were restored, or undefined if no files to restore.
     */
    undoLastRemoval(): FileEntry[] | undefined {
        if (this.hasLastRemovedFiles()) {
            const filesToRestore = this.lastRemovedFiles;
            this._files = [...this._files, ...filesToRestore];
            this.lastRemovedFiles = [];
            // console.log(`[CodeLensAI:Storage:undo] Restored ${filesToRestore.length} items for session ${this.sessionId}`);
            return filesToRestore;
        }
        return undefined;
    }
}
export class Session {
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

    /** Disposes of session resources, including closing associated documents. */
    dispose() {
        this.closeAssociatedDocument(false);
        this.storage.clearFiles();
    }

    /** Sets the associated TextDocument for this session and listens for its closure. */
    setAssociatedDocument(doc: vscode.TextDocument) {
        this.docCloseListener?.dispose();
        this.associatedDocument = doc;
        this.docCloseListener = vscode.workspace.onDidCloseTextDocument(d => {
            if (d === this.associatedDocument) {
                // console.log(`[CodeLensAI:Session ${this.id}] Associated document closed by user.`);
                this.associatedDocument = null;
                this.docCloseListener?.dispose();
                this.docCloseListener = null;
            }
        });
    }

    /**
     * Closes the associated document.
     * @param attemptEditorClose If true, tries to close the editor tab showing the document.
     */
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
                        // console.log(`[CodeLensAI:Session ${this.id}] Closed editor for associated document.`);
                        break;
                    } catch (err) {
                        console.error(`[CodeLensAI:Session ${this.id}] Error closing editor:`, err);
                    }
                }
            }
        }
    }
}