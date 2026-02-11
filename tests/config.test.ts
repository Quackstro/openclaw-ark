/**
 * Ark config parsing tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, CATEGORIES } from "../dist/src/config.js";

describe("parseConfig", () => {
  it("returns defaults for empty object", () => {
    const cfg = parseConfig({});
    assert.ok(cfg.backupDir.endsWith(".openclaw/backups"));
    assert.equal(cfg.retention.maxBackups, 5);
    assert.equal(cfg.retention.maxAgeDays, 30);
    assert.equal(cfg.notifications.enabled, true);
    assert.equal(cfg.notifications.channel, "telegram");
  });

  it("all categories enabled by default", () => {
    const cfg = parseConfig({});
    for (const cat of CATEGORIES) {
      assert.equal(cfg.categories[cat.id], true, `${cat.id} should be enabled`);
    }
  });

  it("respects disabled categories", () => {
    const cfg = parseConfig({ categories: { wallet: false, brain: false } });
    assert.equal(cfg.categories.wallet, false);
    assert.equal(cfg.categories.brain, false);
    assert.equal(cfg.categories.config, true);
  });

  it("overrides backupDir", () => {
    const cfg = parseConfig({ backupDir: "/tmp/backups" });
    assert.equal(cfg.backupDir, "/tmp/backups");
  });

  it("expands tilde in backupDir", () => {
    const cfg = parseConfig({ backupDir: "~/my-backups" });
    assert.ok(!cfg.backupDir.startsWith("~"));
    assert.ok(cfg.backupDir.endsWith("my-backups"));
  });

  it("overrides retention settings", () => {
    const cfg = parseConfig({ retention: { maxBackups: 10, maxAgeDays: 7 } });
    assert.equal(cfg.retention.maxBackups, 10);
    assert.equal(cfg.retention.maxAgeDays, 7);
  });

  it("overrides notification settings", () => {
    const cfg = parseConfig({ notifications: { enabled: false, target: "12345" } });
    assert.equal(cfg.notifications.enabled, false);
    assert.equal(cfg.notifications.target, "12345");
    assert.equal(cfg.notifications.channel, "telegram"); // default preserved
  });

  it("has exactly 10 categories defined", () => {
    assert.equal(CATEGORIES.length, 10);
  });

  it("each category has required fields", () => {
    for (const cat of CATEGORIES) {
      assert.ok(cat.id, `category missing id`);
      assert.ok(cat.label, `${cat.id} missing label`);
      assert.equal(typeof cat.sensitive, "boolean", `${cat.id} missing sensitive flag`);
      assert.equal(typeof cat.paths, "function", `${cat.id} missing paths function`);
    }
  });

  it("sensitive categories are config, credentials, wallet", () => {
    const sensitive = CATEGORIES.filter((c) => c.sensitive).map((c) => c.id);
    assert.deepEqual(sensitive.sort(), ["config", "credentials", "wallet"]);
  });
});
