-- Existing identities keep the pilot allowlist until an operator changes policy.
-- daily_limit remains a bounded operational quota, independent of recipient policy.
ALTER TABLE mail_sending_configurations ADD COLUMN recipient_policy TEXT NOT NULL DEFAULT 'allowlist' CHECK(recipient_policy IN ('allowlist','external'));
