import * as vscode from 'vscode';
import * as path from 'path';
import { FileEntry } from './session';
import { getDisplayUri } from './utils';
import { API as GitAPI, Repository as GitRepository, Change } from './api/git'; // Assuming GitExtension is not directly used here

// --- Git Diff Common Logic ---

/** Common handler for generating/copying Git diffs. */
export async function generateDiffCommon(
    entriesToProcess: readonly FileEntry[], // Should be pre-filtered for file:// scheme
    scopeName: string,
    showInfoMessage: (message: string) => Thenable<unknown>,
    copyToClipboard: boolean,
    gitAPI: GitAPI | undefined
): Promise<void> {
    if (!gitAPI) { vscode.window.showErrorMessage("CodeLens AI: Git integration is not available."); return; }
    if (entriesToProcess.length === 0) {
        showInfoMessage(`No file system items found in ${scopeName} to perform Git Diff on.`);
        return;
    }

    try {
        const { diffOutput, skippedFiles, errorMessages } = await calculateDiffForEntries(entriesToProcess, scopeName, gitAPI);

        let finalMsg = '';
        let outputToShow = diffOutput;

        if (errorMessages.length > 0) {
            const baseMsg = copyToClipboard ? `Diff for ${scopeName}` : `Generated diff for ${scopeName}`;
            finalMsg = `${baseMsg} with errors.`;
            outputToShow = `${diffOutput}\n\n--- ERRORS ENCOUNTERED ---\n${errorMessages.join('\n')}`.trim();
            if (copyToClipboard) {
                await vscode.env.clipboard.writeText(outputToShow);
            } else {
                const doc = await vscode.workspace.openTextDocument({ content: outputToShow, language: 'diff' });
                await vscode.window.showTextDocument(doc, { preview: false });
            }
        } else if (diffOutput.trim() === '') {
            finalMsg = `No changes found compared to HEAD for ${scopeName}.`;
        } else {
            const baseMsg = copyToClipboard ? `Diff (vs HEAD) for ${scopeName}` : `Generated diff (vs HEAD) for ${scopeName}`;
            finalMsg = copyToClipboard ? `${baseMsg} copied.` : `${baseMsg}.`;
            if (copyToClipboard) {
                await vscode.env.clipboard.writeText(diffOutput);
            } else {
                const doc = await vscode.workspace.openTextDocument({ content: diffOutput, language: 'diff' });
                await vscode.window.showTextDocument(doc, { preview: false });
            }
        }

        if (skippedFiles.length > 0) {
            const reason = skippedFiles.every(s => s.includes('(untracked')) ? ' (untracked)' : ' (untracked or not in a repo)';
            if (finalMsg) {
                finalMsg += ` Skipped ${skippedFiles.length} item(s)${reason}.`;
            } else {
                finalMsg = `Skipped ${skippedFiles.length} item(s)${reason}. No diff generated.`;
            }
        }

        if (finalMsg) {
            showInfoMessage(finalMsg);
        } else if (skippedFiles.length === 0 && errorMessages.length === 0 && diffOutput.trim() === '' && entriesToProcess.length > 0) {
            // Fallback message if absolutely nothing happened
            showInfoMessage(`No diff generated or items skipped for ${scopeName}.`);
        }

    } catch (error: any) {
        console.error(`[CodeLensAI:GenerateDiffCommon] Unexpected Error for scope "${scopeName}":`, error);
        vscode.window.showErrorMessage(`CodeLens AI: Failed to generate/copy diff for ${scopeName}: ${error.message}`);
    }
}

/** Calculates the scoped Git diff (changes vs HEAD) for a given list of FileEntry items. */
export async function calculateDiffForEntries(
    entries: readonly FileEntry[], // Assumes entries are file:// scheme
    scopeName: string,
    gitAPI: GitAPI
): Promise<{ diffOutput: string; skippedFiles: string[]; diffedFilesCount: number; errorMessages: string[] }> {
    if (!gitAPI) throw new Error("CodeLens AI: Git API is not available.");

    const filesByRepo = new Map<string, { repo: GitRepository; entries: FileEntry[] }>();
    const skippedFiles: string[] = [];
    const errorMessages: string[] = [];
    let potentialDiffFilesCount = 0;

    console.log(`[CodeLensAI:DiffCalc] Processing ${entries.length} file system items for scope ${scopeName}`);
    for (const entry of entries) {
        let uri: vscode.Uri;
        try {
            uri = vscode.Uri.parse(entry.uriString, true);
            if (uri.scheme !== 'file') {
                skippedFiles.push(`${getDisplayUri(entry.uriString)} (non-file)`); continue;
            }
        } catch (e) {
            console.warn(`[CodeLensAI:DiffCalc][${scopeName}] Skipping invalid URI: ${entry.uriString}`, e);
            skippedFiles.push(`${entry.uriString} (invalid)`); continue;
        }

        const repo = gitAPI.getRepository(uri);
        if (!repo) {
            if (!entry.isDirectory) {
                skippedFiles.push(`${getDisplayUri(entry.uriString)} (untracked or no repo)`);
            } else {
                // console.log(`[CodeLensAI:DiffCalc][${scopeName}] Directory not in repo or untracked: ${getDisplayUri(entry.uriString)}`);
            }
            if (!repo && !entry.isDirectory) continue;
            if (!repo && entry.isDirectory) {
                // console.log(`[CodeLensAI:DiffCalc][${scopeName}] Directory ${getDisplayUri(entry.uriString)} not in repo, children will be checked individually.`);
            }
        }

        if (repo) {
            potentialDiffFilesCount++;
            const repoRootStr = repo.rootUri.toString();
            if (!filesByRepo.has(repoRootStr)) {
                filesByRepo.set(repoRootStr, { repo, entries: [] });
            }
            filesByRepo.get(repoRootStr)!.entries.push(entry);
        } else if (entry.isDirectory) {
            potentialDiffFilesCount++;
        }
    }

    if (potentialDiffFilesCount === 0 && entries.length > 0) {
        console.log(`[CodeLensAI:DiffCalc][${scopeName}] No Git-tracked file system items found.`);
    }

    let combinedDiff = '';
    let actualDiffedFilesCount = 0;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `CodeLens AI: Calculating Git diff (vs HEAD) for ${scopeName}...`,
        cancellable: false
    }, async (progress) => {
        let repoIndex = 0;
        const totalRepos = filesByRepo.size;

        for (const [repoRoot, data] of filesByRepo.entries()) {
            repoIndex++;
            const repoDisplayName = path.basename(data.repo.rootUri.fsPath);
            progress.report({ message: `Processing repo ${repoIndex}/${totalRepos}: ${repoDisplayName}`, increment: (1 / totalRepos) * 100 });

            const pathsToDiff = new Set<string>();
            let diffRepoRoot = false;

            for (const entry of data.entries) {
                const entryUri = vscode.Uri.parse(entry.uriString);
                const relativePath = path.relative(data.repo.rootUri.fsPath, entryUri.fsPath).replace(/\\/g, '/');

                if (entry.isDirectory && (relativePath === '.' || relativePath === '')) {
                    diffRepoRoot = true;
                    // console.log(`[CodeLensAI:DiffCalc][${scopeName}] Marked repo root '.' for full diff in ${repoDisplayName}`);
                    break;
                } else if (entry.isDirectory) {
                    pathsToDiff.add(relativePath);
                    // console.log(`[CodeLensAI:DiffCalc][${scopeName}] Added directory path for diff: ${relativePath} in ${repoDisplayName}`);
                } else {
                    pathsToDiff.add(relativePath);
                    // console.log(`[CodeLensAI:DiffCalc][${scopeName}] Added file path for diff: ${relativePath} in ${repoDisplayName}`);
                }
            }

            let repoDiffContent = '';
            let processedRepoHeader = false;

            try {
                let finalPaths = diffRepoRoot ? ['.'] : Array.from(pathsToDiff).filter(p => p !== '.');
                if (finalPaths.length === 0) {
                    // console.log(`[CodeLensAI:DiffCalc][${scopeName}] No specific paths determined for diffing in repo ${repoDisplayName}. Skipping.`);
                    continue;
                }

                // console.log(`[CodeLensAI:DiffCalc][${scopeName}] Diffing paths [${finalPaths.join(', ')}] against HEAD for repo ${repoDisplayName}`);

                if (diffRepoRoot) {
                    // console.log(`[CodeLensAI:DiffCalc][${scopeName}] Getting changed files list vs HEAD for repo root ${repoDisplayName}`);
                    const changes: Change[] = await data.repo.diffWithHEAD();

                    if (changes.length === 0) {
                        // console.log(`[CodeLensAI:DiffCalc][${scopeName}] No working tree changes found vs HEAD for repo root ${repoDisplayName}`);
                    } else {
                        // console.log(`[CodeLensAI:DiffCalc][${scopeName}] Found ${changes.length} changes. Getting individual diffs...`);
                        let combinedRepoDiff = '';
                        for (const change of changes) {
                            try {
                                const diffUri = change.renameUri || change.uri;
                                const relativePathForDiff = path.relative(data.repo.rootUri.fsPath, diffUri.fsPath).replace(/\\/g, '/');
                                const pathDiff: string = await data.repo.diffWithHEAD(relativePathForDiff);

                                if (pathDiff && pathDiff.trim() !== '') {
                                    if (!pathDiff.startsWith('diff --git')) {
                                        // console.warn(`[CodeLensAI:DiffCalc][${scopeName}] Diff output for ${relativePathForDiff} missing 'diff --git' header. Adding manually.`);
                                        combinedRepoDiff += `diff --git a/${relativePathForDiff} b/${relativePathForDiff}\n${pathDiff}\n\n`;
                                    } else {
                                        combinedRepoDiff += pathDiff + '\n\n';
                                    }
                                    actualDiffedFilesCount++;
                                }
                            } catch (changeError: any) {
                                const uriStr = (change.renameUri || change.uri).toString();
                                console.error(`[CodeLensAI:DiffCalc][${scopeName}] Error getting diff for changed file ${getDisplayUri(uriStr)} in repo ${repoDisplayName}:`, changeError);
                                errorMessages.push(`--- Error diffing changed file: ${getDisplayUri(uriStr)} ---\n${changeError.message}\n${changeError.stderr || ''}\n`);
                            }
                        }
                        repoDiffContent = combinedRepoDiff.trim();
                    }
                } else {
                    let pathDiffs = '';
                    for (const relativePathToDiff of finalPaths) {
                        try {
                            const pathDiff = await data.repo.diffWithHEAD(relativePathToDiff);
                            if (pathDiff && pathDiff.trim() !== '') {
                                if (!pathDiff.startsWith('diff --git')) {
                                    // console.warn(`[CodeLensAI:DiffCalc][${scopeName}] Diff output for ${relativePathToDiff} missing 'diff --git' header. Adding manually.`);
                                    pathDiffs += `diff --git a/${relativePathToDiff} b/${relativePathToDiff}\n${pathDiff}\n`;
                                } else {
                                    pathDiffs += pathDiff + '\n';
                                }
                                actualDiffedFilesCount++;
                            }
                        } catch (pathError: any) {
                            console.error(`[CodeLensAI:DiffCalc][${scopeName}] Error diffing path ${relativePathToDiff} in repo ${repoDisplayName}:`, pathError);
                            errorMessages.push(`--- Error diffing path: ${relativePathToDiff} ---\n${pathError.message}\n${pathError.stderr || ''}\n`);
                        }
                    }
                    repoDiffContent = pathDiffs.trim();
                }

                if (repoDiffContent && repoDiffContent.trim() !== '') {
                    if (!processedRepoHeader && (filesByRepo.size > 1 || scopeName.startsWith('session'))) {
                        combinedDiff += `--- Diff for repository: ${repoDisplayName} ---\n\n`;
                        processedRepoHeader = true;
                    }
                    combinedDiff += repoDiffContent + '\n\n';
                }

            } catch (error: any) {
                console.error(`[CodeLensAI:DiffCalc][${scopeName}] Error running git diff for repo ${repoDisplayName}:`, error);
                if (!processedRepoHeader && (filesByRepo.size > 1 || scopeName.startsWith('session'))) {
                    combinedDiff += `--- Diff for repository: ${repoDisplayName} ---\n\n`;
                    // processedRepoHeader = true; // Not strictly needed here as we're in error block
                }
                let errMsg = `--- Error diffing in repository: ${repoDisplayName} ---\nError: ${error.message || 'Unknown Git error'}\n`;
                if (error.stderr) errMsg += `Stderr:\n${error.stderr}\n`;
                if (error.gitErrorCode) errMsg += `GitErrorCode: ${error.gitErrorCode}\n`;
                errMsg += `\n`;
                errorMessages.push(errMsg);
            }
        }
    });

    console.log(`[CodeLensAI:DiffCalc][${scopeName}] Finished. Diff length: ${combinedDiff.length}, Skipped: ${skippedFiles.length}, Diffed Files Count: ${actualDiffedFilesCount}, Errors: ${errorMessages.length}`);
    return { diffOutput: combinedDiff.trim(), skippedFiles, diffedFilesCount: actualDiffedFilesCount, errorMessages };
}