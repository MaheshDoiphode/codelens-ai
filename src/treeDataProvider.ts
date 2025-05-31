import * as vscode from 'vscode';
import * as path from 'path';
import { SessionManager } from './sessionManager';
import { Session } from './session';
import { IntegratorTreeItem, SessionItem, ResourceItem } from './treeItems';
import { isPathExcluded, updateCodeBlockDocument, getDisplayUri } from './utils';

// --- Tree Data Provider ---
export class FileIntegratorProvider implements vscode.TreeDataProvider<IntegratorTreeItem>, vscode.TreeDragAndDropController<IntegratorTreeItem> {
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