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
exports.isPathExcluded = isPathExcluded;
exports.isPathExcludedFromTree = isPathExcludedFromTree;
exports.selectSession = selectSession;
exports.generateMarkdownContentForEntries = generateMarkdownContentForEntries;
exports.generateMarkdownContent = generateMarkdownContent;
exports.showCodeBlockDocument = showCodeBlockDocument;
exports.createNewAssociatedDocument = createNewAssociatedDocument;
exports.updateCodeBlockDocument = updateCodeBlockDocument;
exports.getDisplayUri = getDisplayUri;
exports.getDisplayPath = getDisplayPath;
exports.getDescendantEntries = getDescendantEntries;
exports.buildStructureStringRecursive = buildStructureStringRecursive;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const minimatch_1 = require("minimatch");
/**
 * Checks if a file system path matches drag & drop exclusion patterns.
 * Uses `codelensai.exclude` setting.
 */
function isPathExcluded(filePath) {
    const config = vscode.workspace.getConfiguration('codelensai');
    const excludePatterns = config.get('exclude');
    if (!excludePatterns || Object.keys(excludePatterns).length === 0) {
        return false;
    }
    const normalizedFilePath = filePath.replace(/\\/g, '/');
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const options = { dot: true, nocase: process.platform === 'win32' };
    for (const pattern in excludePatterns) {
        if (excludePatterns[pattern] === true) {
            const normalizedPattern = pattern.replace(/\\/g, '/');
            if ((0, minimatch_1.minimatch)(normalizedFilePath, normalizedPattern, options)) {
                return true;
            }
            if (workspaceFolders) {
                for (const folder of workspaceFolders) {
                    const folderPath = folder.uri.fsPath.replace(/\\/g, '/');
                    if (normalizedFilePath.startsWith(folderPath + '/')) {
                        const relativePath = normalizedFilePath.substring(folderPath.length + 1);
                        if ((0, minimatch_1.minimatch)(relativePath, normalizedPattern, options)) {
                            return true;
                        }
                    }
                }
            }
            if (!normalizedPattern.includes('/')) {
                if ((0, minimatch_1.minimatch)(path.basename(normalizedFilePath), normalizedPattern, options)) {
                    return true;
                }
            }
        }
    }
    return false;
}
/**
 * Checks if a *relative* path matches structure copy exclusion patterns.
 * Uses `codelensai.excludeFromTree` setting.
 */
function isPathExcludedFromTree(relativePath, excludePatterns) {
    if (!excludePatterns || Object.keys(excludePatterns).length === 0) {
        return false;
    }
    const normalizedRelativePath = relativePath.replace(/\\/g, '/');
    const options = { dot: true, nocase: process.platform === 'win32' };
    for (const pattern in excludePatterns) {
        if (excludePatterns[pattern] === true) {
            const normalizedPattern = pattern.replace(/\\/g, '/');
            if ((0, minimatch_1.minimatch)(normalizedRelativePath, normalizedPattern, options)) {
                return true;
            }
        }
    }
    return false;
}
/** Prompts user to select a session via Quick Pick. Returns undefined if cancelled. */
async function selectSession(placeHolder, sessionManager) {
    const sessions = sessionManager.getAllSessions();
    if (sessions.length === 0) {
        vscode.window.showErrorMessage("CodeLens AI: No sessions available.");
        return undefined;
    }
    if (sessions.length === 1)
        return sessions[0];
    const picks = sessions.map(s => ({ label: s.name, description: `(${s.storage.files.length} items)`, session: s }));
    const selection = await vscode.window.showQuickPick(picks, { placeHolder, canPickMany: false });
    return selection?.session;
}
/**
 * Generates aggregated Markdown content for a specific list of FileEntry items.
 */
async function generateMarkdownContentForEntries(entries, headerComment) {
    let content = headerComment ? `<!-- ${headerComment} -->\n\n` : '';
    const resourceEntries = entries.filter(f => !f.isDirectory);
    if (resourceEntries.length === 0) {
        return headerComment
            ? `<!-- ${headerComment} -->\n<!-- No file/resource content found for the given entries. -->\n`
            : `<!-- No file/resource content found for the given entries. -->\n`;
    }
    // console.log(`[CodeLensAI:MarkdownGenEntries] Generating content for ${resourceEntries.length} resources.`);
    for (const entry of resourceEntries) {
        let resourceContent = entry.content;
        if (resourceContent === null) {
            try {
                const uri = vscode.Uri.parse(entry.uriString);
                // console.log(`[CodeLensAI:MarkdownGenEntries] Reading content for URI: ${entry.uriString}`);
                const doc = await vscode.workspace.openTextDocument(uri);
                resourceContent = doc.getText();
            }
            catch (error) {
                console.error(`[CodeLensAI:MarkdownGenEntries] Error reading URI ${entry.uriString}:`, error);
                const displayUri = getDisplayUri(entry.uriString);
                resourceContent = (error?.code === 'FileNotFound' || error?.code === 'EntryNotFound' || error?.message?.includes('cannot open') || error?.message?.includes('Unable to resolve'))
                    ? `--- Error: Resource not found or inaccessible (${displayUri}) ---`
                    : `--- Error reading content for ${displayUri}: ${error.message} ---`;
            }
        }
        const displayUri = getDisplayUri(entry.uriString, 'markdownHeader');
        const uriPath = vscode.Uri.parse(entry.uriString).path;
        const langPart = uriPath.includes('!/') ? uriPath.substring(uriPath.lastIndexOf('!/') + 1) : uriPath;
        const ext = path.extname(langPart);
        const lang = ext ? ext.substring(1) : '';
        content += `<file path="${displayUri}">\n${resourceContent ?? '--- Content Unavailable ---\n'}\n</file>\n\n`;
    }
    return content.trimEnd();
}
/** Generates aggregated Markdown content for a *whole session*, respecting order. */
async function generateMarkdownContent(session) {
    return generateMarkdownContentForEntries(session.storage.files, `Content for Session: ${session.name}`);
}
/** Ensures the code block document for a session is visible and up-to-date. */
async function showCodeBlockDocument(session) {
    const content = await generateMarkdownContent(session);
    if (session.associatedDocument && !session.associatedDocument.isClosed) {
        const doc = session.associatedDocument;
        try {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), content);
            const success = await vscode.workspace.applyEdit(edit);
            if (!success)
                throw new Error("ApplyEdit failed to update document");
            // console.log(`[CodeLensAI:ShowDoc] Updated associated document for session ${session.id}`);
            return doc;
        }
        catch (e) {
            console.error(`[CodeLensAI:ShowDoc] Error updating associated doc ${doc.uri}:`, e);
            await session.closeAssociatedDocument(false);
            return createNewAssociatedDocument(session, content);
        }
    }
    return createNewAssociatedDocument(session, content);
}
/** Helper function solely for creating a new associated Markdown document. */
async function createNewAssociatedDocument(session, content) {
    try {
        // console.log(`[CodeLensAI:ShowDoc] Creating new associated document for session ${session.id}`);
        const doc = await vscode.workspace.openTextDocument({ content: content, language: 'markdown' });
        session.setAssociatedDocument(doc);
        return doc;
    }
    catch (e) {
        console.error(`[CodeLensAI:ShowDoc] Failed to create associated document:`, e);
        vscode.window.showErrorMessage(`CodeLens AI: Failed to create associated document: ${e.message}`);
        session.closeAssociatedDocument(false);
        return undefined;
    }
}
/** Updates the associated document content *if* it exists and is open, without showing it. */
async function updateCodeBlockDocument(session) {
    if (session.associatedDocument && !session.associatedDocument.isClosed) {
        const doc = session.associatedDocument;
        // console.log(`[CodeLensAI:UpdateDoc] Updating associated document in background for session ${session.id}`);
        const content = await generateMarkdownContent(session);
        try {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), content);
            const success = await vscode.workspace.applyEdit(edit);
            if (!success) {
                console.warn(`[CodeLensAI:UpdateDoc] ApplyEdit failed silently for ${doc.uri}. Detaching link.`);
                session.closeAssociatedDocument(false);
            }
            else {
                // console.log(`[CodeLensAI:UpdateDoc] Successfully updated associated document.`);
            }
        }
        catch (err) {
            console.error(`[CodeLensAI:UpdateDoc] Error applying edit to ${doc.uri}:`, err);
            session.closeAssociatedDocument(false);
            vscode.window.showErrorMessage("CodeLens AI: Error updating the associated code block document.");
        }
    }
}
/** Generates a display-friendly string for a URI */
function getDisplayUri(uriString, type = 'markdownHeader') {
    try {
        const uri = vscode.Uri.parse(uriString);
        const scheme = uri.scheme;
        const uriPath = uri.path;
        const bangIndex = uri.toString().lastIndexOf('!/');
        if ((scheme === 'jar' || scheme === 'zip' || scheme === 'file') && bangIndex !== -1) {
            const fullUriStr = uri.toString();
            let archivePart = fullUriStr.substring(0, bangIndex);
            let internalPath = fullUriStr.substring(bangIndex + 1);
            let archiveName = 'archive';
            let archiveScheme = scheme;
            try {
                const archiveUri = vscode.Uri.parse(archivePart);
                archiveName = path.basename(archiveUri.fsPath || archiveUri.path);
                archiveScheme = archiveUri.scheme;
            }
            catch {
                archiveName = path.basename(archivePart);
            }
            const displayInternalPath = (internalPath.startsWith('/') ? internalPath.substring(1) : internalPath).replace(/\\/g, '/');
            const fullDisplay = `${archiveName}!/${displayInternalPath}`;
            const prefix = (archiveScheme !== 'file' && archiveScheme !== scheme) ? `${archiveScheme}:` : '';
            if (type === 'treeDescription') {
                const shortArchive = archiveName.length > 15 ? archiveName.substring(0, 6) + '...' + archiveName.slice(-6) : archiveName;
                const shortInternal = displayInternalPath.length > 25 ? '/.../' + displayInternalPath.slice(-22) : displayInternalPath;
                return `${prefix}${shortArchive}!/${shortInternal}`;
            }
            else {
                return `${prefix}${fullDisplay}`;
            }
        }
        else if (scheme === 'file') {
            return getDisplayPath(uri.fsPath, type === 'treeDescription');
        }
        else {
            let displayPath = uri.fsPath || uri.path;
            if (uri.authority && displayPath.startsWith('/' + uri.authority)) {
                displayPath = displayPath.substring(uri.authority.length + 1);
            }
            if (displayPath.startsWith('/'))
                displayPath = displayPath.substring(1);
            const authority = uri.authority ? `//${uri.authority}/` : '';
            const prefix = `${scheme}:`;
            const fullDisplay = `${prefix}${authority}${displayPath}`;
            if (type === 'treeDescription' && fullDisplay.length > 45) {
                return fullDisplay.substring(0, prefix.length + 4) + '...' + fullDisplay.substring(fullDisplay.length - (45 - prefix.length - 7));
            }
            return fullDisplay;
        }
    }
    catch (e) {
        // console.warn(`[CodeLensAI:getDisplayUri] Error parsing/formatting URI string: ${uriString}`, e);
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
    if (workspaceFolders) {
        const sortedFolders = [...workspaceFolders].sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length);
        for (const folder of sortedFolders) {
            const folderPath = folder.uri.fsPath;
            const rel = path.relative(folderPath, filePath);
            if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
                relativePath = (rel === '') ? path.basename(folderPath) : rel;
                relativePath = relativePath.replace(/\\/g, '/');
                if (short && rel !== '' && workspaceFolders.length > 1) {
                    relativePath = `${path.basename(folder.name)}/${relativePath}`;
                }
                break;
            }
        }
    }
    if (relativePath) {
        if (short && relativePath.length > 40) {
            const parts = relativePath.split('/');
            return parts.length > 2 ? parts[0] + '/.../' + parts[parts.length - 1] : relativePath;
        }
        return relativePath;
    }
    else {
        const sep = path.sep;
        const pathParts = filePath.split(sep).filter(Boolean);
        const partsCount = pathParts.length;
        if (short && partsCount > 3) {
            return `...${sep}${pathParts.slice(-2).join(sep)}`;
        }
        else if (!short && partsCount > 5) {
            return `...${sep}${pathParts.slice(-3).join(sep)}`;
        }
        else {
            return filePath;
        }
    }
}
/** Gets a FileEntry and all its descendants within a session's storage. */
function getDescendantEntries(session, directoryUriString) {
    const startingEntry = session.storage.findEntry(directoryUriString);
    if (!startingEntry)
        return [];
    if (!startingEntry.isDirectory) {
        // console.warn(`[CodeLensAI:getDescendantEntries] Provided URI is not a directory: ${directoryUriString}`);
        return [startingEntry];
    }
    const descendants = [startingEntry];
    const queue = [directoryUriString];
    const processedUris = new Set([directoryUriString]);
    while (queue.length > 0) {
        const currentParentUri = queue.shift();
        for (const file of session.storage.files) {
            if (file.parentUriString === currentParentUri && !processedUris.has(file.uriString)) {
                descendants.push(file);
                processedUris.add(file.uriString);
                if (file.isDirectory) {
                    queue.push(file.uriString);
                }
            }
        }
    }
    // console.log(`[CodeLensAI:getDescendantEntries] Found ${descendants.length} entries (including root) for directory ${getDisplayUri(directoryUriString)}`);
    return descendants;
}
/**
 * Recursively builds the directory structure string.
 * @param entries The entries to process.
 * @param session The current session.
 * @param prefix The prefix string for the current level.
 * @param level The current depth level.
 * @param rootUriString URI of the root directory being copied (or undefined if session root).
 * @param isExcluded Function to check exclusion.
 */
function buildStructureStringRecursive(entries, session, prefix, level, rootUriString, isExcluded) {
    let structure = '';
    const sortedEntries = [...entries].sort((a, b) => {
        if (a.isDirectory !== b.isDirectory)
            return a.isDirectory ? -1 : 1;
        const nameA = path.basename(vscode.Uri.parse(a.uriString).path);
        const nameB = path.basename(vscode.Uri.parse(b.uriString).path);
        return nameA.localeCompare(nameB);
    });
    sortedEntries.forEach((entry, index) => {
        const isLast = index === sortedEntries.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        const uri = vscode.Uri.parse(entry.uriString);
        const name = path.basename(uri.path);
        let relativePath = '';
        try {
            if (rootUriString) {
                const rootUri = vscode.Uri.parse(rootUriString);
                if (uri.scheme === 'file' && rootUri.scheme === 'file') {
                    relativePath = path.relative(rootUri.fsPath, uri.fsPath).replace(/\\/g, '/');
                }
                else {
                    const rootPathSegments = rootUri.path.split('/').filter(Boolean);
                    const entryPathSegments = uri.path.split('/').filter(Boolean);
                    let commonLength = 0;
                    while (commonLength < rootPathSegments.length && commonLength < entryPathSegments.length && rootPathSegments[commonLength] === entryPathSegments[commonLength]) {
                        commonLength++;
                    }
                    relativePath = entryPathSegments.slice(commonLength).join('/');
                }
            }
            else {
                relativePath = getDisplayPath(uri.fsPath || uri.path, false);
            }
            if (relativePath === '' && entry.uriString !== rootUriString) {
                relativePath = name;
            }
        }
        catch (e) {
            // console.warn(`[CodeLensAI:CopyStructure] Error calculating relative path for ${entry.uriString} relative to ${rootUriString}: ${e}`);
            relativePath = name;
        }
        if (isExcluded(relativePath)) {
            return;
        }
        structure += `${prefix}${connector}${name}\n`;
        if (entry.isDirectory) {
            const children = session.storage.files.filter(f => f.parentUriString === entry.uriString);
            const newPrefix = prefix + (isLast ? '    ' : '│   ');
            structure += buildStructureStringRecursive(children, session, newPrefix, level + 1, rootUriString, isExcluded);
        }
    });
    return structure;
}
//# sourceMappingURL=utils.js.map