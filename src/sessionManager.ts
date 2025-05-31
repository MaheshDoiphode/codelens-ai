import * as vscode from 'vscode';
import { Session, FileEntry, PersistedSession, PersistedFileEntry } from './session';

export class SessionManager {
    private sessions: Map<string, Session> = new Map();
    private static readonly STORAGE_KEY = 'codeLensAiSessions_v3';

    constructor(private context: vscode.ExtensionContext) { }

    /** Creates a new session. */
    createSession(name?: string): Session {
        const sessionName = name || `Session ${this.sessions.size + 1}`;
        const newSession = new Session(sessionName);
        this.sessions.set(newSession.id, newSession);
        this.persistSessions();
        return newSession;
    }

    /** Gets a session by its ID. */
    getSession(id: string): Session | undefined {
        return this.sessions.get(id);
    }

    /** Gets all sessions, sorted alphabetically by name. */
    getAllSessions(): Session[] {
        return Array.from(this.sessions.values()).sort((a, b) => a.name.localeCompare(b.name));
    }

    /** Removes a session by its ID. */
    removeSession(id: string): boolean {
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
    renameSession(id: string, newName: string): boolean {
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
            const persistedData: PersistedSession[] = this.getAllSessions().map(session => ({
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
        } catch (e) {
            console.error("[CodeLensAI:Persist] Error saving session data:", e);
            vscode.window.showErrorMessage("CodeLens AI: Error saving session data.");
        }
    }

    /** Loads sessions from workspace state. */
    loadSessions() {
        this.sessions.clear();
        let loadedData: PersistedSession[] | undefined = undefined;

        try {
            // Only try loading from the current CodeLens AI key
            loadedData = this.context.workspaceState.get<PersistedSession[]>(SessionManager.STORAGE_KEY);

            if (!loadedData) {
                loadedData = []; // Ensure loadedData is an array if nothing was found
            }

            (loadedData as PersistedSession[]).forEach(meta => {
                if (!meta || typeof meta.id !== 'string' || typeof meta.name !== 'string' || !Array.isArray(meta.files)) {
                    console.warn("[CodeLensAI:Load] Skipping invalid session metadata entry:", meta); return;
                }
                const session = new Session(meta.name, meta.id);
                const restoredFiles: FileEntry[] = meta.files.map((pf): FileEntry | null => {
                    if (!pf || typeof pf.uri !== 'string' || typeof pf.isDirectory !== 'boolean') {
                        console.warn(`[CodeLensAI:Load] Skipping invalid persisted file entry in session ${meta.id}:`, pf); return null;
                    }
                    try {
                        vscode.Uri.parse(pf.uri);
                        if (pf.parentUri) vscode.Uri.parse(pf.parentUri);
                        return { uriString: pf.uri, isDirectory: pf.isDirectory, parentUriString: pf.parentUri, content: null, sessionId: session.id };
                    } catch (e) { console.warn(`[CodeLensAI:Load] Skipping entry with invalid URI in session ${meta.id}:`, pf.uri, e); return null; }
                }).filter((entry): entry is FileEntry => entry !== null);
                session.storage.restoreFiles(restoredFiles);
                this.sessions.set(session.id, session);
            });

            // console.log(`[CodeLensAI:Load] Loaded ${this.sessions.size} sessions.`);

        } catch (e) {
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