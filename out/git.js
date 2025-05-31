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
exports.generateDiffCommon = generateDiffCommon;
exports.calculateDiffForEntries = calculateDiffForEntries;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const utils_1 = require("./utils");
// --- Git Diff Common Logic ---
/** Common handler for generating/copying Git diffs. */
async function generateDiffCommon(entriesToProcess, // Should be pre-filtered for file:// scheme
scopeName, showInfoMessage, // Use Thenable<unknown> for showInformationMessage etc.
copyToClipboard, gitAPI) {
    if (!gitAPI) {
        vscode.window.showErrorMessage("Git integration is not available.");
        return;
    }
    if (entriesToProcess.length === 0) {
        showInfoMessage(`No file system items found in ${scopeName} to perform Git Diff on.`);
        return;
    }
    try {
        // Calculate the diff
        const { diffOutput, skippedFiles, diffedFilesCount, errorMessages } = await calculateDiffForEntries(entriesToProcess, scopeName, gitAPI);
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
            }
            else {
                const doc = await vscode.workspace.openTextDocument({ content: outputToShow, language: 'diff' });
                await vscode.window.showTextDocument(doc, { preview: false });
            }
        }
        else if (diffOutput.trim() === '') {
            // === 2. Handle No Changes (if no errors) ===
            // This covers the case where files were processed (diffedFilesCount might be >0 if multiple unchanged files were processed, or 0 if one unchanged file)
            // but resulted in no actual diff text.
            finalMsg = `No changes found compared to HEAD for ${scopeName}.`;
            // No document to show or copy in this case.
        }
        else {
            // === 3. Handle Success (Diff Found) ===
            const baseMsg = copyToClipboard ? `Diff (vs HEAD) for ${scopeName}` : `Generated diff (vs HEAD) for ${scopeName}`;
            finalMsg = copyToClipboard ? `${baseMsg} copied.` : `${baseMsg}.`;
            if (copyToClipboard) {
                await vscode.env.clipboard.writeText(diffOutput); // Use original diffOutput
            }
            else {
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
            }
            else {
                // This case should be rare (e.g., only skipped files provided), but handle it.
                finalMsg = `Skipped ${skippedFiles.length} item(s)${reason}. No diff generated.`;
            }
        }
        // === 5. Show the Final Message ===
        // Avoid showing trivial "no changes" or "no trackable files" messages if there were errors reported.
        // Only show message if it's not empty (it might be empty if only skipped files were processed and no diff/errors occurred)
        if (finalMsg) {
            showInfoMessage(finalMsg);
        }
        else if (skippedFiles.length === 0 && errorMessages.length === 0 && diffOutput.trim() === '' && entriesToProcess.length > 0) {
            // Fallback message if absolutely nothing happened (e.g., empty directory provided?)
            // This shouldn't be reached with the current logic, but as a safe fallback:
            showInfoMessage(`No diff generated or items skipped for ${scopeName}.`);
        }
    }
    catch (error) {
        // Catch errors from calculateDiffForEntries itself or other unexpected issues
        console.error(`[GenerateDiffCommon] Unexpected Error for scope "${scopeName}":`, error);
        vscode.window.showErrorMessage(`Failed to generate/copy diff for ${scopeName}: ${error.message}`);
    }
}
/** Calculates the scoped Git diff (changes vs HEAD) for a given list of FileEntry items. */
async function calculateDiffForEntries(entries, // Assumes entries are file:// scheme
scopeName, gitAPI // Now required
) {
    if (!gitAPI)
        throw new Error("Git API is not available."); // Should be checked by caller
    // Group entries by Git repository
    const filesByRepo = new Map();
    const skippedFiles = []; // URIs of files skipped
    const errorMessages = []; // Store specific error messages
    let potentialDiffFilesCount = 0; // Count files/dirs that *could* be diffed
    console.log(`[DiffCalc] Processing ${entries.length} file system items for scope ${scopeName}`);
    for (const entry of entries) {
        let uri;
        try {
            uri = vscode.Uri.parse(entry.uriString, true);
            if (uri.scheme !== 'file') {
                // Should not happen if pre-filtered, but check anyway
                skippedFiles.push(`${(0, utils_1.getDisplayUri)(entry.uriString)} (non-file)`);
                continue;
            }
        }
        catch (e) {
            console.warn(`[DiffCalc][${scopeName}] Skipping invalid URI: ${entry.uriString}`, e);
            skippedFiles.push(`${entry.uriString} (invalid)`);
            continue;
        }
        const repo = gitAPI.getRepository(uri);
        if (!repo) {
            // Only add to skipped if it's actually a file (directories often aren't tracked directly)
            if (!entry.isDirectory) {
                skippedFiles.push(`${(0, utils_1.getDisplayUri)(entry.uriString)} (untracked or no repo)`);
            }
            else {
                console.log(`[DiffCalc][${scopeName}] Directory not in repo or untracked: ${(0, utils_1.getDisplayUri)(entry.uriString)}`);
                // We still need the directory entry in filesByRepo if its children are tracked
            }
            // Continue processing children even if parent dir isn't tracked/in repo
            // But we need *a* repo context if possible. Find repo for children?
            // Simpler: If a file's repo isn't found, skip it. If a dir's repo isn't found, process its children individually later.
            if (!repo && !entry.isDirectory)
                continue; // Skip untracked files
            if (!repo && entry.isDirectory) {
                // Still need to check children, but maybe associate with a workspace repo? Risky.
                // Let's rely on children finding their own repo.
                console.log(`[DiffCalc][${scopeName}] Directory ${(0, utils_1.getDisplayUri)(entry.uriString)} not in repo, children will be checked individually.`);
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
            filesByRepo.get(repoRootStr).entries.push(entry);
        }
        else if (entry.isDirectory) {
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
            const pathsToDiff = new Set();
            let diffRepoRoot = false;
            for (const entry of data.entries) {
                const entryUri = vscode.Uri.parse(entry.uriString);
                const relativePath = path.relative(data.repo.rootUri.fsPath, entryUri.fsPath).replace(/\\/g, '/');
                if (entry.isDirectory && (relativePath === '.' || relativePath === '')) {
                    // If a directory entry corresponds to the repo root, diff the whole repo
                    diffRepoRoot = true;
                    console.log(`[DiffCalc][${scopeName}] Marked repo root '.' for full diff in ${repoDisplayName}`);
                    break; // No need to check other entries for this repo
                }
                else if (entry.isDirectory) {
                    // If it's a subdirectory, add it - git diff should handle recursively
                    pathsToDiff.add(relativePath);
                    console.log(`[DiffCalc][${scopeName}] Added directory path for diff: ${relativePath} in ${repoDisplayName}`);
                }
                else {
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
                // Correction: API expects single path or undefined. We need to call it per path or get all changes if diffRepoRoot.
                if (diffRepoRoot) {
                    // Get all changes (list of files) if root is requested
                    console.log(`[DiffCalc][${scopeName}] Getting changed files list vs HEAD for repo root ${repoDisplayName}`);
                    // diffWithHEAD() without args returns the list of changes (Change[])
                    const changes = await data.repo.diffWithHEAD(); // <-- Correct type: Change[]
                    if (changes.length === 0) {
                        console.log(`[DiffCalc][${scopeName}] No working tree changes found vs HEAD for repo root ${repoDisplayName}`);
                    }
                    else {
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
                                const pathDiff = await data.repo.diffWithHEAD(relativePath);
                                if (pathDiff && pathDiff.trim() !== '') {
                                    // diffWithHEAD(path) should return the full diff including headers
                                    // We might not need to reconstruct the header, but check just in case
                                    if (!pathDiff.startsWith('diff --git')) {
                                        // Log a warning if the expected header is missing
                                        console.warn(`[DiffCalc][${scopeName}] Diff output for ${relativePath} missing expected 'diff --git' header. Adding manually.`);
                                        combinedRepoDiff += `diff --git a/${relativePath} b/${relativePath}\n${pathDiff}\n\n`;
                                    }
                                    else {
                                        combinedRepoDiff += pathDiff + '\n\n'; // Add separator newline
                                    }
                                    actualDiffedFilesCount++; // Increment count for files with actual diff output
                                }
                                // Even if pathDiff is empty, the file was listed in changes, so potentially count it?
                                // Let's only count if there's actual diff output for clarity.
                            }
                            catch (changeError) {
                                // Handle errors getting diff for a specific changed file
                                const uriStr = (change.renameUri || change.uri).toString();
                                console.error(`[DiffCalc][${scopeName}] Error getting diff for changed file ${(0, utils_1.getDisplayUri)(uriStr)} in repo ${repoDisplayName}:`, changeError);
                                // Add error message to the list to be reported later
                                errorMessages.push(`--- Error diffing changed file: ${(0, utils_1.getDisplayUri)(uriStr)} ---\n${changeError.message}\n${changeError.stderr || ''}\n`);
                            }
                        }
                        // Assign the combined diff text from all successfully processed changes
                        repoDiffContent = combinedRepoDiff.trim();
                    }
                }
                else {
                    // Diff specific paths individually (this logic remains the same as the previous fix)
                    let pathDiffs = '';
                    for (const relativePath of finalPaths) {
                        try {
                            const pathDiff = await data.repo.diffWithHEAD(relativePath);
                            if (pathDiff && pathDiff.trim() !== '') {
                                if (!pathDiff.startsWith('diff --git')) {
                                    console.warn(`[DiffCalc][${scopeName}] Diff output for ${relativePath} missing expected 'diff --git' header. Adding manually.`);
                                    pathDiffs += `diff --git a/${relativePath} b/${relativePath}\n${pathDiff}\n`;
                                }
                                else {
                                    pathDiffs += pathDiff + '\n'; // Add newline separator
                                }
                                actualDiffedFilesCount++;
                            }
                        }
                        catch (pathError) {
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
            }
            catch (error) {
                console.error(`[DiffCalc][${scopeName}] Error running git diff for repo ${repoDisplayName}:`, error);
                if (!processedRepoHeader && (filesByRepo.size > 1 || scopeName.startsWith('session'))) {
                    combinedDiff += `--- Diff for repository: ${repoDisplayName} ---\n\n`;
                    processedRepoHeader = true;
                }
                let errMsg = `--- Error diffing in repository: ${repoDisplayName} ---\nError: ${error.message || 'Unknown Git error'}\n`;
                if (error.stderr)
                    errMsg += `Stderr:\n${error.stderr}\n`;
                if (error.gitErrorCode)
                    errMsg += `GitErrorCode: ${error.gitErrorCode}\n`;
                errMsg += `\n`;
                errorMessages.push(errMsg); // Add error message to list
                // Don't add to combinedDiff here, handled by caller
            }
        } // End repo loop
    }); // End withProgress
    console.log(`[DiffCalc][${scopeName}] Finished. Diff length: ${combinedDiff.length}, Skipped: ${skippedFiles.length}, Diffed Files Count: ${actualDiffedFilesCount}, Errors: ${errorMessages.length}`);
    return { diffOutput: combinedDiff.trim(), skippedFiles, diffedFilesCount: actualDiffedFilesCount, errorMessages };
}
//# sourceMappingURL=git.js.map