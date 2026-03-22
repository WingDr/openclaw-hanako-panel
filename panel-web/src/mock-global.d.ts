// Lightweight ambient typing for global mocks to keep TS happy in a scaffold
declare global {
  interface Window {
    __panel_mock?: boolean
  }
}

export {};
