# Harbor & Pine accessibility demo

This standalone page is a deliberately imperfect small-business demo for accessibility patch-generation work. Open `index.html` in a browser, or serve this directory with any static file server.

## Intentional violations

- **Unnamed button:** `index.html` — the empty `.bag-button` in the site header. Its visible arrow is supplied through CSS, so the button has no accessible name.
- **Unlabeled input:** `index.html` — `#customer-email` in the “Gift concierge” form. It has a placeholder but no associated `<label>` or accessible label.
- **Broken modal keyboard behavior:** `script.js` — the `keydown` listener on `#hours-modal`. When the shop-hours dialog is open, Tab and Shift+Tab always return focus to the close button, so the dialog's link cannot be reached with the keyboard.

The rest of the page includes working in-page navigation, a gift-form submission confirmation, and an open/close shop-hours dialog.

## Intentional visual-only violations (for the vision audit)

axe-core cannot see these; `pipeline/vision_audit.py` (gemma4:26b looking at screenshots) does.

- **Invisible focus:** `styles.css` — `nav a:focus, .section-heading a:focus, .button:focus { outline: none; }` removes the focus ring from the nav links, both `.button`s and "See all provisions" (WCAG 2.4.7).
- **Low contrast on a gradient:** `index.html` / `styles.css` — the `.badge` "Seasonal pick" sits on the sage product gradient in 62%-opacity light text. axe reports it only as *incomplete* (`bgGradient`) (WCAG 1.4.3).
- **Colour-only status:** `index.html` — the `.stock-dot` green/red dots next to each price, with no text or icon (WCAG 1.4.1).
- **Reflow:** `styles.css` — at 680px and below the navigation is `display: none` with no menu button, so at 320px (1280px at 400% zoom) it is gone (WCAG 1.4.10). This one predates the vision work.
