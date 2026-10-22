import assert from "node:assert/strict";
import test from "node:test";

import { detectorsFor, scrub } from "./detection/scrub.ts";
import { CANARY, SLACK_TOKEN } from "./test/canary.mjs";

const SALT = "test-salt-0123456789abcdef";

function scan(text, options = {}) {
	return scrub(text, { salt: SALT, tier: "balanced", ...options });
}

function labels(text, options = {}) {
	return scan(text, options).hits.map((hit) => hit.label);
}

test("a vendor key with no checksum shape is caught by its rule", () => {
	const stripe = `STRIPE_KEY=${CANARY}`;
	const slack = `token ${SLACK_TOKEN}`;
	assert.ok(labels(stripe).includes("GENERIC_API_KEY"), "the Stripe-style key was not caught");
	assert.ok(labels(slack).includes("SLACK_BOT_TOKEN"), "the Slack token was not caught");
	assert.ok(!scan(stripe).text.includes(CANARY), "the Stripe key survived");
});

test("benign high-entropy shapes are left untouched", () => {
	const benign = [
		"3f786850e387550fdab836ed7e6dc881de23001b",
		"550e8400-e29b-41d4-a716-446655440000",
		"01ARZ3NDEKTSV4RRFFQ69G5FAV",
		"arn:aws:s3:::my-bucket/object.gz",
		"ops@example.com",
		"v2.14.3",
		"sha512-K3f8Qp2xLmN0aB7cD1eF4gH6jK8mP9rS2tU5vW7xY0zA1bC3dE5fG7hI9jK1lM2nO4pQ6rS8tU0vW2xY4z",
		"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl user@host",
	];
	for (const value of benign) {
		const result = scan(`plain ${value} here`);
		assert.equal(result.hits.length, 0, `${value} was redacted: ${result.hits.map((h) => h.label).join(",")}`);
		assert.equal(result.text, `plain ${value} here`);
	}
});

test("tiers move the generic family's threshold", () => {
	// Same value, two contexts: the damp-word-heavy one only clears strict, the
	// lighter one clears balanced, and neither clears precision's 0.6 bar.
	const heavilyDamped = "example sample dummy fixture mock api_token = k9f3c9a2b7d1e4f6";
	const lightlyDamped = "example sample api_token = k9f3c9a2b7d1e4f6";
	assert.ok(labels(heavilyDamped, { tier: "strict" }).includes("GENERIC_API_KEY"));
	assert.deepEqual(labels(heavilyDamped, { tier: "balanced" }), []);
	assert.ok(labels(lightlyDamped, { tier: "balanced" }).includes("GENERIC_API_KEY"));
	assert.deepEqual(labels(lightlyDamped, { tier: "precision" }), []);
});

test("minEntropy reaches the generic rule it names, both directions", () => {
	const value = "api_key = byh0vmpo7yt8r6";
	assert.deepEqual(labels(value, { minEntropy: 4.0 }), []);
	assert.ok(labels(value, { minEntropy: 3.2 }).includes("GENERIC_API_KEY"));
	assert.ok(labels(value, { minEntropy: 2.0 }).includes("GENERIC_API_KEY"));
});

test("detectorsFor reports the corpus the row will actually run", () => {
	assert.match(detectorsFor(1_000), /220-rule corpus/);
	assert.match(detectorsFor(120_000), /over the 60000 full-scan limit/);
});
