# Harbor & Pine accessibility demo

This standalone page is a deliberately imperfect small-business demo for accessibility patch-generation work. Open `index.html` in a browser, or serve this directory with any static file server.

## Intentional violations

- **Unnamed button:** `index.html` — the empty `.bag-button` in the site header. Its visible arrow is supplied through CSS, so the button has no accessible name.
- **Unlabeled input:** `index.html` — `#customer-email` in the “Gift concierge” form. It has a placeholder but no associated `<label>` or accessible label.
- **Broken modal keyboard behavior:** `script.js` — the `keydown` listener on `#hours-modal`. When the shop-hours dialog is open, Tab and Shift+Tab always return focus to the close button, so the dialog's link cannot be reached with the keyboard.

The rest of the page includes working in-page navigation, a gift-form submission confirmation, and an open/close shop-hours dialog.
