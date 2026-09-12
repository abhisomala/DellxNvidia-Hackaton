import React, { useEffect, useRef, useState } from 'react';

export default function SettingsDialog() {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState('');
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const focusables = () => Array.from(dialog.querySelectorAll('input, button'));
    focusables()[0]?.focus();

    function onKeyDown(event) {
      if (event.key !== 'Tab') return;
      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    dialog.addEventListener('keydown', onKeyDown);
    return () => dialog.removeEventListener('keydown', onKeyDown);
  }, [open]);

  function handleSave(event) {
    event.preventDefault();
    setSaved('Settings saved');
  }

  return (
    <section>
      <h2>Notification settings</h2>
      <button id="open-settings" onClick={() => setOpen(true)}>Settings</button>
      {open && (
        <div className="backdrop" onClick={() => setOpen(false)}>
          <div id="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" ref={dialogRef} onClick={(e) => e.stopPropagation()}>
            <div className="dialog">
              <h2 id="settings-title">Notification settings</h2>
              <form onSubmit={handleSave}>
                <label>
                  Digest email
                  <input id="digest-email" type="email" defaultValue="netid@cornell.edu" />
                </label>
                <label>
                  Reminder hours before deadline
                  <input id="reminder-hours" type="number" defaultValue="24" />
                </label>
                <button id="settings-save" type="submit">Save</button>
                <div id="settings-saved-msg" className="status">{saved}</div>
              </form>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
