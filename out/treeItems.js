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
        this.id = session.id;
        const hasUndoableFiles = session.storage.hasLastRemovedFiles();
        this.contextValue = hasUndoableFiles ? 'sessionWithUndo' : 'session';
        this.iconPath = new vscode.ThemeIcon('folder-library');
        this.tooltip = `Session: ${session.name}`;
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
        const bangIndex = uri.toString().lastIndexOf('!/');
        if (bangIndex !== -1) {
            const fullUriStr = uri.toString();
            const internalPath = fullUriStr.substring(bangIndex + 1);
            label = path.basename(internalPath.startsWith('/') ? internalPath.substring(1) : internalPath);
        }
        else {
            label = path.basename(uriPath);
        }
        if (!label && uri.scheme !== 'file') {
            label = uri.toString().substring(uri.scheme.length + 1);
            if (label.startsWith('//'))
                label = label.substring(2);
        }
        if (!label)
            label = entry.uriString;
        super(label, collapsibleState);
        this.entry = entry;
        this.id = `${entry.sessionId}::${entry.uriString}`;
        this.resourceUri = uri;
        if (!entry.isDirectory) {
            this.command = { command: 'vscode.open', title: "Open Resource", arguments: [uri] };
            this.collapsibleState = vscode.TreeItemCollapsibleState.None;
        }
        this.tooltip = `${entry.isDirectory ? 'Directory (Git Diff applies to tracked files within)' : 'Resource (Git Diff applies if tracked)'}:\n${(0, utils_1.getDisplayUri)(entry.uriString, 'tooltip')}`;
        this.description = (0, utils_1.getDisplayUri)(entry.uriString, 'treeDescription');
        this.contextValue = entry.isDirectory ? 'resourceDirectory' : 'resourceFile';
        this.iconPath = entry.isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    }
    get sessionId() { return this.entry.sessionId; }
    get uriString() { return this.entry.uriString; }
    get isDirectory() { return this.entry.isDirectory; }
}
exports.ResourceItem = ResourceItem;
//# sourceMappingURL=treeItems.js.map