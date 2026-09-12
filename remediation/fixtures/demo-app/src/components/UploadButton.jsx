import React, { useState } from 'react';

export default function UploadButton() {
  const [status, setStatus] = useState('');

  function handleUpload() {
    setStatus('Assignment uploaded');
  }

  return (
    <section>
      <h2>Assignment 3</h2>
      <p>Upload your submission before Friday 11:59pm.</p>
      <button id="upload-submit" className="icon-btn" onClick={handleUpload}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 16V4m0 0l-4 4m4-4l4 4M4 20h16" />
        </svg>
      </button>
      <div id="upload-status" className="status">{status}</div>
    </section>
  );
}
