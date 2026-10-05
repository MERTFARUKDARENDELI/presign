/** Scenarios of the controlled demo dApp (shared by the page and the server builder). */
export const DEMO_SCENARIOS = ["safe-transaction", "medium-transaction", "high-transaction", "critical-transaction", "mismatch-transaction", "invalid-transaction", "safe-message", "suspicious-message"] as const;

export type DemoScenario = (typeof DEMO_SCENARIOS)[number];

export const DEMO_SCENARIO_INFO: Record<DemoScenario, { label: string; expectation: string }> = {
  "safe-transaction": { label: "Safe transaction", expectation: "A memo: no significant issue expected." },
  "medium-transaction": { label: "Medium: memo with a lure link", expectation: "Warns; you can continue." },
  "high-transaction": { label: "High: token spending approval", expectation: "Recommends not signing; you can override once, explicitly." },
  "critical-transaction": { label: "Critical: unlimited approval + ownership transfer", expectation: "Strongly recommends not signing; override still possible." },
  "mismatch-transaction": { label: "Says one thing, does another", expectation: "The app declares a tiny swap; the simulation shows more SOL leaving." },
  "invalid-transaction": { label: "Malformed request", expectation: "Cannot be verified: no sign option." },
  "safe-message": { label: "Safe sign-in message", expectation: "Standard sign-in with nonce and expiry." },
  "suspicious-message": { label: "Suspicious message", expectation: "Names another site and mentions your seed phrase." },
};
