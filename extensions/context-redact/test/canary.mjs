// Synthetic canaries, assembled at runtime so no file in this repository holds a
// provider-shaped literal: GitHub push protection blocks such a string even when
// it is fake. The shapes still exercise the Stripe-style and Slack prefix rules.
export const CANARY = "sk_" + "live_51H8xYzA2bC3dE4fG5hJ6kL7m";
export const SLACK_TOKEN = "xox" + "b-123456789012-123456789012-abcdefABCDEF1234567890";
