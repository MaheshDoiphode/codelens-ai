import * as vscode from "vscode";

const humanRelayCallbacks = new Map<string, (response: string | undefined) => void>();

export const registerHumanRelayCallback = (requestId: string, callback: (response: string | undefined) => void) => {
    humanRelayCallbacks.set(requestId, callback);
};

export const unregisterHumanRelayCallback = (requestId: string) => {
    humanRelayCallbacks.delete(requestId);
};

export const handleHumanRelayResponse = (response: { requestId: string; text?: string; cancelled?: boolean }) => {
    const callback = humanRelayCallbacks.get(response.requestId);

    if (callback) {
        if (response.cancelled) {
            callback(undefined);
        } else {
            callback(response.text);
        }

        humanRelayCallbacks.delete(response.requestId);
    }
};

export class HumanRelayHandler {
    async completePrompt(prompt: string): Promise<string> {
        return new Promise<string>(async (resolve, reject) => {
            await vscode.env.clipboard.writeText(prompt);

            const requestId = Date.now().toString();

            registerHumanRelayCallback(requestId, (response) => {
                if (response) {
                    resolve(response);
                } else {
                    reject(new Error("Human relay operation cancelled"));
                }
            });

            vscode.commands.executeCommand('codelensai.humanRelay', { requestId, promptText: prompt });
        });
    }
}