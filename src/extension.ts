import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';

// Import Git API Types
import { GitExtension, API as GitAPI, Repository as GitRepository, Change as GitChange, Change } from './api/git';

// Import refactored modules
import { FileEntry, PersistedFileEntry, PersistedSession, SessionResourceStorage, Session } from './session';
import { SessionManager } from './sessionManager';
import { IntegratorTreeItem, SessionItem, ResourceItem } from './treeItems';
import { FileIntegratorProvider } from './treeDataProvider';
import { isPathExcluded, isPathExcludedFromTree, selectSession, generateMarkdownContentForEntries, generateMarkdownContent, showCodeBlockDocument, createNewAssociatedDocument, updateCodeBlockDocument, getDisplayUri, getDisplayPath, getDescendantEntries, buildStructureStringRecursive } from './utils';
import { generateDiffCommon, calculateDiffForEntries } from './git';

// --- Global Variables & Activation ---
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

    fileIntegratorProvider = new FileIntegratorProvider(sessionManager);    treeView = vscode.window.createTreeView('fileIntegratorView', {
        treeDataProvider: fileIntegratorProvider,
        dragAndDropController: fileIntegratorProvider, // Enable drag/drop
        canSelectMany: true // Allow multi-select for potential future actions
    });
    context.subscriptions.push(treeView);

    registerCommands(context); // Register all commands

    // Clean up session manager on deactivate
    context.subscriptions.push({ dispose: () => sessionManager.dispose() });

    console.log('File Integrator activated.');
}

// --- Command Registration ---
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
        const s = item?.session ?? await selectSession('Select session to remove', sessionManager);
        if (!s) return;
        if (await vscode.window.showWarningMessage(`Remove session "${s.name}" and close its associated document (if open)?`, { modal: true }, 'Yes') === 'Yes') {
            await s.closeAssociatedDocument(true); // Attempt to close editor
            if (sessionManager.removeSession(s.id)) fileIntegratorProvider.refresh();
        }
    });
    register('fileintegrator.renameSession', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to rename', sessionManager);
        if (!s) return;
        const n = await vscode.window.showInputBox({ prompt: `Enter new name for "${s.name}"`, value: s.name });
        if (n?.trim() && n.trim() !== s.name && sessionManager.renameSession(s.id, n.trim())) {
            fileIntegratorProvider.refresh();
        }
    });
    register('fileintegrator.clearSession', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to clear', sessionManager);
        if (!s) return;
        if (s.storage.files.length === 0) { vscode.window.showInformationMessage(`Session "${s.name}" is already empty.`); return; }
        const count = s.storage.clearFiles();
        sessionManager.persistSessions();
        fileIntegratorProvider.refresh();
        await updateCodeBlockDocument(s); // Update associated doc
        vscode.window.showInformationMessage(`Cleared ${count} items from session "${s.name}".`);
    });

    // --- Existing Content Generation & Copying ---
    register('fileintegrator.generateCodeBlock', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to generate code block for', sessionManager);
        if (!s) return;
        if (s.storage.files.length === 0) { vscode.window.showInformationMessage(`Session "${s.name}" is empty.`); return; }
        const doc = await showCodeBlockDocument(s);
        if (doc) await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
    });
    register('fileintegrator.copyToClipboard', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to copy content from', sessionManager);
        if (!s) return;
        if (s.storage.resourcesOnly.length === 0) { vscode.window.showInformationMessage(`Session "${s.name}" contains no file/resource content to copy.`); return; }
        let contentToCopy = '';
        if (s.associatedDocument && !s.associatedDocument.isClosed) {
            contentToCopy = s.associatedDocument.getText();
            console.log(`[CopyToClipboard] Copying from associated document for session ${s.id}`);
        } else {
            console.log(`[CopyToClipboard] Generating fresh content for session ${s.id}`);
            contentToCopy = await generateMarkdownContent(s);
        }
        if (contentToCopy && !contentToCopy.startsWith('<!-- No file/resource content')) {
            await vscode.env.clipboard.writeText(contentToCopy);
            vscode.window.showInformationMessage(`Session "${s.name}" Code Block content copied!`);
        } else { vscode.window.showWarningMessage("No code block content generated or found to copy."); }
    });

    // --- NEW: Directory-specific Content Generation ---
    register('fileintegrator.generateDirectoryCodeBlock', async (item: ResourceItem) => {
        if (!(item instanceof ResourceItem) || !item.isDirectory) return;
        const session = sessionManager.getSession(item.sessionId);
        if (!session) return;
        const directoryName = path.basename(item.resourceUri?.fsPath || 'directory');
        const descendants = getDescendantEntries(session, item.uriString).filter(e => !e.isDirectory);
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
        if (!(item instanceof ResourceItem)) return;
        const s = sessionManager.getSession(item.sessionId);
        if (s && s.storage.removeEntry(item.uriString)) {
            sessionManager.persistSessions();
            await updateCodeBlockDocument(s); // Update associated doc
            fileIntegratorProvider.refresh();
            vscode.window.showInformationMessage(`Removed "${getDisplayUri(item.uriString, 'treeDescription')}". You can undo this by clicking 'Undo Last Removal' in the tree view.`);
        } else {
            fileIntegratorProvider.refresh();
        }
    });
    register('fileintegrator.refreshView', () => fileIntegratorProvider.refresh());

    // NEW: Undo Last Removal Command
    register('fileintegrator.undoLastRemoval', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to undo last removal for', sessionManager);
        if (!s) return;

        if (!s.storage.hasLastRemovedFiles()) {
            vscode.window.showInformationMessage(`No recent removals to undo for session "${s.name}".`);
            return;
        }        const restored = s.storage.undoLastRemoval();
        if (restored && restored.length > 0) {
            sessionManager.persistSessions();
            await updateCodeBlockDocument(s); // Update associated doc
            fileIntegratorProvider.refresh();
            vscode.window.showInformationMessage(`Successfully restored ${restored.length} item(s) to session "${s.name}".`);
            
            // Optionally reveal the first restored item (with error handling)
            try {
                if (restored.length > 0) {
                    const restoredItem = fileIntegratorProvider.findTreeItem(restored[0].uriString, s.id);
                    if (restoredItem) {
                        await treeView.reveal(restoredItem, { select: true, focus: false, expand: true });
                    }
                }
            } catch (revealError) {
                // Silently handle reveal errors since the main operation (undo) was successful
                console.log('Could not reveal restored item, but undo was successful:', revealError);
            }
        } else {
            vscode.window.showWarningMessage(`Failed to undo last removal for session "${s.name}".`);
        }
    });

    // --- Existing Adding Items ---
    register('fileintegrator.addActiveEditorToSession', async (item?: SessionItem) => {
        const targetSession = item?.session ?? await selectSession("Select session to add active editor to", sessionManager);
        if (targetSession) await addActiveEditorLogic(targetSession);
    });
    register('fileintegrator.addAllOpenEditorsToSession', async (item?: SessionItem) => {
        const session = item?.session ?? await selectSession("Select session to add all open editors to", sessionManager);
        if (session) await addAllOpenEditorsLogic(session);
    });

    // --- NEW: Copy Directory Structure Command ---
    register('fileintegrator.copyDirectoryStructure', async (item?: SessionItem | ResourceItem) => {
        let session: Session | undefined;
        let startingEntries: FileEntry[] = [];
        let baseUriString: string | undefined;
        let scopeName = '';

        if (item instanceof SessionItem) {
            session = item.session;
            startingEntries = session.storage.files.filter(f => !f.parentUriString);
            baseUriString = undefined;
            scopeName = `session "${session.name}"`;
        } else if (item instanceof ResourceItem && item.isDirectory) {
            session = sessionManager.getSession(item.sessionId);
            if (!session) return;
            startingEntries = session.storage.files.filter(f => f.parentUriString === item.uriString);
            baseUriString = item.uriString;
            scopeName = `directory "${path.basename(item.resourceUri?.fsPath || 'directory')}"`;
        } else if (item instanceof ResourceItem && !item.isDirectory) {
            vscode.window.showInformationMessage("Cannot copy structure of a single file.");
            return;
        } else {
            vscode.window.showWarningMessage("Please right-click on a Session or Directory item to copy its structure.");
            return;
        }

        if (!session) {
            vscode.window.showErrorMessage("Could not find the session for the selected item.");
            return;
        }
        const rootEntry = baseUriString ? session.storage.findEntry(baseUriString) : null;
        if (!rootEntry && baseUriString) {
            vscode.window.showErrorMessage("Could not find the starting directory entry.");
            return;
        }

        const excludePatterns = vscode.workspace.getConfiguration('fileintegrator').get<Record<string, boolean>>('excludeFromTree') || {};
        const exclusionCheck = (relativePath: string) => isPathExcludedFromTree(relativePath, excludePatterns);

        try {
            console.log(`[CopyStructure] Building structure for ${scopeName}`);
            let structureString = '';
            if (rootEntry) {
                structureString += `${path.basename(vscode.Uri.parse(rootEntry.uriString).fsPath || rootEntry.uriString)}\n`;
                structureString += buildStructureStringRecursive(startingEntries, session, "  ", 1, rootEntry.uriString, exclusionCheck);
            } else {
                structureString += buildStructureStringRecursive(startingEntries, session, "", 0, undefined, exclusionCheck);
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
            entriesToDiff = [...session.storage.files];
            scopeName = `session "${session.name}"`;
        } else if (item instanceof ResourceItem) {
            session = sessionManager.getSession(item.sessionId);
            if (!session) return;
            const baseName = path.basename(item.resourceUri?.fsPath || item.uriString);
            if (item.isDirectory) {
                entriesToDiff = getDescendantEntries(session, item.uriString);
                scopeName = `directory "${baseName}"`;
            } else {
                entriesToDiff = [item.entry];
                scopeName = `file "${baseName}"`;
            }
        } else {
            session = await selectSession(`Select session to ${copy ? 'copy' : 'generate'} Git diff for`, sessionManager);
            if (!session) return;
            entriesToDiff = [...session.storage.files];
            scopeName = `session "${session.name}"`;
        }

        if (!session) { vscode.window.showErrorMessage("Could not determine session for Git Diff."); return; }
        if (entriesToDiff.length === 0) { vscode.window.showInformationMessage(`No items found in ${scopeName} to diff.`); return; }

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
            fileSystemEntries,
            scopeName,
            (msg) => vscode.window.showInformationMessage(msg),
            copy,
            gitAPI
        );
    };    register('fileintegrator.generateDiffDocument', (item?: SessionItem) => diffHandler(item, false));
    register('fileintegrator.copyDiffToClipboard', (item?: SessionItem) => diffHandler(item, true));    register('fileintegrator.generateDirectoryDiffDocument', (item: ResourceItem) => diffHandler(item, false));
    register('fileintegrator.copyDirectoryDiffToClipboard', (item: ResourceItem) => diffHandler(item, true));
    register('fileintegrator.generateFileDiffDocument', (item: ResourceItem) => diffHandler(item, false));
    register('fileintegrator.copyFileDiffToClipboard', (item: ResourceItem) => diffHandler(item, true));

    // --- Expand All Subdirectories Command ---
    register('fileintegrator.expandAllSubdirectories', async (item?: SessionItem) => {
        const s = item?.session ?? await selectSession('Select session to expand all subdirectories for', sessionManager);
        if (!s) return;

        const directoryItems = s.storage.files.filter((entry: FileEntry) => entry.isDirectory);
        if (directoryItems.length === 0) {
            vscode.window.showInformationMessage(`No directories found in session "${s.name}".`);
            return;
        }

        try {
            for (const entry of directoryItems) {
                const treeItem = fileIntegratorProvider.findTreeItem(entry.uriString, s.id);
                if (treeItem) {
                    await treeView.reveal(treeItem, { expand: 3 }); // Expand up to 3 levels deep
                }
            }
            vscode.window.showInformationMessage(`Expanded all directories in session "${s.name}".`);
        } catch (error) {
            console.log('Error expanding directories:', error);
            vscode.window.showWarningMessage(`Some directories could not be expanded in session "${s.name}".`);
        }
    });
}

// --- Command Logic Helpers ---

/** Logic for adding the active editor's resource to a session. */
async function addActiveEditorLogic(targetSession: Session) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showInformationMessage("No active editor found."); return; }
    const { uri } = editor.document;
    const uriString = uri.toString();

    if (editor.document === targetSession.associatedDocument) {
        vscode.window.showInformationMessage("Cannot add the session's own generated document to itself.");
        return;
    }

    if (targetSession.storage.findEntry(uriString)) {
        vscode.window.showInformationMessage(`"${getDisplayUri(uriString, 'treeDescription')}" is already in session "${targetSession.name}".`);
        return;
    }

    const newEntry: FileEntry = { uriString: uriString, isDirectory: false, content: null, sessionId: targetSession.id };
    if (targetSession.storage.addItem(newEntry)) {
        sessionManager.persistSessions();
        await updateCodeBlockDocument(targetSession);
        fileIntegratorProvider.refresh();
        vscode.window.showInformationMessage(`Added "${getDisplayUri(uriString, 'treeDescription')}" to session "${targetSession.name}".`);
    } else {
        vscode.window.showWarningMessage(`Failed to add "${getDisplayUri(uriString)}". It might already exist.`);
    }
}

/** Logic for adding all unique open editor resources to a session. */
async function addAllOpenEditorsLogic(targetSession: Session) {
    const openUris = new Set<string>();
    const sessionDocUriString = targetSession.associatedDocument?.uri.toString();

    vscode.window.tabGroups.all.forEach(group => {
        group.tabs.forEach(tab => {
            const uri = (tab.input as any)?.uri;
            if (uri instanceof vscode.Uri) {
                const uriString = uri.toString();
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
        if (targetSession.storage.findEntry(uriString)) {
            skippedCount++;
        } else {
            const newEntry: FileEntry = { uriString: uriString, isDirectory: false, content: null, sessionId: targetSession.id };
            if (targetSession.storage.addItem(newEntry)) {
                addedCount++;
            } else {
                console.warn(`[addAllOpenEditors] Failed to add item ${uriString} even after existence check.`);
                skippedCount++;
            }
        }
    });

    if (addedCount > 0) {
        sessionManager.persistSessions();
        await updateCodeBlockDocument(targetSession);
        fileIntegratorProvider.refresh();
        let message = `Added ${addedCount} editor(s) to "${targetSession.name}".`;
        if (skippedCount > 0) {
            message += ` Skipped ${skippedCount} (already present or session document).`;
        }
        vscode.window.showInformationMessage(message);
    } else if (skippedCount > 0) {
        vscode.window.showInformationMessage(`All open editors were already present in session "${targetSession.name}" or represent the session document.`);
    } else {
        console.error("[addAllOpenEditors] Inconsistent state: Found open URIs but added/skipped count is zero.");
        vscode.window.showInformationMessage("No new editors were added.");
    }
}

// --- Deactivation ---
export function deactivate() {
    console.log('Deactivating File Integrator...');
    gitAPI = undefined;
}
