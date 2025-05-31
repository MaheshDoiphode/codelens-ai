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
// Utility Functions
/**
 * Checks if a file system path matches **DRAG & DROP** exclusion patterns.
 * Uses `fileintegrator.exclude` setting.
 */
function isPathExcluded(filePath) {
    const config = vscode.workspace.getConfiguration('fileintegrator');
    const excludePatterns = config.get('exclude'); // Read the 'exclude' setting
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
            if ((0, minimatch_1.minimatch)(normalizedFilePath, normalizedPattern, options)) {
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
                        if ((0, minimatch_1.minimatch)(relativePath, normalizedPattern, options)) {
                            // console.log(`[Exclude Match] Relative Path: ${relativePath} (in ${folder.name}) matched pattern: ${normalizedPattern}`);
                            return true;
                        }
                    }
                }
            }
            // 3. Match against basename if the pattern doesn't contain slashes (e.g., "node_modules" should match "/path/to/node_modules")
            // This helps match common directory names without requiring '**/'' prefix in the pattern.
            if (!normalizedPattern.includes('/')) {
                if ((0, minimatch_1.minimatch)(path.basename(normalizedFilePath), normalizedPattern, options)) {
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
function isPathExcludedFromTree(relativePath, excludePatterns) {
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
            if ((0, minimatch_1.minimatch)(normalizedRelativePath, normalizedPattern, options)) {
                // console.log(`[ExcludeTree Match] Relative Path: ${normalizedRelativePath} matched pattern: ${normalizedPattern}`);
                return true;
            }
        }
    }
    return false;
}
// Placeholder for sessionManager - will be passed in via argument
// let sessionManager: SessionManager; 
/** Prompts user to select a session via Quick Pick. Returns undefined if cancelled. */
async function selectSession(placeHolder, sessionManager) {
    const sessions = sessionManager.getAllSessions(); // Already sorted by name
    if (sessions.length === 0) {
        vscode.window.showErrorMessage("No sessions available.");
        return undefined;
    }
    if (sessions.length === 1)
        return sessions[0]; // Auto-select if only one
    // Create QuickPick items
    const picks = sessions.map(s => ({ label: s.name, description: `(${s.storage.files.length} items)`, session: s }));
    const selection = await vscode.window.showQuickPick(picks, { placeHolder, canPickMany: false });
    return selection?.session; // Return the selected Session object or undefined
}
/**
 * Generates aggregated Markdown content for a specific list of FileEntry items.
 * Used by session generation and directory generation.
 */
async function generateMarkdownContentForEntries(entries, headerComment) {
    let content = headerComment ? `<!-- ${headerComment} -->\n\n` : '';
    const resourceEntries = entries.filter(f => !f.isDirectory);
    if (resourceEntries.length === 0) {
        return headerComment
            ? `<!-- ${headerComment} -->\n<!-- No file/resource content found for the given entries. -->\n`
            : `<!-- No file/resource content found for the given entries. -->\n`;
    }
    console.log(`[MarkdownGenEntries] Generating content for ${resourceEntries.length} resources.`);
    for (const entry of resourceEntries) {
        let resourceContent = entry.content; // Use cached content if available
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
            }
            catch (error) {
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
        content += `### ${displayUri}\n\`\`\`${lang}\n${resourceContent ?? '--- Content Unavailable ---\n'}\`\`\`\n\n`;
    }
    return content.trimEnd(); // Remove trailing whitespace/newlines
}
/** Generates aggregated Markdown content for a *whole session*, respecting order. */
async function generateMarkdownContent(session) {
    return generateMarkdownContentForEntries(session.storage.files, `Content for Session: ${session.name}`);
}
/** Ensures the code block document for a session is visible and up-to-date. */
async function showCodeBlockDocument(session) {
    const content = await generateMarkdownContent(session); // Generate fresh content
    // If a document is already associated and open, update it
    if (session.associatedDocument && !session.associatedDocument.isClosed) {
        const doc = session.associatedDocument;
        try {
            const edit = new vscode.WorkspaceEdit();
            // Replace the entire document content
            edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), content);
            const success = await vscode.workspace.applyEdit(edit);
            if (!success)
                throw new Error("ApplyEdit failed to update document");
            console.log(`[ShowDoc] Updated associated document for session ${session.id}`);
            return doc; // Return the updated document
        }
        catch (e) {
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
async function createNewAssociatedDocument(session, content) {
    try {
        console.log(`[ShowDoc] Creating new associated document for session ${session.id}`);
        // Create an untitled document with the generated content
        const doc = await vscode.workspace.openTextDocument({ content: content, language: 'markdown' });
        session.setAssociatedDocument(doc); // Associate the new document with the session
        return doc;
    }
    catch (e) {
        console.error(`[ShowDoc] Failed to create associated document:`, e);
        vscode.window.showErrorMessage(`Failed to create associated document: ${e.message}`);
        session.closeAssociatedDocument(false); // Ensure no dangling association on failure
        return undefined;
    }
}
/** Updates the associated document content *if* it exists and is open, without showing it. */
async function updateCodeBlockDocument(session) {
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
            }
            else {
                console.log(`[UpdateDoc] Successfully updated associated document.`);
            }
        }
        catch (err) {
            console.error(`[UpdateDoc] Error applying edit to ${doc.uri}:`, err);
            session.closeAssociatedDocument(false); // Detach on error
            vscode.window.showErrorMessage("Error updating the associated code block document."); // Inform user
        }
    }
    else {
        // console.log(`[UpdateDoc] No open associated document to update for session ${session.id}.`);
    }
}
/** Generates a display-friendly string for a URI */
function getDisplayUri(uriString, type = 'markdownHeader') {
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
            }
            catch {
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
                const shortInternal = displayInternalPath.length > 25 ? '/.../' + displayInternalPath.slice(-22) : displayInternalPath;
                return `${prefix}${shortArchive}!/${shortInternal}`;
            }
            else {
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
            if (displayPath.startsWith('/'))
                displayPath = displayPath.substring(1);
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
    }
    catch (e) {
        console.warn(`[getDisplayUri] Error parsing/formatting URI string: ${uriString}`, e);
        // Fallback: return the original string, shortened if needed for description
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
    }
    else {
        // Fallback for files outside any workspace folder: Show trailing path parts
        const sep = path.sep;
        const pathParts = filePath.split(sep).filter(Boolean); // Split and remove empty parts
        const partsCount = pathParts.length;
        if (short && partsCount > 3) { // Short mode: show .../folder/file
            return `...${sep}${pathParts.slice(-2).join(sep)}`;
        }
        else if (!short && partsCount > 5) { // Long mode (tooltip/header): show more context
            return `...${sep}${pathParts.slice(-3).join(sep)}`;
        }
        else {
            return filePath; // Return full path if it's already short
        }
    }
}
/** Gets a FileEntry and all its descendants within a session's storage. */
function getDescendantEntries(session, directoryUriString) {
    const startingEntry = session.storage.findEntry(directoryUriString);
    if (!startingEntry)
        return []; // Starting directory not found in session
    // If the starting point itself is not a directory, just return it
    if (!startingEntry.isDirectory) {
        console.warn(`[getDescendantEntries] Provided URI is not a directory: ${directoryUriString}`);
        return [startingEntry];
    }
    const descendants = [startingEntry]; // Include the starting directory itself
    const queue = [directoryUriString]; // URIs to process
    const processedUris = new Set([directoryUriString]); // Avoid cycles/duplicates
    while (queue.length > 0) {
        const currentParentUri = queue.shift();
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
function buildStructureStringRecursive(entries, session, prefix, level, rootUriString, // URI of the root directory being copied (or undefined if session root)
isExcluded // Function to check exclusion
) {
    let structure = '';
    const sortedEntries = [...entries].sort((a, b) => {
        // Sort directories before files, then alphabetically
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
        const name = path.basename(uri.path); // Get simple name
        // Calculate relative path for exclusion check
        let relativePath = '';
        try {
            if (rootUriString) {
                const rootUri = vscode.Uri.parse(rootUriString);
                // For file URIs, calculate relative path directly from rootUri.fsPath
                if (uri.scheme === 'file' && rootUri.scheme === 'file') {
                    relativePath = path.relative(rootUri.fsPath, uri.fsPath).replace(/\\/g, '/');
                }
                else {
                    // For non-file URIs, try to determine a relative path based on path segments
                    const rootPathSegments = rootUri.path.split('/').filter(Boolean);
                    const entryPathSegments = uri.path.split('/').filter(Boolean);
                    let commonLength = 0;
                    while (commonLength < rootPathSegments.length && commonLength < entryPathSegments.length && rootPathSegments[commonLength] === entryPathSegments[commonLength]) {
                        commonLength++;
                    }
                    // The relative path is the part of entryPathSegments after the common prefix
                    relativePath = entryPathSegments.slice(commonLength).join('/');
                }
            }
            else {
                // If no rootUriString (copying from session root), use the display path (which prefers relative to workspace)
                relativePath = getDisplayPath(uri.fsPath || uri.path, false);
            }
            // Ensure relativePath is not empty for non-root items, fallback to name
            if (relativePath === '' && entry.uriString !== rootUriString) {
                relativePath = name; // If it's a root entry but relative path is empty, use its name
            }
        }
        catch (e) {
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
//# sourceMappingURL=utils.js.map