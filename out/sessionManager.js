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
    static STORAGE_KEY = 'fileIntegratorSessions_v3'; // Keep v3 if structure is compatible
    static OLD_STORAGE_KEY_V2 = 'fileIntegratorSessions_v2';
    static OLD_STORAGE_KEY_V1 = 'fileIntegratorSessions';
    constructor(context) {
        this.context = context;
    }
    createSession(name) {
        const sessionName = name || `Session ${this.sessions.size + 1}`;
        const newSession = new session_1.Session(sessionName);
        this.sessions.set(newSession.id, newSession);
        this.persistSessions();
        return newSession;
    }
    getSession(id) {
        return this.sessions.get(id);
    }
    getAllSessions() {
        // Sort alphabetically by name for consistent display
        return Array.from(this.sessions.values()).sort((a, b) => a.name.localeCompare(b.name));
    }
    removeSession(id) {
        const session = this.sessions.get(id);
        if (session) {
            session.dispose(); // Clean up associated resources (like closing doc)
            const deleted = this.sessions.delete(id);
            if (deleted) {
                this.persistSessions();
            }
            return deleted;
        }
        return false;
    }
    renameSession(id, newName) {
        const session = this.sessions.get(id);
        if (session) {
            session.name = newName;
            this.persistSessions();
            return true;
        }
        return false;
    }
    /** Saves all sessions and their file metadata (URIs, hierarchy) to workspace state. */
    persistSessions() {
        try {
            const persistedData = this.getAllSessions().map(session => ({
                id: session.id,
                name: session.name,
                files: session.storage.files.map(entry => ({
                    uri: entry.uriString,
                    isDirectory: entry.isDirectory,
                    parentUri: entry.parentUriString, // Make sure parentUriString is saved
                }))
            }));
            // Save to V3 key, clear older keys
            this.context.workspaceState.update(SessionManager.STORAGE_KEY, persistedData);
            this.context.workspaceState.update(SessionManager.OLD_STORAGE_KEY_V2, undefined);
            this.context.workspaceState.update(SessionManager.OLD_STORAGE_KEY_V1, undefined);
            console.log(`[Persist] Saved ${persistedData.length} sessions.`);
        }
        catch (e) {
            console.error("[Persist] Error saving session data:", e);
            vscode.window.showErrorMessage("Error saving File Integrator session data.");
        }
    }
    /** Loads sessions from workspace state, handling migration from older formats. */
    loadSessions() {
        this.sessions.clear();
        let loadedData = undefined;
        let loadedFromOldKey = false;
        try {
            // Try loading from the current key first
            loadedData = this.context.workspaceState.get(SessionManager.STORAGE_KEY);
            // Migration from V2 (path-based) if V3 data not found
            if (!loadedData) {
                const oldDataV2 = this.context.workspaceState.get(SessionManager.OLD_STORAGE_KEY_V2); // Type might be slightly different
                if (oldDataV2 && oldDataV2.length > 0) {
                    console.log("[Load] Migrating data from V2 storage key (path -> uri).");
                    // Convert V2 structure (assuming {id, name, files: [{path, isDirectory, parent}]}) to V3
                    loadedData = oldDataV2.map(metaV2 => ({
                        id: metaV2.id, name: metaV2.name,
                        files: (metaV2.files || []).map((pfV2) => {
                            if (!pfV2 || typeof pfV2.path !== 'string')
                                return null; // Basic validation
                            try {
                                const fileUri = vscode.Uri.file(pfV2.path);
                                const parentUri = pfV2.parent ? vscode.Uri.file(pfV2.parent) : undefined;
                                return { uri: fileUri.toString(), isDirectory: !!pfV2.isDirectory, parentUri: parentUri?.toString() };
                            }
                            catch (e) {
                                console.warn(`[Load Migration V2] Error converting path ${pfV2.path} to URI:`, e);
                                return null;
                            }
                        }).filter((pf) => pf !== null)
                    }));
                    loadedFromOldKey = true;
                }
            }
            // Migration from V1 (only session names/ids) if V2/V3 data not found
            if (!loadedData) {
                const oldDataV1 = this.context.workspaceState.get(SessionManager.OLD_STORAGE_KEY_V1);
                if (oldDataV1 && oldDataV1.length > 0) {
                    console.log("[Load] Migrating data from V1 storage key (basic).");
                    loadedData = oldDataV1.map(metaV1 => ({ id: metaV1.id, name: metaV1.name, files: [] })); // Create sessions with empty file lists
                    loadedFromOldKey = true;
                }
                else {
                    loadedData = []; // Ensure loadedData is an array if nothing was found
                }
            }
            // Process loaded/migrated data (now assumed to be in PersistedSession[] format)
            loadedData.forEach(meta => {
                // Validate basic structure
                if (!meta || typeof meta.id !== 'string' || typeof meta.name !== 'string' || !Array.isArray(meta.files)) {
                    console.warn("[Load] Skipping invalid session metadata entry:", meta);
                    return;
                }
                const session = new session_1.Session(meta.name, meta.id);
                // Restore files from persisted data
                const restoredFiles = meta.files.map((pf) => {
                    // Validate each persisted file entry
                    if (!pf || typeof pf.uri !== 'string' || typeof pf.isDirectory !== 'boolean') {
                        console.warn(`[Load] Skipping invalid persisted file entry in session ${meta.id}:`, pf);
                        return null;
                    }
                    // Validate URIs can be parsed
                    try {
                        vscode.Uri.parse(pf.uri); // Check main URI
                        if (pf.parentUri)
                            vscode.Uri.parse(pf.parentUri); // Check parent URI if exists
                        // Create the internal FileEntry object (content is null initially)
                        return { uriString: pf.uri, isDirectory: pf.isDirectory, parentUriString: pf.parentUri, content: null, sessionId: session.id };
                    }
                    catch (e) {
                        console.warn(`[Load] Skipping entry with invalid URI in session ${meta.id}:`, pf.uri, e);
                        return null;
                    }
                }).filter((entry) => entry !== null); // Filter out nulls and type guard
                session.storage.restoreFiles(restoredFiles);
                this.sessions.set(session.id, session);
            });
            console.log(`[Load] Loaded ${this.sessions.size} sessions.`);
            // If migrated from an old key, save immediately in the new format
            if (loadedFromOldKey) {
                console.log("[Load] Data migrated from older version, persisting in new format.");
                this.persistSessions();
            }
        }
        catch (e) {
            console.error("[Load] Error loading session data:", e);
            this.sessions.clear(); // Clear potentially corrupted data
            vscode.window.showErrorMessage("Error loading File Integrator session data. Sessions may be reset.");
        }
        // Ensure there's always at least one session
        if (this.sessions.size === 0) {
            console.log("[Load] No sessions found or loaded, creating default session.");
            this.createSession("Default Session"); // Don't persist here, createSession already does
        }
    }
    dispose() {
        this.getAllSessions().forEach(s => s.dispose());
        this.sessions.clear();
    }
}
exports.SessionManager = SessionManager;
//# sourceMappingURL=sessionManager.js.map