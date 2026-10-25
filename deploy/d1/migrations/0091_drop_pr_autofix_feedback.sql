-- Pull request feedback autofix went with the GitHub integration: the ledger
-- of feedback deliveries has no reader or writer left.
DROP TABLE IF EXISTS pr_autofix_feedback;
