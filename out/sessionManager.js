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
exports.SessionManager = void 0;
const vscode = __importStar(require("vscode"));
const session_1 = require("./session");
class SessionManager {
    context;
    sessions = new Map();
    static STORAGE_KEY = 'codeLensAiSessions_v3';
    constructor(context) {
        this.context = context;
    }
    /** Creates a new session. */
    createSession(name) {
        const sessionName = name || `Session ${this.sessions.size + 1}`;
        const newSession = new session_1.Session(sessionName);
        this.sessions.set(newSession.id, newSession);
        this.persistSessions();
        return newSession;
    }
    /** Gets a session by its ID. */
    getSession(id) {
        return this.sessions.get(id);
    }
    /** Gets all sessions, sorted alphabetically by name. */
    getAllSessions() {
        return Array.from(this.sessions.values()).sort((a, b) => a.name.localeCompare(b.name));
    }
    /** Removes a session by its ID. */
    removeSession(id) {
        const session = this.sessions.get(id);
        if (session) {
            session.dispose();
            const deleted = this.sessions.delete(id);
            if (deleted) {
                this.persistSessions();
            }
            return deleted;
        }
        return false;
    }
    /** Renames a session. */
    renameSession(id, newName) {
        const session = this.sessions.get(id);
        if (session) {
            session.name = newName;
            this.persistSessions();
            return true;
        }
        return false;
    }
    /** Saves all sessions and their file metadata to workspace state. */
    persistSessions() {
        try {
            const persistedData = this.getAllSessions().map(session => ({
                id: session.id,
                name: session.name,
                files: session.storage.files.map(entry => ({
                    uri: entry.uriString,
                    isDirectory: entry.isDirectory,
                    parentUri: entry.parentUriString,
                }))
            }));
            this.context.workspaceState.update(SessionManager.STORAGE_KEY, persistedData);
            // console.log(`[CodeLensAI:Persist] Saved ${persistedData.length} sessions.`);
        }
        catch (e) {
            console.error("[CodeLensAI:Persist] Error saving session data:", e);
            vscode.window.showErrorMessage("CodeLens AI: Error saving session data.");
        }
    }
    /** Loads sessions from workspace state. */
    loadSessions() {
        this.sessions.clear();
        let loadedData = undefined;
        try {
            // Only try loading from the current CodeLens AI key
            loadedData = this.context.workspaceState.get(SessionManager.STORAGE_KEY);
            if (!loadedData) {
                loadedData = []; // Ensure loadedData is an array if nothing was found
            }
            loadedData.forEach(meta => {
                if (!meta || typeof meta.id !== 'string' || typeof meta.name !== 'string' || !Array.isArray(meta.files)) {
                    console.warn("[CodeLensAI:Load] Skipping invalid session metadata entry:", meta);
                    return;
                }
                const session = new session_1.Session(meta.name, meta.id);
                const restoredFiles = meta.files.map((pf) => {
                    if (!pf || typeof pf.uri !== 'string' || typeof pf.isDirectory !== 'boolean') {
                        console.warn(`[CodeLensAI:Load] Skipping invalid persisted file entry in session ${meta.id}:`, pf);
                        return null;
                    }
                    try {
                        vscode.Uri.parse(pf.uri);
                        if (pf.parentUri)
                            vscode.Uri.parse(pf.parentUri);
                        return { uriString: pf.uri, isDirectory: pf.isDirectory, parentUriString: pf.parentUri, content: null, sessionId: session.id };
                    }
                    catch (e) {
                        console.warn(`[CodeLensAI:Load] Skipping entry with invalid URI in session ${meta.id}:`, pf.uri, e);
                        return null;
                    }
                }).filter((entry) => entry !== null);
                session.storage.restoreFiles(restoredFiles);
                this.sessions.set(session.id, session);
            });
            // console.log(`[CodeLensAI:Load] Loaded ${this.sessions.size} sessions.`);
        }
        catch (e) {
            console.error("[CodeLensAI:Load] Error loading session data:", e);
            this.sessions.clear();
            vscode.window.showErrorMessage("CodeLens AI: Error loading session data. Sessions may be reset.");
        }
        if (this.sessions.size === 0) {
            // console.log("[CodeLensAI:Load] No sessions found or loaded, creating default session.");
            this.createSession("Default Session");
        }
    }
    /** Disposes of all managed sessions. */
    dispose() {
        this.getAllSessions().forEach(s => s.dispose());
        this.sessions.clear();
    }
}
exports.SessionManager = SessionManager;
//# sourceMappingURL=sessionManager.js.map