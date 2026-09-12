const modal = document.querySelector('#hours-modal');
const closeButton = modal.querySelector('.modal-close');
let lastTrigger = null;

function openModal(trigger) {
  lastTrigger = trigger;
  modal.hidden = false;
  closeButton.focus();
}

function closeModal() {
  modal.hidden = true;
  if (lastTrigger) lastTrigger.focus();
}

document.querySelectorAll('[data-open-modal]').forEach((button) => {
  button.addEventListener('click', () => openModal(button));
});

modal.querySelectorAll('[data-close-modal]').forEach((control) => {
  control.addEventListener('click', () => {
    modal.hidden = true;
    // "Get directions" navigates to #visit; only the Close button returns focus.
    if (control === closeButton && lastTrigger) lastTrigger.focus();
  });
});

modal.addEventListener('click', (event) => {
  if (event.target === modal) closeModal();
});

modal.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeModal();
    return;
  }
  if (event.key !== 'Tab') return;

  const focusable = [...modal.querySelectorAll('a[href], button:not([disabled])')];
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

document.querySelector('#gift-form').addEventListener('submit', (event) => {
  event.preventDefault();
  document.querySelector('#form-status').textContent = 'Thanks — we’ll be in touch shortly.';
  event.currentTarget.reset();
});
