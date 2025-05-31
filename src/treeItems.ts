import * as vscode from 'vscode';
import * as path from 'path';
import { Session, FileEntry } from './session';
import { getDisplayUri } from './utils';

// --- Tree View Items ---
export type IntegratorTreeItem = SessionItem | ResourceItem;

export class SessionItem extends vscode.TreeItem {
    constructor(
        public readonly session: Session,
        collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Collapsed
    ) {
        super(session.name, collapsibleState);
        this.id = session.id; // Use session ID as the tree item ID
        this.contextValue = 'session'; // Used for menu filtering
        this.iconPath = new vscode.ThemeIcon('folder-library'); // Or 'briefcase' or 'database'
        this.tooltip = `Session: ${session.name}`;
        // Show item count in description
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
        const bangIndex = uri.toString().lastIndexOf('!/'); // Check for archive paths like jar:file:/.../lib.jar!/path/to/Class.class

        // Handle archive paths for label
        if (bangIndex !== -1) {
            const fullUriStr = uri.toString();
            // Extract path inside the archive
            const internalPath = fullUriStr.substring(bangIndex + 1);
            // Get the base name from the internal path
            label = path.basename(internalPath.startsWith('/') ? internalPath.substring(1) : internalPath);
        } else {
            // Standard file path label
            label = path.basename(uriPath);
        }

        // Fallback for non-file URIs or if basename extraction failed
        if (!label && uri.scheme !== 'file') {
            label = uri.toString().substring(uri.scheme.length + 1); // e.g., untitled:Untitled-1 -> Untitled-1
            if (label.startsWith('//')) label = label.substring(2); // Handle authorities like git://
        }
        if (!label) label = entry.uriString; // Absolute fallback

        super(label, collapsibleState); // Use the extracted label

        // Set unique ID combining session and URI
        this.id = `${entry.sessionId}::${entry.uriString}`;
        this.resourceUri = uri; // Make the URI available

        // Command to open non-directory items on click
        if (!entry.isDirectory) {
            this.command = { command: 'vscode.open', title: "Open Resource", arguments: [uri] };
            this.collapsibleState = vscode.TreeItemCollapsibleState.None; // Files are not expandable
        }

        // Set tooltip and description using helper function
        this.tooltip = `${entry.isDirectory ? 'Directory (Git Diff applies to tracked files within)' : 'Resource (Git Diff applies if tracked)'}:\n${getDisplayUri(entry.uriString, 'tooltip')}`;
        this.description = getDisplayUri(entry.uriString, 'treeDescription'); // Show context path as description

        // Set context value for menu filtering
        this.contextValue = entry.isDirectory ? 'resourceDirectory' : 'resourceFile';
        this.iconPath = entry.isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    }

    // Convenience getters
    get sessionId(): string { return this.entry.sessionId; }
    get uriString(): string { return this.entry.uriString; }
    get isDirectory(): boolean { return this.entry.isDirectory; }
} 