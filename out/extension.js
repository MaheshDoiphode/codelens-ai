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
const sessionManager_1 = require("./sessionManager");
const treeItems_1 = require("./treeItems");
const treeDataProvider_1 = require("./treeDataProvider"); // Renaming class for clarity here
const utils_1 = require("./utils"); // createNewAssociatedDocument, getDisplayPath, isPathExcluded not directly used here
const git_1 = require("./git"); // calculateDiffForEntries not directly used here
// --- Global Variables & Activation ---
let sessionManager;
let codeLensAiProvider;
let treeView;
let gitAPI;
/**
 * This method is called when your extension is activated.
 * Your extension is activated the very first time the command is executed.
 */
async function activate(context) {
    console.log('Activating CodeLens AI...');
    try {
        const gitExtension = vscode.extensions.getExtension('vscode.git');
        if (gitExtension) {
            if (!gitExtension.isActive) {
                // console.log('Activating vscode.git extension for CodeLens AI...');
                await gitExtension.activate();
            }
            gitAPI = gitExtension.exports.getAPI(1);
            if (gitAPI) {
                console.log('CodeLens AI: Successfully obtained Git API.');
            }
            else {
                console.error('CodeLens AI: Failed to get Git API from vscode.git extension.');
                vscode.window.showWarningMessage('CodeLens AI: Could not initialize Git features. Git API unavailable.');
            }
        }
        else {
            console.warn('CodeLens AI: vscode.git extension not found.');
            vscode.window.showWarningMessage('CodeLens AI: vscode.git extension not installed or disabled. Git features unavailable.');
        }
    }
    catch (error) {
        console.error('CodeLens AI: Failed to get/activate Git API:', error);
        vscode.window.showWarningMessage('CodeLens AI: Could not initialize Git features due to an error.');
    }
    sessionManager = new sessionManager_1.SessionManager(context);
    sessionManager.loadSessions();
    codeLensAiProvider = new treeDataProvider_1.CodeLensAiProvider(sessionManager);
    treeView = vscode.window.createTreeView('codeLensAiView', {
        treeDataProvider: codeLensAiProvider,
        dragAndDropController: codeLensAiProvider,
        canSelectMany: true
    });
    context.subscriptions.push(treeView);
    registerCommands(context);
    context.subscriptions.push({ dispose: () => sessionManager.dispose() });
    console.log('CodeLens AI activated.');
}
/**
 * Registers all commands for the extension.
 */
function registerCommands(context) {
    const register = (commandId, callback) => {
        context.subscriptions.push(vscode.commands.registerCommand(commandId, callback));
    };
    register('codelensai.addSession', async () => {
        const n = await vscode.window.showInputBox({ prompt: "Enter new session name", value: `Session ${sessionManager.getAllSessions().length + 1}` });
        if (n?.trim()) {
            const s = sessionManager.createSession(n.trim());
            codeLensAiProvider.refresh();
            await treeView.reveal(new treeItems_1.SessionItem(s), { select: true, focus: true, expand: true });
        }
    });
    register('codelensai.removeSession', async (item) => {
        const s = item?.session ?? await (0, utils_1.selectSession)('Select session to remove', sessionManager);
        if (!s)
            return;
        if (await vscode.window.showWarningMessage(`Remove session "${s.name}" and close its associated document (if open)?`, { modal: true }, 'Yes') === 'Yes') {
            await s.closeAssociatedDocument(true);
            if (sessionManager.removeSession(s.id))
                codeLensAiProvider.refresh();
        }
    });
    register('codelensai.renameSession', async (item) => {
        const s = item?.session ?? await (0, utils_1.selectSession)('Select session to rename', sessionManager);
        if (!s)
            return;
        const n = await vscode.window.showInputBox({ prompt: `Enter new name for "${s.name}"`, value: s.name });
        if (n?.trim() && n.trim() !== s.name && sessionManager.renameSession(s.id, n.trim())) {
            codeLensAiProvider.refresh();
        }
    });
    register('codelensai.clearSession', async (item) => {
        const s = item?.session ?? await (0, utils_1.selectSession)('Select session to clear', sessionManager);
        if (!s)
            return;
        if (s.storage.files.length === 0) {
            vscode.window.showInformationMessage(`Session "${s.name}" is already empty.`);
            return;
        }
        const count = s.storage.clearFiles();
        sessionManager.persistSessions();
        codeLensAiProvider.refresh();
        await (0, utils_1.updateCodeBlockDocument)(s);
        vscode.window.showInformationMessage(`Cleared ${count} items from session "${s.name}".`);
    });
    register('codelensai.generateCodeBlock', async (item) => {
        const s = item?.session ?? await (0, utils_1.selectSession)('Select session to generate code block for', sessionManager);
        if (!s)
            return;
        if (s.storage.files.length === 0) {
            vscode.window.showInformationMessage(`Session "${s.name}" is empty.`);
            return;
        }
        const doc = await (0, utils_1.showCodeBlockDocument)(s);
        if (doc)
            await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
    });
    register('codelensai.copyToClipboard', async (item) => {
        const s = item?.session ?? await (0, utils_1.selectSession)('Select session to copy content from', sessionManager);
        if (!s)
            return;
        if (s.storage.resourcesOnly.length === 0) {
            vscode.window.showInformationMessage(`Session "${s.name}" contains no file/resource content to copy.`);
            return;
        }
        let contentToCopy = '';
        if (s.associatedDocument && !s.associatedDocument.isClosed) {
            contentToCopy = s.associatedDocument.getText();
            // console.log(`[CodeLensAI:CopyToClipboard] Copying from associated document for session ${s.id}`);
        }
        else {
            // console.log(`[CodeLensAI:CopyToClipboard] Generating fresh content for session ${s.id}`);
            contentToCopy = await (0, utils_1.generateMarkdownContent)(s);
        }
        if (contentToCopy && !contentToCopy.startsWith('<!-- No file/resource content')) {
            await vscode.env.clipboard.writeText(contentToCopy);
            vscode.window.showInformationMessage(`Session "${s.name}" Code Block content copied!`);
        }
        else {
            vscode.window.showWarningMessage("No code block content generated or found to copy.");
        }
    });
    register('codelensai.generateDirectoryCodeBlock', async (item) => {
        if (!(item instanceof treeItems_1.ResourceItem) || !item.isDirectory)
            return;
        const session = sessionManager.getSession(item.sessionId);
        if (!session)
            return;
        const directoryName = path.basename(item.resourceUri?.fsPath || 'directory');
        const descendants = (0, utils_1.getDescendantEntries)(session, item.uriString).filter(e => !e.isDirectory);
        if (descendants.length === 0) {
            vscode.window.showInformationMessage(`Directory "${directoryName}" contains no file content within the session.`);
            return;
        }
        const content = await (0, utils_1.generateMarkdownContentForEntries)(descendants, `Content for Directory: ${directoryName}`);
        const doc = await vscode.workspace.openTextDocument({ content: content, language: 'markdown' });
        await vscode.window.showTextDocument(doc, { preview: false });
    });
    register('codelensai.copyDirectoryContentToClipboard', async (item) => {
        if (!(item instanceof treeItems_1.ResourceItem) || !item.isDirectory)
            return;
        const session = sessionManager.getSession(item.sessionId);
        if (!session)
            return;
        const directoryName = path.basename(item.resourceUri?.fsPath || 'directory');
        const descendants = (0, utils_1.getDescendantEntries)(session, item.uriString).filter(e => !e.isDirectory);
        if (descendants.length === 0) {
            vscode.window.showInformationMessage(`Directory "${directoryName}" contains no file content to copy.`);
            return;
        }
        const content = await (0, utils_1.generateMarkdownContentForEntries)(descendants, `Content for Directory: ${directoryName}`);
        await vscode.env.clipboard.writeText(content);
        vscode.window.showInformationMessage(`Content for directory "${directoryName}" copied!`);
    });
    register('codelensai.removeItem', async (item) => {
        if (!(item instanceof treeItems_1.ResourceItem))
            return;
        const s = sessionManager.getSession(item.sessionId);
        if (s && s.storage.removeEntry(item.uriString)) {
            sessionManager.persistSessions();
            await (0, utils_1.updateCodeBlockDocument)(s);
            codeLensAiProvider.refresh();
            vscode.window.showInformationMessage(`Removed "${(0, utils_1.getDisplayUri)(item.uriString, 'treeDescription')}". You can undo this by clicking 'Undo Last Removal' in the tree view.`);
        }
        else {
            codeLensAiProvider.refresh();
        }
    });
    register('codelensai.refreshView', () => codeLensAiProvider.refresh());
    register('codelensai.undoLastRemoval', async (item) => {
        const s = item?.session ?? await (0, utils_1.selectSession)('Select session to undo last removal for', sessionManager);
        if (!s)
            return;
        if (!s.storage.hasLastRemovedFiles()) {
            vscode.window.showInformationMessage(`No recent removals to undo for session "${s.name}".`);
            return;
        }
        const restored = s.storage.undoLastRemoval();
        if (restored && restored.length > 0) {
            sessionManager.persistSessions();
            await (0, utils_1.updateCodeBlockDocument)(s);
            codeLensAiProvider.refresh();
            vscode.window.showInformationMessage(`Successfully restored ${restored.length} item(s) to session "${s.name}".`);
            try {
                if (restored.length > 0) {
                    const restoredItem = codeLensAiProvider.findTreeItem(restored[0].uriString, s.id);
                    if (restoredItem) {
                        await treeView.reveal(restoredItem, { select: true, focus: false, expand: true });
                    }
                }
            }
            catch (revealError) {
                // console.log('Could not reveal restored item, but undo was successful:', revealError);
            }
        }
        else {
            vscode.window.showWarningMessage(`Failed to undo last removal for session "${s.name}".`);
        }
    });
    register('codelensai.addActiveEditorToSession', async (item) => {
        const targetSession = item?.session ?? await (0, utils_1.selectSession)("Select session to add active editor to", sessionManager);
        if (targetSession)
            await addActiveEditorLogic(targetSession);
    });
    register('codelensai.addAllOpenEditorsToSession', async (item) => {
        const session = item?.session ?? await (0, utils_1.selectSession)("Select session to add all open editors to", sessionManager);
        if (session)
            await addAllOpenEditorsLogic(session);
    });
    register('codelensai.copyDirectoryStructure', async (item) => {
        let session;
        let startingEntries = [];
        let baseUriString;
        let scopeName = '';
        if (item instanceof treeItems_1.SessionItem) {
            session = item.session;
            startingEntries = session.storage.files.filter(f => !f.parentUriString);
            baseUriString = undefined;
            scopeName = `session "${session.name}"`;
        }
        else if (item instanceof treeItems_1.ResourceItem && item.isDirectory) {
            session = sessionManager.getSession(item.sessionId);
            if (!session)
                return;
            startingEntries = session.storage.files.filter(f => f.parentUriString === item.uriString);
            baseUriString = item.uriString;
            scopeName = `directory "${path.basename(item.resourceUri?.fsPath || 'directory')}"`;
        }
        else if (item instanceof treeItems_1.ResourceItem && !item.isDirectory) {
            vscode.window.showInformationMessage("Cannot copy structure of a single file.");
            return;
        }
        else {
            vscode.window.showWarningMessage("Please right-click on a Session or Directory item to copy its structure.");
            return;
        }
        if (!session) {
            vscode.window.showErrorMessage("CodeLens AI: Could not find the session for the selected item.");
            return;
        }
        const rootEntry = baseUriString ? session.storage.findEntry(baseUriString) : null;
        if (!rootEntry && baseUriString) {
            vscode.window.showErrorMessage("CodeLens AI: Could not find the starting directory entry.");
            return;
        }
        const excludePatterns = vscode.workspace.getConfiguration('codelensai').get('excludeFromTree') || {};
        const exclusionCheck = (relativePath) => (0, utils_1.isPathExcludedFromTree)(relativePath, excludePatterns);
        try {
            // console.log(`[CodeLensAI:CopyStructure] Building structure for ${scopeName}`);
            let structureString = '';
            if (rootEntry) {
                structureString += `${path.basename(vscode.Uri.parse(rootEntry.uriString).fsPath || rootEntry.uriString)}\n`;
                structureString += (0, utils_1.buildStructureStringRecursive)(startingEntries, session, "  ", 1, rootEntry.uriString, exclusionCheck);
            }
            else {
                structureString += (0, utils_1.buildStructureStringRecursive)(startingEntries, session, "", 0, undefined, exclusionCheck);
            }
            if (structureString.trim() === '' && rootEntry) {
                structureString = `${path.basename(vscode.Uri.parse(rootEntry.uriString).fsPath || rootEntry.uriString)}\n(Directory is empty or all contents excluded)`;
            }
            else if (structureString.trim() === '') {
                structureString = `(Session is empty or all contents excluded)`;
            }
            await vscode.env.clipboard.writeText(structureString.trimEnd());
            vscode.window.showInformationMessage(`Directory structure for ${scopeName} copied to clipboard!`);
            // console.log(`[CodeLensAI:CopyStructure] Copied:\n${structureString.trimEnd()}`);
        }
        catch (error) {
            console.error(`[CodeLensAI:CopyStructure] Error building structure for ${scopeName}:`, error);
            vscode.window.showErrorMessage(`CodeLens AI: Failed to copy structure: ${error.message}`);
        }
    });
    const diffHandler = async (item, copy) => {
        if (!gitAPI) {
            vscode.window.showErrorMessage("CodeLens AI: Git integration is not available.");
            return;
        }
        let session;
        let entriesToDiff = [];
        let scopeName = '';
        if (item instanceof treeItems_1.SessionItem) {
            session = item.session;
            entriesToDiff = [...session.storage.files];
            scopeName = `session "${session.name}"`;
        }
        else if (item instanceof treeItems_1.ResourceItem) {
            session = sessionManager.getSession(item.sessionId);
            if (!session)
                return;
            const baseName = path.basename(item.resourceUri?.fsPath || item.uriString);
            if (item.isDirectory) {
                entriesToDiff = (0, utils_1.getDescendantEntries)(session, item.uriString);
                scopeName = `directory "${baseName}"`;
            }
            else {
                entriesToDiff = [item.entry];
                scopeName = `file "${baseName}"`;
            }
        }
        else {
            session = await (0, utils_1.selectSession)(`Select session to ${copy ? 'copy' : 'generate'} Git diff for`, sessionManager);
            if (!session)
                return;
            entriesToDiff = [...session.storage.files];
            scopeName = `session "${session.name}"`;
        }
        if (!session) {
            vscode.window.showErrorMessage("CodeLens AI: Could not determine session for Git Diff.");
            return;
        }
        if (entriesToDiff.length === 0) {
            vscode.window.showInformationMessage(`No items found in ${scopeName} to diff.`);
            return;
        }
        const fileSystemEntries = entriesToDiff.filter(entry => {
            try {
                return vscode.Uri.parse(entry.uriString).scheme === 'file';
            }
            catch {
                return false;
            }
        });
        if (fileSystemEntries.length === 0) {
            vscode.window.showInformationMessage(`No file system items found in ${scopeName} to diff with Git.`);
            return;
        }
        // console.log(`[CodeLensAI:Diff] Initiating diff for ${scopeName} (${fileSystemEntries.length} potential file system items)`);
        await (0, git_1.generateDiffCommon)(fileSystemEntries, scopeName, (msg) => vscode.window.showInformationMessage(msg), copy, gitAPI);
    };
    register('codelensai.generateDiffDocument', (item) => diffHandler(item, false));
    register('codelensai.copyDiffToClipboard', (item) => diffHandler(item, true));
    register('codelensai.generateDirectoryDiffDocument', (item) => diffHandler(item, false));
    register('codelensai.copyDirectoryDiffToClipboard', (item) => diffHandler(item, true));
    register('codelensai.generateFileDiffDocument', (item) => diffHandler(item, false));
    register('codelensai.copyFileDiffToClipboard', (item) => diffHandler(item, true));
    register('codelensai.expandAllSubdirectories', async (item) => {
        const s = item?.session ?? await (0, utils_1.selectSession)('Select session to expand all subdirectories for', sessionManager);
        if (!s)
            return;
        const directoryItems = s.storage.files.filter((entry) => entry.isDirectory);
        if (directoryItems.length === 0) {
            vscode.window.showInformationMessage(`No directories found in session "${s.name}".`);
            return;
        }
        try {
            for (const entry of directoryItems) {
                const treeItem = codeLensAiProvider.findTreeItem(entry.uriString, s.id);
                if (treeItem) {
                    await treeView.reveal(treeItem, { expand: 3 });
                }
            }
            vscode.window.showInformationMessage(`Expanded all directories in session "${s.name}".`);
        }
        catch (error) {
            // console.log('Error expanding directories:', error);
            vscode.window.showWarningMessage(`Some directories could not be expanded in session "${s.name}".`);
        }
    });
}
/**
 * Logic for adding the active editor's resource to a session.
 */
async function addActiveEditorLogic(targetSession) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage("No active editor found.");
        return;
    }
    const { uri } = editor.document;
    const uriString = uri.toString();
    if (editor.document === targetSession.associatedDocument) {
        vscode.window.showInformationMessage("Cannot add the session's own generated document to itself.");
        return;
    }
    if (targetSession.storage.findEntry(uriString)) {
        vscode.window.showInformationMessage(`"${(0, utils_1.getDisplayUri)(uriString, 'treeDescription')}" is already in session "${targetSession.name}".`);
        return;
    }
    const newEntry = { uriString: uriString, isDirectory: false, content: null, sessionId: targetSession.id };
    if (targetSession.storage.addItem(newEntry)) {
        sessionManager.persistSessions();
        await (0, utils_1.updateCodeBlockDocument)(targetSession);
        codeLensAiProvider.refresh();
        vscode.window.showInformationMessage(`Added "${(0, utils_1.getDisplayUri)(uriString, 'treeDescription')}" to session "${targetSession.name}".`);
    }
    else {
        vscode.window.showWarningMessage(`Failed to add "${(0, utils_1.getDisplayUri)(uriString)}". It might already exist.`);
    }
}
/**
 * Logic for adding all unique open editor resources to a session.
 */
async function addAllOpenEditorsLogic(targetSession) {
    const openUris = new Set();
    const sessionDocUriString = targetSession.associatedDocument?.uri.toString();
    vscode.window.tabGroups.all.forEach(group => {
        group.tabs.forEach(tab => {
            const uri = tab.input?.uri;
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
        }
        else {
            const newEntry = { uriString: uriString, isDirectory: false, content: null, sessionId: targetSession.id };
            if (targetSession.storage.addItem(newEntry)) {
                addedCount++;
            }
            else {
                // console.warn(`[CodeLensAI:addAllOpenEditors] Failed to add item ${uriString} even after existence check.`);
                skippedCount++;
            }
        }
    });
    if (addedCount > 0) {
        sessionManager.persistSessions();
        await (0, utils_1.updateCodeBlockDocument)(targetSession);
        codeLensAiProvider.refresh();
        let message = `Added ${addedCount} editor(s) to "${targetSession.name}".`;
        if (skippedCount > 0) {
            message += ` Skipped ${skippedCount} (already present or session document).`;
        }
        vscode.window.showInformationMessage(message);
    }
    else if (skippedCount > 0) {
        vscode.window.showInformationMessage(`All open editors were already present in session "${targetSession.name}" or represent the session document.`);
    }
    else {
        // console.error("[CodeLensAI:addAllOpenEditors] Inconsistent state: Found open URIs but added/skipped count is zero.");
        vscode.window.showInformationMessage("No new editors were added.");
    }
}
/**
 * This method is called when your extension is deactivated.
 */
function deactivate() {
    console.log('Deactivating CodeLens AI...');
    gitAPI = undefined;
}
//# sourceMappingURL=extension.js.map