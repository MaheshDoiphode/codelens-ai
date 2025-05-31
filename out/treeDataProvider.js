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
exports.CodeLensAiProvider = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const treeItems_1 = require("./treeItems");
const utils_1 = require("./utils");
class CodeLensAiProvider {
    sessionManager;
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    dropMimeTypes = ['text/uri-list', 'application/vnd.code.tree.codeLensAiView'];
    dragMimeTypes = ['application/vnd.code.tree.codeLensAiView'];
    customMimeType = 'application/vnd.code.tree.codeLensAiView';
    constructor(sessionManager) {
        this.sessionManager = sessionManager;
    }
    /**
     * Get {@link TreeItem TreeItem} representation of the `element`.
     * @param element The element for which {@link TreeItem TreeItem} representation is asked for.
     * @returns {@link TreeItem TreeItem} representation of the element.
     */
    getTreeItem(element) { return element; }
    /**
     * Get the parent of `element`.
     * @param element The element for which the parent is asked for.
     * @returns The parent of `element` or `undefined` if `element` is a root.
     */
    getParent(element) {
        if (element instanceof treeItems_1.ResourceItem) {
            const session = this.sessionManager.getSession(element.sessionId);
            if (!session)
                return undefined;
            if (element.entry.parentUriString) {
                const parentEntry = session.storage.findEntry(element.entry.parentUriString);
                if (parentEntry) {
                    return new treeItems_1.ResourceItem(parentEntry, parentEntry.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
                }
            }
            return new treeItems_1.SessionItem(session, session.storage.files.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        }
        if (element instanceof treeItems_1.SessionItem) {
            return undefined;
        }
        return undefined;
    }
    /**
     * Get the children of `element` or root if no element is passed.
     * @param element The element from which the children are asked for.
     * @returns Children of `element` or root if no element is passed.
     */
    getChildren(element) {
        if (!element) {
            return Promise.resolve(this.sessionManager.getAllSessions().map(s => new treeItems_1.SessionItem(s, s.storage.files.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)));
        }
        if (element instanceof treeItems_1.SessionItem) {
            const session = this.sessionManager.getSession(element.session.id);
            if (!session)
                return [];
            const rootEntries = session.storage.files.filter(f => !f.parentUriString);
            return Promise.resolve(rootEntries.map(e => new treeItems_1.ResourceItem(e, e.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)));
        }
        if (element instanceof treeItems_1.ResourceItem && element.isDirectory) {
            const session = this.sessionManager.getSession(element.sessionId);
            if (!session)
                return [];
            const childEntries = session.storage.files.filter(f => f.parentUriString === element.uriString);
            return Promise.resolve(childEntries.map(e => new treeItems_1.ResourceItem(e, e.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)));
        }
        return Promise.resolve([]);
    }
    /**
     * Forcibly refresh the tree view.
     * @param element The element to refresh, or undefined to refresh the entire view.
     */
    refresh(element) { this._onDidChangeTreeData.fire(element); }
    /**
     * Finds a specific tree item by its URI string and session ID.
     * This is a utility for revealing items after operations like undo.
     */
    findTreeItem(uriString, sessionId) {
        const session = this.sessionManager.getSession(sessionId);
        if (!session)
            return undefined;
        const entry = session.storage.findEntry(uriString);
        if (entry) {
            const collapsibleState = entry.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
            return new treeItems_1.ResourceItem(entry, collapsibleState);
        }
        if (session.id === sessionId && !uriString) {
            return new treeItems_1.SessionItem(session, session.storage.files.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        }
        return undefined;
    }
    /**
     * Called when an item is dragged.
     * @param source The source items for the drag operation.
     * @param dataTransfer The data transfer object for the drag operation.
     * @param token A cancellation token.
     */
    handleDrag(source, dataTransfer, token) {
        const draggableItems = source.filter((item) => item instanceof treeItems_1.ResourceItem);
        if (draggableItems.length > 0) {
            const draggedIds = draggableItems.map(item => `${item.sessionId}::${item.uriString}`);
            dataTransfer.set(this.customMimeType, new vscode.DataTransferItem(draggedIds));
        }
    }
    /**
     * Called when an item is dropped.
     * @param target The target item for the drop operation, or `undefined` if the drop occurs in empty space.
     * @param dataTransfer The data transfer object for the drop operation.
     * @param token A cancellation token.
     */
    async handleDrop(target, dataTransfer, token) {
        const internalDropItem = dataTransfer.get(this.customMimeType);
        const externalDropItem = dataTransfer.get('text/uri-list');
        if (token.isCancellationRequested)
            return;
        if (internalDropItem) {
            const draggedItemIds = internalDropItem.value;
            if (!Array.isArray(draggedItemIds) || draggedItemIds.length === 0)
                return;
            const firstIdParts = draggedItemIds[0].split('::');
            if (firstIdParts.length < 2) {
                console.warn('[CodeLensAI:handleDrop] Invalid dragged item ID format.');
                return;
            }
            const sessionId = firstIdParts[0];
            const draggedUriStrings = draggedItemIds.map(id => id.substring(id.indexOf('::') + 2)).filter(Boolean);
            const session = this.sessionManager.getSession(sessionId);
            if (!session) {
                console.error(`[CodeLensAI:handleDrop] Session not found for internal drop: ${sessionId}`);
                return;
            }
            let targetUriString;
            let dropOnSessionNode = false;
            let targetParentUriString;
            if (target instanceof treeItems_1.SessionItem) {
                if (target.session.id !== sessionId) {
                    vscode.window.showErrorMessage("CodeLens AI: Cannot move items between sessions yet.");
                    return;
                }
                dropOnSessionNode = true;
                targetParentUriString = undefined;
            }
            else if (target instanceof treeItems_1.ResourceItem) {
                if (target.sessionId !== sessionId) {
                    vscode.window.showErrorMessage("CodeLens AI: Cannot move items between sessions yet.");
                    return;
                }
                targetUriString = target.uriString;
                targetParentUriString = target.entry.parentUriString;
            }
            else {
                // console.log("[CodeLensAI:handleDrop] Drop target is undefined (empty space). Requires dropping onto Session or Resource item.");
                return;
            }
            const firstDraggedItem = session.storage.findEntry(draggedUriStrings[0]);
            if (!firstDraggedItem)
                return;
            const sourceParentUriString = firstDraggedItem.parentUriString;
            if (!dropOnSessionNode && sourceParentUriString !== targetParentUriString) {
                vscode.window.showWarningMessage("CodeLens AI: Cannot move items between different directory levels yet.");
                return;
            }
            const success = session.storage.reorderItems(draggedUriStrings, targetUriString, dropOnSessionNode);
            if (success) {
                this.sessionManager.persistSessions();
                await (0, utils_1.updateCodeBlockDocument)(session);
                this.refresh();
            }
            else {
                this.refresh();
            }
        }
        else if (externalDropItem) {
            let targetSession;
            if (target instanceof treeItems_1.SessionItem) {
                targetSession = target.session;
            }
            else if (target instanceof treeItems_1.ResourceItem) {
                targetSession = this.sessionManager.getSession(target.sessionId);
            }
            else {
                const sessions = this.sessionManager.getAllSessions();
                targetSession = sessions[0];
                if (targetSession && sessions.length > 1) {
                    vscode.window.showInformationMessage(`CodeLens AI: Added resources to the first session: "${targetSession.name}"`);
                }
                else if (!targetSession) {
                    vscode.window.showErrorMessage("CodeLens AI: Cannot add resources: No sessions exist.");
                    return;
                }
            }
            if (!targetSession) {
                vscode.window.showErrorMessage("CodeLens AI: Could not determine target session for drop.");
                return;
            }
            const uriListString = await externalDropItem.asString();
            const uriStrings = uriListString.split('\n').map(u => u.trim()).filter(Boolean);
            if (uriStrings.length === 0)
                return;
            let resourcesWereAdded = false;
            let skippedCount = 0;
            const skippedExclusion = [];
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `CodeLens AI: Adding to session "${targetSession.name}"...`,
                cancellable: true
            }, async (progress, progressToken) => {
                progressToken.onCancellationRequested(() => {
                    // console.log("User cancelled resource adding.");
                });
                for (let i = 0; i < uriStrings.length; i++) {
                    if (progressToken.isCancellationRequested)
                        break;
                    const uriStr = uriStrings[i];
                    let currentUri;
                    try {
                        currentUri = vscode.Uri.parse(uriStr, true);
                        const displayPath = currentUri.scheme === 'file' ? currentUri.fsPath : uriStr;
                        if (currentUri.scheme === 'file' && (0, utils_1.isPathExcluded)(displayPath)) {
                            // console.log(`[CodeLensAI:Exclude][HandleDrop] Skipping excluded: ${displayPath}`);
                            skippedExclusion.push(path.basename(displayPath));
                            skippedCount++;
                            continue;
                        }
                        progress.report({ message: `(${i + 1}/${uriStrings.length}) Adding ${(0, utils_1.getDisplayUri)(uriStr, 'treeDescription')}`, increment: (1 / uriStrings.length) * 100 });
                        if (await targetSession.storage.addResource(currentUri)) {
                            resourcesWereAdded = true;
                        }
                        else {
                            if (!(currentUri.scheme === 'file' && (0, utils_1.isPathExcluded)(displayPath))) {
                                // console.log(`[CodeLensAI:handleDrop] Item likely skipped as duplicate or error during add: ${uriStr}`);
                            }
                        }
                    }
                    catch (err) {
                        const displayUriStr = currentUri?.toString() ?? uriStr;
                        vscode.window.showErrorMessage(`CodeLens AI: Error processing ${(0, utils_1.getDisplayUri)(displayUriStr)}: ${err.message}`);
                        console.error(`[CodeLensAI:handleDrop] Error processing URI ${displayUriStr}:`, err);
                        skippedCount++;
                    }
                }
            });
            if (resourcesWereAdded) {
                this.sessionManager.persistSessions();
                await (0, utils_1.updateCodeBlockDocument)(targetSession);
            }
            let message = '';
            if (resourcesWereAdded && skippedExclusion.length > 0)
                message = `Added items. Skipped ${skippedExclusion.length} due to exclusion rules: ${skippedExclusion.slice(0, 3).join(', ')}${skippedExclusion.length > 3 ? '...' : ''}`;
            else if (resourcesWereAdded && skippedCount > 0)
                message = `Added items. ${skippedCount} other item(s) were skipped (duplicates, errors).`;
            else if (!resourcesWereAdded && skippedExclusion.length > 0)
                message = `No new items added. Skipped ${skippedExclusion.length} due to exclusion rules: ${skippedExclusion.slice(0, 3).join(', ')}${skippedExclusion.length > 3 ? '...' : ''}`;
            else if (!resourcesWereAdded && skippedCount > 0)
                message = `No new items added. ${skippedCount} item(s) were skipped (duplicates, errors).`;
            if (message)
                vscode.window.showInformationMessage(message);
            this.refresh();
        }
        else {
            // console.log('[CodeLensAI:handleDrop] No supported data transfer item found.');
        }
    }
}
exports.CodeLensAiProvider = CodeLensAiProvider;
//# sourceMappingURL=treeDataProvider.js.map