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
exports.Session = exports.SessionResourceStorage = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs-extra"));
const uuid_1 = require("uuid");
const utils_1 = require("./utils");
class SessionResourceStorage {
    _files = [];
    sessionId;
    lastRemovedFiles = [];
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
        // Check DRAG & DROP exclusion based on file system path BEFORE adding
        // Note: This check only applies when called during directory recursion triggered by drag/drop
        // It uses the 'fileintegrator.exclude' setting.
        if (uri.scheme === 'file' && (0, utils_1.isPathExcluded)(uri.fsPath)) {
            console.log(`[Exclude][AddResource] Skipping excluded file/dir during drag/drop: ${uri.fsPath}`);
            // Optionally notify user about skipped items during drag/drop - handled in handleDrop
            return false; // Don't add excluded item
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
                        // Don't read large files initially
                        if (stats.size < 1 * 1024 * 1024) { // e.g., < 1MB
                            content = await fs.readFile(uri.fsPath, 'utf8');
                        }
                        else {
                            console.warn(`[Storage:addResource] File too large for initial read, load on demand: ${uri.fsPath}`);
                            content = null; // Load on demand
                        }
                    }
                    catch (readErr) {
                        console.warn(`[Storage:addResource] Failed initial read ${uri.fsPath}: ${readErr.message}`);
                        content = null; // Load on demand
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
                vscode.window.showWarningMessage(`Item not found: ${(0, utils_1.getDisplayUri)(uriString)}`);
            }
            else {
                console.error(`[Storage:addResource] Error processing URI ${uriString}:`, statError);
                vscode.window.showErrorMessage(`Error adding ${(0, utils_1.getDisplayUri)(uriString)}: ${statError.message}`);
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
                    // Check DRAG & DROP exclusion ('fileintegrator.exclude') based on file system path BEFORE recursive call
                    // This check is crucial here for directory recursion during add
                    if (!(0, utils_1.isPathExcluded)(childPath)) {
                        processingPromises.push(this.addResource(childUri, uri)); // Pass current URI as parent
                    }
                    else {
                        console.log(`[Exclude][AddDirRecursion] Skipping excluded: ${childPath}`);
                        // No need to return false here, just skip adding this child
                    }
                }
                await Promise.all(processingPromises);
            }
            catch (readDirError) {
                console.error(`[Storage:addResource] Error reading directory ${uri.fsPath}:`, readDirError);
                // Don't necessarily fail the whole add operation if a subdirectory fails
            }
        }
        return true; // Added successfully (or partially if subdir failed)
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
            // Find children based on parentUriString link
            this._files.forEach(f => {
                if (f.parentUriString === currentUri) {
                    queue.push(f.uriString);
                }
            });
        }
        // Store removed files before filtering
        this.lastRemovedFiles = this._files.filter(f => removedUris.has(f.uriString));
        this._files = this._files.filter(f => !removedUris.has(f.uriString));
        return this._files.length < initialLength;
    }
    clearFiles() {
        const count = this._files.length;
        // Store cleared files for undo
        this.lastRemovedFiles = [...this._files]; // Create a shallow copy
        this._files = [];
        return count;
    }
    restoreFiles(restoredFiles) {
        this._files = restoredFiles;
        console.log(`[Storage:restore] Restored ${this._files.length} items for session ${this.sessionId}`);
    }
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
        const firstParentUri = draggedEntries[0].parentUriString;
        if (!draggedEntries.every(e => e.parentUriString === firstParentUri)) {
            console.warn('[Storage:reorder] Dragged items have different parents. Aborted.');
            vscode.window.showWarningMessage("Cannot move items between different containers yet.");
            return false;
        }
        // Remove dragged items from their original positions
        const originalIndices = draggedEntries.map(entry => this._files.findIndex(f => f.uriString === entry.uriString)).sort((a, b) => b - a); // Sort descending to splice correctly
        originalIndices.forEach(index => {
            if (index > -1)
                this._files.splice(index, 1);
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
        }
        else if (targetUriString) {
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
        }
        else {
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
    // Undo functionality
    hasLastRemovedFiles() {
        return this.lastRemovedFiles.length > 0;
    }
    undoLastRemoval() {
        if (this.hasLastRemovedFiles()) {
            const filesToRestore = this.lastRemovedFiles;
            this._files = [...this._files, ...filesToRestore]; // Add them back to current files
            this.lastRemovedFiles = []; // Clear the undo buffer
            console.log(`[Storage:undo] Restored ${filesToRestore.length} items for session ${this.sessionId}`);
            return filesToRestore;
        }
        return undefined;
    }
}
exports.SessionResourceStorage = SessionResourceStorage;
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
        this.closeAssociatedDocument(false); // Close editor window associated if any
        this.storage.clearFiles();
    }
    setAssociatedDocument(doc) {
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
    async closeAssociatedDocument(attemptEditorClose = true) {
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
                    }
                    catch (err) {
                        console.error(`[Session ${this.id}] Error closing editor:`, err);
                        // Continue trying other editors just in case? Unlikely needed.
                    }
                }
            }
        }
    }
}
exports.Session = Session;
//# sourceMappingURL=session.js.map