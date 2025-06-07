import React, { useState, useEffect } from 'react';
import { vscode } from '../utils/vscode';

const HumanRelayView: React.FC = () => {
  const [prompt, setPrompt] = useState('');
  const [response, setResponse] = useState('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === 'showHumanRelayDialog') {
        setPrompt(message.promptText);
        setIsDialogOpen(true);
      }
    };

    window.addEventListener('message', handleMessage);

    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, []);

  const handleCopy = () => {
    navigator.clipboard.writeText(prompt);
  };

  const handleSubmit = () => {
    vscode.postMessage({
      type: 'humanRelayResponse',
      text: response,
    });
    setIsDialogOpen(false);
  };

  const handleCancel = () => {
    vscode.postMessage({
      type: 'humanRelayCancel',
    });
    setIsDialogOpen(false);
  };

  if (!isDialogOpen) {
    return null;
  }

  return (
    <div className="human-relay-dialog">
      <h2>Human Relay</h2>
      <p>Copy the following prompt and paste it into the AI, then paste the AI's response below.</p>
      <textarea value={prompt} readOnly />
      <button onClick={handleCopy}>Copy Prompt</button>
      <textarea
        value={response}
        onChange={(e) => setResponse(e.target.value)}
        placeholder="Paste the AI's response here..."
      />
      <button onClick={handleSubmit}>Submit</button>
      <button onClick={handleCancel}>Cancel</button>
    </div>
  );
};

export default HumanRelayView;