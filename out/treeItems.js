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
exports.ResourceItem = exports.SessionItem = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const utils_1 = require("./utils");
class SessionItem extends vscode.TreeItem {
    session;
    constructor(session, collapsibleState = vscode.TreeItemCollapsibleState.Collapsed) {
        super(session.name, collapsibleState);
        this.session = session;
        this.id = session.id; // Use session ID as the tree item ID
        // Set contextValue based on whether session has files to undo
        const hasUndoableFiles = session.storage.hasLastRemovedFiles();
        this.contextValue = hasUndoableFiles ? 'sessionWithUndo' : 'session'; // Used for menu filtering
        this.iconPath = new vscode.ThemeIcon('folder-library'); // Or 'briefcase' or 'database'
        this.tooltip = `Session: ${session.name}`;
        // Show item count in description
        this.description = `(${session.storage.files.length} items)`;
    }
}
exports.SessionItem = SessionItem;
class ResourceItem extends vscode.TreeItem {
    entry;
    constructor(entry, collapsibleState) {
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
        }
        else {
            // Standard file path label
            label = path.basename(uriPath);
        }
        // Fallback for non-file URIs or if basename extraction failed
        if (!label && uri.scheme !== 'file') {
            label = uri.toString().substring(uri.scheme.length + 1); // e.g., untitled:Untitled-1 -> Untitled-1
            if (label.startsWith('//'))
                label = label.substring(2); // Handle authorities like git://
        }
        if (!label)
            label = entry.uriString; // Absolute fallback
        super(label, collapsibleState); // Use the extracted label
        this.entry = entry;
        // Set unique ID combining session and URI
        this.id = `${entry.sessionId}::${entry.uriString}`;
        this.resourceUri = uri; // Make the URI available
        // Command to open non-directory items on click
        if (!entry.isDirectory) {
            this.command = { command: 'vscode.open', title: "Open Resource", arguments: [uri] };
            this.collapsibleState = vscode.TreeItemCollapsibleState.None; // Files are not expandable
        }
        // Set tooltip and description using helper function
        this.tooltip = `${entry.isDirectory ? 'Directory (Git Diff applies to tracked files within)' : 'Resource (Git Diff applies if tracked)'}:\n${(0, utils_1.getDisplayUri)(entry.uriString, 'tooltip')}`;
        this.description = (0, utils_1.getDisplayUri)(entry.uriString, 'treeDescription'); // Show context path as description
        // Set context value for menu filtering
        this.contextValue = entry.isDirectory ? 'resourceDirectory' : 'resourceFile';
        this.iconPath = entry.isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    }
    // Convenience getters
    get sessionId() { return this.entry.sessionId; }
    get uriString() { return this.entry.uriString; }
    get isDirectory() { return this.entry.isDirectory; }
}
exports.ResourceItem = ResourceItem;
//# sourceMappingURL=treeItems.js.map