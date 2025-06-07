import type { WebviewApi } from "vscode-webview";

interface VsCodeApi {
  postMessage(message: any): void;
}

let vsCodeApi: VsCodeApi;

try {
  vsCodeApi = acquireVsCodeApi();
} catch (e) {
  console.error("Failed to acquire VsCodeApi", e);
  vsCodeApi = {
    postMessage: (message: any) => {
      console.log("Message to VS Code:", message);
    },
  };
}

export const vscode = vsCodeApi;