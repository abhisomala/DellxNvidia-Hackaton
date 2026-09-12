const modal = document.querySelector('#hours-modal');
const closeButton = modal.querySelector('[data-close-modal]');

document.querySelectorAll('[data-open-modal]').forEach((button) => {
  button.addEventListener('click', () => {
    modal.hidden = false;
    closeButton.focus();
  });
});

modal.querySelectorAll('[data-close-modal]').forEach((button) => {
  button.addEventListener('click', () => {
    modal.hidden = true;
  });
});

modal.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') {
    event.preventDefault();
    closeButton.focus();
  }
  if (event.key === 'Escape') modal.hidden = true;
});

document.querySelector('#gift-form').addEventListener('submit', (event) => {
  event.preventDefault();
  document.querySelector('#form-status').textContent = 'Thanks — we’ll be in touch shortly.';
  event.currentTarget.reset();
});
