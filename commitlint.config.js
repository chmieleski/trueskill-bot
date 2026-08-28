export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Allow acronyms in PR titles (WOS, WC3, API, OCR, …).
    'subject-case': [0],
  },
};
