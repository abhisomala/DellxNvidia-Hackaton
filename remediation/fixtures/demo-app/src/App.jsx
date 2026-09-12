import React from 'react';
import UploadButton from './components/UploadButton.jsx';
import EnrollForm from './components/EnrollForm.jsx';
import SettingsDialog from './components/SettingsDialog.jsx';

export default function App() {
  return (
    <main>
      <h1>Cornell Course Portal (staging)</h1>
      <UploadButton />
      <EnrollForm />
      <SettingsDialog />
    </main>
  );
}
