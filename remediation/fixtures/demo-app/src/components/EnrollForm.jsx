import React, { useState } from 'react';

export default function EnrollForm() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('');

  function handleSubmit(event) {
    event.preventDefault();
    setStatus(`Enrolled: ${email}`);
  }

  return (
    <section>
      <h2>Enroll in CS 4780</h2>
      <form id="enroll-form" onSubmit={handleSubmit}>
        <span className="hint">Cornell email</span>
        <input
          id="student-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <button id="enroll-submit" type="submit">Enroll</button>
      </form>
      <div id="enroll-status" className="status">{status}</div>
    </section>
  );
}
