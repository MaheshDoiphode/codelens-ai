import * as vscode from 'vscode';
import * as path from 'path';
import { handleHumanRelayResponse } from './humanRelay';
import { Session } from './session';

export class HumanRelayViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'codelensai.humanRelayView';

    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _session: Session,
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'webview-ui', 'dist')]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'humanRelayResponse':
                    {
                        handleHumanRelayResponse({ requestId: data.requestId, text: data.text });
                        break;
                    }
                case 'humanRelayCancel':
                    {
                        handleHumanRelayResponse({ requestId: data.requestId, cancelled: true });
                        break;
                    }
            }
        });
    }

    public async show(prompt: string) {
        if (this._view) {
            this._view.show?.(true);
            this._view.webview.postMessage({ type: 'showHumanRelayDialog', promptText: prompt });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview-ui', 'dist', 'bundle.js'));

        const nonce = getNonce();

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Human Relay</title>
            </head>
            <body>
                <div id="root"></div>
                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}