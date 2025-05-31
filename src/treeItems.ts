import * as vscode from 'vscode';
import * as path from 'path';
import { Session, FileEntry } from './session';
import { getDisplayUri } from './utils';

export type IntegratorTreeItem = SessionItem | ResourceItem;

export class SessionItem extends vscode.TreeItem {
    constructor(
        public readonly session: Session,
        collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Collapsed
    ) {
        super(session.name, collapsibleState);
        this.id = session.id;

        const hasUndoableFiles = session.storage.hasLastRemovedFiles();
        this.contextValue = hasUndoableFiles ? 'sessionWithUndo' : 'session';

        this.iconPath = new vscode.ThemeIcon('folder-library');
        this.tooltip = `Session: ${session.name}`;
        this.description = `(${session.storage.files.length} items)`;
    }
}

export class ResourceItem extends vscode.TreeItem {
    constructor(
        public readonly entry: FileEntry,
        collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        const uri = vscode.Uri.parse(entry.uriString);
        let label = '';
        const uriPath = uri.path;
        const bangIndex = uri.toString().lastIndexOf('!/');

        if (bangIndex !== -1) {
            const fullUriStr = uri.toString();
            const internalPath = fullUriStr.substring(bangIndex + 1);
            label = path.basename(internalPath.startsWith('/') ? internalPath.substring(1) : internalPath);
        } else {
            label = path.basename(uriPath);
        }

        if (!label && uri.scheme !== 'file') {
            label = uri.toString().substring(uri.scheme.length + 1);
            if (label.startsWith('//')) label = label.substring(2);
        }
        if (!label) label = entry.uriString;

        super(label, collapsibleState);

        this.id = `${entry.sessionId}::${entry.uriString}`;
        this.resourceUri = uri;

        if (!entry.isDirectory) {
            this.command = { command: 'vscode.open', title: "Open Resource", arguments: [uri] };
            this.collapsibleState = vscode.TreeItemCollapsibleState.None;
        }

        this.tooltip = `${entry.isDirectory ? 'Directory (Git Diff applies to tracked files within)' : 'Resource (Git Diff applies if tracked)'}:\n${getDisplayUri(entry.uriString, 'tooltip')}`;
        this.description = getDisplayUri(entry.uriString, 'treeDescription');

        this.contextValue = entry.isDirectory ? 'resourceDirectory' : 'resourceFile';
        this.iconPath = entry.isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    }

    get sessionId(): string { return this.entry.sessionId; }
    get uriString(): string { return this.entry.uriString; }
    get isDirectory(): boolean { return this.entry.isDirectory; }
}