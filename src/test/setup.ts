// Frontend test setup — runs once per test worker for the `frontend`
// Vitest project (happy-dom env).
//
// Loads jest-dom's matchers (`toBeInTheDocument`, `toHaveTextContent`, …)
// onto Vitest's `expect` so tests under src/**/*.test.{ts,tsx} can use them
// without an explicit import.

import '@testing-library/jest-dom/vitest';
